import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, describe, it } from 'node:test';
import { ChatGPTAdapter, toRoleMessages } from '../packages/adapters/src/index.js';
import type { Message } from '../packages/orchestrator/src/index.js';

const TOKEN = 'token-finto-di-prova-456';
const servers: Server[] = [];
after(() => servers.forEach((s) => s.close()));

interface Seen {
  headers: IncomingMessage['headers'];
  body: Record<string, unknown>;
}

function fakeApi(status: number, sse: string): Promise<{ url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      seen.push({ headers: req.headers, body: JSON.parse(raw) as Record<string, unknown> });
      res.writeHead(status, { 'content-type': status === 200 ? 'text/event-stream' : 'application/json' });
      res.end(sse);
    });
  });
  servers.push(server);
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen })));
}

const ev = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
const msg = (id: number, from: Message['from'], text: string): Message => ({ id, from, to: ['chatgpt'], text, kind: 'message' });

describe('ChatGPTAdapter', () => {
  it('invia la richiesta nel formato dell\'anteprima e ricompone il testo', async () => {
    const api = await fakeApi(
      200,
      ev({ type: 'response.output_text.delta', delta: 'Ciao ' }) +
        ev({ type: 'response.output_text.delta', delta: 'a tutti.\nTAG: accordo' }) +
        ev({ type: 'response.completed' }),
    );
    const a = new ChatGPTAdapter({ getAccessToken: async () => TOKEN, model: 'm1', baseUrl: api.url });
    const r = await a.reply({ goal: 'Obiettivo', history: [msg(1, 'user', 'Obiettivo'), msg(2, 'claude', 'Proposta')] });
    assert.equal(r.tag, 'accordo');
    assert.match(r.text, /Ciao a tutti/);
    assert.equal(r.costGbp, 0);
    const s = api.seen[0]!;
    assert.equal(s.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(s.body.store, false);
    assert.equal(s.body.stream, true);
    assert.equal(s.body.model, 'm1');
    assert.equal('temperature' in s.body, false);
    assert.equal('max_output_tokens' in s.body, false);
    assert.equal(typeof s.body.instructions, 'string');
    const input = s.body.input as { role: string }[];
    assert.ok(input.every((m) => m.role === 'user' || m.role === 'assistant'));
  });

  it('errore HTTP: messaggio con stato e codice, senza token', async () => {
    const api = await fakeApi(429, JSON.stringify({ error: { code: 'subscription_sharing_usage_limit_exceeded' } }));
    const a = new ChatGPTAdapter({ getAccessToken: async () => TOKEN, model: 'm1', baseUrl: api.url });
    await assert.rejects(a.reply({ goal: 'g', history: [] }), (e: Error) => {
      assert.match(e.message, /429/);
      assert.match(e.message, /subscription_sharing_usage_limit_exceeded/);
      assert.equal(e.message.includes(TOKEN), false);
      return true;
    });
  });

  it('response.failed e flusso interrotto diventano errori', async () => {
    const failed = await fakeApi(200, ev({ type: 'response.failed', response: { error: { code: 'usage_unavailable' } } }));
    const a = new ChatGPTAdapter({ getAccessToken: async () => TOKEN, model: 'm', baseUrl: failed.url });
    await assert.rejects(a.reply({ goal: 'g', history: [] }), /usage_unavailable/);
    const cut = await fakeApi(200, ev({ type: 'response.output_text.delta', delta: 'x' }));
    const b = new ChatGPTAdapter({ getAccessToken: async () => TOKEN, model: 'm', baseUrl: cut.url });
    await assert.rejects(b.reply({ goal: 'g', history: [] }), /interrotta/);
  });

  it('toRoleMessages alterna i ruoli e parte/finisce da user', () => {
    const out = toRoleMessages([msg(1, 'claude', 'a'), msg(2, 'chatgpt', 'b')], 'chatgpt');
    assert.equal(out[0]?.role, 'user');
    assert.equal(out[out.length - 1]?.role, 'user');
    for (let i = 1; i < out.length; i++) assert.notEqual(out[i]?.role, out[i - 1]?.role);
  });
});
