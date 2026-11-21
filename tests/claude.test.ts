import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { ClaudeAdapter, costGbp, parseReply, toClaudeMessages } from '../packages/adapters/src/index.js';
import type { Message } from '../packages/orchestrator/src/index.js';
import { Ledger, weekStart } from '../apps/server/src/ledger.js';

const KEY = 'chiave-finta-di-prova-123';

interface Seen {
  headers: IncomingMessage['headers'];
  body: { model: string; max_tokens: number; system: string; messages: { role: string; content: string }[] };
}

function fakeApi(status: number, payload: unknown): Promise<{ server: Server; url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      seen.push({ headers: req.headers, body: JSON.parse(raw) as Seen['body'] });
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen })),
  );
}

const msg = (id: number, from: Message['from'], text: string, kind: Message['kind'] = 'message', to: Message['to'] = ['claude']): Message => ({
  id,
  from,
  to,
  text,
  kind,
});

describe('protocollo di risposta', () => {
  it('separa testo e righe di servizio', () => {
    const r = parseReply('Penso sia meglio SQLite.\nTAG: disaccordo\nCHIEDI_UTENTE: Quanto spendi?\nCONCLUSO');
    assert.equal(r.text, 'Penso sia meglio SQLite.');
    assert.equal(r.tag, 'disaccordo');
    assert.equal(r.needsUser, 'Quanto spendi?');
    assert.equal(r.done, true);
  });
  it('lascia intatto un testo senza righe di servizio', () => {
    const r = parseReply('Solo testo.');
    assert.deepEqual(r, { text: 'Solo testo.' });
  });
});

describe('messaggi verso l\'API', () => {
  it('alterna i ruoli, parte e finisce da "user"', () => {
    const history: Message[] = [
      msg(1, 'user', 'Obiettivo', 'message', ['claude', 'chatgpt']),
      msg(2, 'claude', 'Mia proposta', 'message', ['user', 'chatgpt']),
      msg(3, 'claude', 'Chiedo all\'utente', 'decision_request', ['user']),
      msg(4, 'chatgpt', 'Obiezione', 'message', ['user', 'claude']),
      msg(5, 'system', 'nota interna', 'system', ['user']),
      msg(6, 'user', 'Rispondo io', 'decision_answer', ['claude', 'chatgpt']),
    ];
    const out = toClaudeMessages(history);
    assert.deepEqual(out.map((m) => m.role), ['user', 'assistant', 'user']);
    assert.match(out[0]?.content ?? '', /\[Utente\] Obiettivo/);
    assert.match(out[2]?.content ?? '', /\[ChatGPT\] Obiezione/);
    assert.match(out[2]?.content ?? '', /\[Utente, decisione\] Rispondo io/);
    assert.ok(!out.some((m) => m.content.includes('nota interna')));
  });
  it('aggiunge "Continua." se l\'ultimo messaggio è di Claude', () => {
    const out = toClaudeMessages([msg(1, 'user', 'x', 'message', ['claude']), msg(2, 'claude', 'y')]);
    assert.equal(out.at(-1)?.role, 'user');
  });
});

describe('adattatore Claude con server finto', () => {
  const servers: Server[] = [];
  after(() => servers.forEach((s) => s.close()));

  it('invia la richiesta giusta, legge testo, tag e costo', async () => {
    const api = await fakeApi(200, {
      content: [{ type: 'text', text: 'Concordo con te.\nTAG: accordo\nCONCLUSO' }],
      usage: { input_tokens: 1000, output_tokens: 200 },
    });
    servers.push(api.server);
    const claude = new ClaudeAdapter({ apiKey: KEY, baseUrl: api.url, usdToGbp: 0.8 });
    const reply = await claude.reply({ goal: 'Obiettivo di prova', history: [msg(1, 'user', 'Ciao')] });

    assert.equal(reply.text, 'Concordo con te.');
    assert.equal(reply.tag, 'accordo');
    assert.equal(reply.done, true);
    // (1000*2 + 200*10) / 1e6 dollari = 0.004; per 0.8 = 0.0032 sterline
    assert.ok(Math.abs((reply.costGbp ?? 0) - 0.0032) < 1e-9);

    const seen = api.seen[0] as Seen;
    assert.equal(seen.headers['x-api-key'], KEY);
    assert.equal(seen.headers['anthropic-version'], '2023-06-01');
    assert.equal(seen.body.model, 'claude-sonnet-5-5');
    assert.match(seen.body.system, /Obiettivo di prova/);
  });

  it('un errore HTTP non rivela la chiave', async () => {
    const api = await fakeApi(401, { error: { message: `chiave ${KEY} non valida` } });
    servers.push(api.server);
    const claude = new ClaudeAdapter({ apiKey: KEY, baseUrl: api.url });
    await assert.rejects(
      () => claude.reply({ goal: 'x', history: [msg(1, 'user', 'Ciao')] }),
      (e: Error) => /HTTP 401/.test(e.message) && !e.message.includes(KEY),
    );
  });

  it('rifiuta di partire senza chiave', () => {
    assert.throws(() => new ClaudeAdapter({ apiKey: '' }));
  });
});

describe('costo', () => {
  it('un modello sconosciuto usa il prezzo più alto', () => {
    assert.ok(costGbp('modello-nuovo', 1000, 1000, 1) > costGbp('claude-sonnet-5-5', 1000, 1000, 1));
  });
});

describe('registro della spesa settimanale', () => {
  it('weekStart: la settimana parte il lunedì', () => {
    assert.equal(weekStart(new Date(2026, 10, 21, 12)), '2026-11-16'); // sabato
    assert.equal(weekStart(new Date(2026, 10, 22, 23)), '2026-11-16'); // domenica
    assert.equal(weekStart(new Date(2026, 10, 23, 0, 5)), '2026-11-23'); // lunedì
  });

  it('somma nella settimana e si azzera il lunedì', () => {
    const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), 'ledger-')), 'ledger.json'));
    const sat = new Date(2026, 10, 21, 12);
    assert.equal(ledger.spent(sat), 0);
    ledger.add(1.5, sat);
    assert.equal(ledger.add(0.5, sat), 2);
    assert.equal(ledger.spent(new Date(2026, 10, 22, 9)), 2);
    assert.equal(ledger.spent(new Date(2026, 10, 23, 9)), 0);
  });
});
