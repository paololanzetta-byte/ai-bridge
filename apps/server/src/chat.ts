/**
 * Prima conversazione reale Claude + ChatGPT, dal Terminale.
 * Uso: npm run chat -- "obiettivo della discussione"
 * Limiti: massimo 6 turni, tetto settimanale di spesa (solo Claude costa denaro).
 * Nessuna azione esterna: le AI possono solo scambiarsi messaggi; il rapporto finale viene salvato in data/reports.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { ChatGPTAdapter, ClaudeAdapter } from '../../../packages/adapters/src/index.js';
import { Orchestrator, reportToText, type Message } from '../../../packages/orchestrator/src/index.js';
import { Ledger } from './ledger.js';
import { OpenAIAuth } from './openai-auth.js';
import { Store } from './store.js';

try {
  process.loadEnvFile('.env');
} catch {
  // nessun file .env
}

const goal = process.argv.slice(2).join(' ').trim();
const apiKey = process.env['ANTHROPIC_API_KEY'] ?? '';
const budget = Number(process.env['WEEKLY_BUDGET_GBP'] ?? '5');
const usdToGbp = Number(process.env['USD_TO_GBP'] ?? '0.8');
const maxTurns = Number(process.env['MAX_TURNS'] ?? '6');

if (!goal) {
  console.error('Scrivi l\'obiettivo tra virgolette, ad esempio:\nnpm run chat -- "Quale database scegliere per AI Bridge?"');
  process.exit(1);
}
if (!apiKey) {
  console.error('Manca la chiave Claude nel file .env.');
  process.exit(1);
}

const ledger = new Ledger('data/ledger.json');
const before = ledger.spent();
if (before >= budget) {
  console.error(`Tetto settimanale raggiunto (£${before.toFixed(2)} di £${budget.toFixed(2)}): nessuna conversazione.`);
  process.exit(1);
}

const auth = new OpenAIAuth();
let model = process.env['CHATGPT_MODEL'];
try {
  if (!model) {
    const token = await auth.getAccessToken();
    const r = await fetch('https://api.openai.com/v1/models', { headers: { authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(`Elenco modelli non disponibile (HTTP ${r.status}).`);
    type M = { slug?: string; id?: string; visibility?: string; supported_in_api?: boolean };
    const body = (await r.json()) as { models?: M[]; data?: M[] };
    const first = (body.models ?? body.data ?? []).find((m) => m.visibility === 'list');
    model = first?.slug ?? first?.id;
  }
  if (!model) throw new Error('Nessun modello ChatGPT disponibile: imposta CHATGPT_MODEL nel file .env.');
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}

const orch = new Orchestrator(
  {
    claude: new ClaudeAdapter({ apiKey, usdToGbp }),
    chatgpt: new ChatGPTAdapter({ getAccessToken: () => auth.getAccessToken(), model }),
  },
  { maxTurns, weeklyBudgetGbp: budget, spentGbp: before, estimatedCostPerTurnGbp: 0.02 },
);

const store = new Store('data/ai-bridge.db');
const { sessionId } = store.attach(orch, goal);

const NAMES: Record<string, string> = { user: 'Tu', claude: 'Claude', chatgpt: 'ChatGPT', system: 'Sistema' };
let printed = 0;
orch.onChange(() => {
  const h: readonly Message[] = orch.history();
  for (; printed < h.length; printed++) {
    const m = h[printed] as Message;
    if (m.kind === 'decision_request' || m.from === 'user') continue;
    console.log(`\n[${NAMES[m.from] ?? m.from}${m.tag ? ` · ${m.tag}` : ''}]\n${m.text}`);
  }
});

const rl = createInterface({ input: process.stdin, output: process.stdout });
console.log(`Obiettivo: ${goal}\nTurni massimi: ${maxTurns} · Tetto settimanale: £${budget.toFixed(2)} · ChatGPT: ${model}`);
orch.start(goal);
await orch.run();
while (orch.state === 'waiting_user') {
  const answer = (await rl.question(`\nUna delle AI chiede la tua decisione:\n${orch.question ?? ''}\n> `)).trim();
  if (!answer) {
    orch.stop();
    break;
  }
  await orch.answerDecision(answer);
}
rl.close();

const delta = Math.max(0, orch.spentGbp - before);
const total = ledger.add(delta);
const report = reportToText(orch.report());
mkdirSync('data/reports', { recursive: true });
const file = `data/reports/rapporto-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
writeFileSync(file, report);
console.log(`\n${report}\n\nSpesa di questa conversazione: £${delta.toFixed(4)} · settimana: £${total.toFixed(4)} di £${budget.toFixed(2)}\nRapporto salvato in ${file}\nConversazione n. ${sessionId} salvata nell'archivio (npm run history).`);
store.close();
