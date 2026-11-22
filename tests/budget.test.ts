import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { ClaudeAdapter, costGbp, ScriptedAdapter } from '../packages/adapters/src/index.js';
import { notBilled, Orchestrator, type Adapter, type AdapterInput, type AdapterReply } from '../packages/orchestrator/src/index.js';
import { Budget } from '../apps/server/src/budget.js';

const tmp = () => join(mkdtempSync(join(tmpdir(), 'aibbud-')), 'db.sqlite');
const say = (text: string, extra: Partial<AdapterReply> = {}): AdapterReply => ({ text, ...extra });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Adattatore che costa sempre `cost`, riserva `max`, e risponde dopo `ms` (rispettando STOP solo se obey). */
function slow(id: 'claude' | 'chatgpt', o: { ms: number; max: number; cost: number; obey?: boolean; text?: string }): Adapter {
  return {
    id,
    estimateMaxCostGbp: () => o.max,
    async reply(input: AdapterInput): Promise<AdapterReply> {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, o.ms);
        if (o.obey !== false) {
          input.signal?.addEventListener('abort', () => {
            clearTimeout(t);
            reject(new DOMException('Annullata', 'AbortError'));
          });
        }
      });
      return say(o.text ?? `risposta di ${id} costo ${o.cost}`, { costGbp: o.cost });
    },
  };
}
const quiet = (id: 'claude' | 'chatgpt'): Adapter => new ScriptedAdapter(id, [say('ok aaa bbb', { done: true })]);

describe('registro della spesa (SQLite)', () => {
  it('la prenotazione è atomica anche con due connessioni allo stesso archivio', () => {
    const file = tmp();
    const a = new Budget(new DatabaseSync(file), 0.05);
    const b = new Budget(new DatabaseSync(file), 0.05);
    const r1 = a.reserve(0.03);
    const r2 = b.reserve(0.03); // vedrebbe 0 se leggesse solo la spesa registrata
    assert.ok(r1);
    assert.equal(r2, undefined);
    r1.settle(0.01); // il costo reale è minore: si libera spazio
    assert.ok(b.reserve(0.03));
    assert.ok(Math.abs(a.weeklySpentGbp() - 0.04) < 1e-9);
  });

  it('release libera la prenotazione, settle la trasforma in spesa, la settimana riparte il lunedì', () => {
    let day = new Date(2026, 10, 22, 12); // domenica 22-11-2026
    const b = new Budget(new DatabaseSync(':memory:'), 5, () => day);
    b.reserve(1)?.release();
    assert.equal(b.weeklySpentGbp(), 0);
    b.reserve(2)?.settle(1.5);
    assert.equal(b.weeklySpentGbp(), 1.5);
    day = new Date(2026, 10, 23, 9); // lunedì
    assert.equal(b.weeklySpentGbp(), 0);
  });

  it('le prenotazioni rimaste aperte dopo un crash contano come spese; il vecchio ledger.json si importa una volta', () => {
    const file = tmp();
    const db = new DatabaseSync(file);
    const b = new Budget(db, 5);
    b.reserve(0.4);
    assert.equal(new Budget(new DatabaseSync(file), 5).settleOrphans(), 1);
    assert.ok(Math.abs(b.weeklySpentGbp() - 0.4) < 1e-9);
    const ledger = join(mkdtempSync(join(tmpdir(), 'aibled-')), 'ledger.json');
    const monday = new Date();
    const d = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate());
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    writeFileSync(ledger, JSON.stringify({ weekStart: iso, spentGbp: 0.25 }));
    b.importLegacy(ledger);
    b.importLegacy(ledger);
    assert.ok(Math.abs(b.weeklySpentGbp() - 0.65) < 1e-9);
  });

  it('la stima di Claude non è mai sotto il costo reale possibile', async () => {
    const history = [{ id: 1, from: 'user' as const, to: ['claude' as const], text: 'Parlami di database '.repeat(200), kind: 'message' as const }];
    const adapter = new ClaudeAdapter({
      apiKey: 'x',
      maxTokens: 400,
      fetchImpl: (async () =>
        new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: Math.ceil((history[0]!.text.length + 700) / 3), output_tokens: 400 } }))) as typeof fetch,
    });
    const estimate = adapter.estimateMaxCostGbp({ goal: 'x', history });
    const real = (await adapter.reply({ goal: 'x', history })).costGbp ?? 0;
    assert.ok(estimate >= real, `stima ${estimate} < reale ${real}`);
    assert.ok(estimate >= costGbp('claude-sonnet-5-5', 0, 400, 0.8));
  });
});

describe('coordinatore con budget condiviso', () => {
  it('due discussioni contemporanee vicino a £5: ne passa una sola, il totale non supera il tetto', async () => {
    const b = new Budget(new DatabaseSync(':memory:'), 5);
    b.record(4.97, 'già speso');
    const make = () =>
      new Orchestrator(
        { claude: slow('claude', { ms: 40, max: 0.02, cost: 0.02, text: 'turno aaa bbb' }), chatgpt: quiet('chatgpt') },
        { maxTurns: 2, weeklyBudgetGbp: 5, budget: b.gate() },
      );
    const one = make();
    const two = make();
    one.start('x');
    two.start('x');
    await Promise.all([one.run(), two.run()]);
    const refused = [one, two].filter((o) => o.stopReason === 'tetto_spesa');
    assert.equal(refused.length, 1);
    assert.equal(refused[0]?.turnsDone, 0);
    assert.ok(b.weeklySpentGbp() <= 5 + 1e-9, `impegnato ${b.weeklySpentGbp()}`);
  });

  it('la spesa della discussione è distinta dal totale settimanale', async () => {
    const b = new Budget(new DatabaseSync(':memory:'), 5);
    b.record(1.2, 'già speso');
    const o = new Orchestrator(
      { claude: slow('claude', { ms: 1, max: 0.05, cost: 0.03, text: 'uno aaa bbb' }), chatgpt: quiet('chatgpt') },
      { maxTurns: 1, weeklyBudgetGbp: 5, budget: b.gate() },
    );
    o.start('x');
    await o.run();
    assert.ok(Math.abs(o.spentGbp - 0.03) < 1e-9);
    assert.ok(Math.abs(o.weeklySpentGbp - 1.23) < 1e-9);
    assert.ok(Math.abs(o.report().spesaGbp - 0.03) < 1e-9);
  });

  it('STOP durante una chiamata: ferma subito, annulla la richiesta, non riavvia nulla, conta il costo prudente', async () => {
    const b = new Budget(new DatabaseSync(':memory:'), 5);
    const o = new Orchestrator(
      { claude: slow('claude', { ms: 5000, max: 0.02, cost: 0.01 }), chatgpt: quiet('chatgpt') },
      { weeklyBudgetGbp: 5, budget: b.gate() },
    );
    o.start('x');
    const running = o.run();
    await wait(20);
    const t0 = Date.now();
    o.stop();
    assert.equal(o.state, 'stopped'); // subito, in modo sincrono
    await running;
    assert.ok(Date.now() - t0 < 500, 'la richiesta non è stata annullata');
    assert.equal(o.stopReason, 'fermata_utente');
    assert.equal(o.history().filter((m) => m.from === 'claude').length, 0);
    assert.equal(o.turnsDone, 0);
    assert.ok(Math.abs(o.spentGbp - 0.02) < 1e-9); // costo ignoto: si conta il massimo riservato
    assert.ok(Math.abs(b.weeklySpentGbp() - 0.02) < 1e-9);
  });

  it('risposta tardiva dopo lo STOP: scartata, non riavvia la discussione, ma il costo è contabilizzato', async () => {
    const b = new Budget(new DatabaseSync(':memory:'), 5);
    const o = new Orchestrator(
      { claude: slow('claude', { ms: 80, max: 0.05, cost: 0.03, obey: false }), chatgpt: quiet('chatgpt') },
      { weeklyBudgetGbp: 5, budget: b.gate() },
    );
    o.start('x');
    const running = o.run();
    await wait(10);
    o.stop();
    await running;
    await wait(20);
    assert.equal(o.state, 'stopped');
    assert.equal(o.history().filter((m) => m.from === 'claude').length, 0);
    assert.ok(Math.abs(o.spentGbp - 0.03) < 1e-9);
    assert.ok(Math.abs(b.weeklySpentGbp() - 0.03) < 1e-9);
  });

  it('tempo scaduto: la discussione si ferma con un messaggio chiaro e il massimo riservato resta contato', async () => {
    const b = new Budget(new DatabaseSync(':memory:'), 5);
    const o = new Orchestrator(
      { claude: slow('claude', { ms: 5000, max: 0.02, cost: 0 }), chatgpt: quiet('chatgpt') },
      { weeklyBudgetGbp: 5, budget: b.gate(), callTimeoutMs: 40 },
    );
    o.start('x');
    await o.run();
    assert.equal(o.state, 'stopped');
    assert.equal(o.stopReason, 'errore');
    assert.match(o.history().at(-1)?.text ?? '', /non ha risposto/);
    assert.ok(Math.abs(b.weeklySpentGbp() - 0.02) < 1e-9);
  });

  it('una richiesta respinta prima di essere elaborata (es. HTTP 401) non costa nulla', async () => {
    const b = new Budget(new DatabaseSync(':memory:'), 5);
    const bad: Adapter = {
      id: 'claude',
      estimateMaxCostGbp: () => 0.02,
      reply: async () => {
        throw notBilled(new Error('Errore dal servizio Claude (HTTP 401)'));
      },
    };
    const o = new Orchestrator({ claude: bad, chatgpt: quiet('chatgpt') }, { weeklyBudgetGbp: 5, budget: b.gate() });
    o.start('x');
    await o.run();
    assert.equal(o.stopReason, 'errore');
    assert.equal(b.weeklySpentGbp(), 0);
  });

  it('domanda diretta: riserva il budget e si può fermare durante la risposta', async () => {
    const b = new Budget(new DatabaseSync(':memory:'), 0.01);
    const o = new Orchestrator(
      { claude: slow('claude', { ms: 5000, max: 0.02, cost: 0.02 }), chatgpt: quiet('chatgpt') },
      { weeklyBudgetGbp: 0.01, budget: b.gate() },
    );
    o.start('x');
    o.pause();
    await o.ask('claude', 'ciao'); // 0.02 > 0.01: rifiutata senza chiamare
    assert.match(o.history().at(-1)?.text ?? '', /Tetto di spesa/);

    const b2 = new Budget(new DatabaseSync(':memory:'), 5);
    const o2 = new Orchestrator(
      { claude: slow('claude', { ms: 5000, max: 0.02, cost: 0.02 }), chatgpt: quiet('chatgpt') },
      { weeklyBudgetGbp: 5, budget: b2.gate() },
    );
    o2.start('x');
    o2.pause();
    const asking = o2.ask('claude', 'ciao');
    await wait(15);
    o2.stop();
    await asking;
    assert.equal(o2.history().filter((m) => m.from === 'claude').length, 0);
  });
});
