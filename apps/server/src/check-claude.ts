/**
 * Prova di collegamento a Claude: una sola chiamata minuscola (frazioni di centesimo).
 * Legge la chiave da .env, rispetta il tetto settimanale e aggiorna il registro della spesa.
 */
import { ClaudeAdapter } from '../../../packages/adapters/src/index.js';
import { Ledger } from './ledger.js';

try {
  process.loadEnvFile('.env');
} catch {
  // nessun file .env: si usano le variabili d'ambiente, se ci sono
}

const apiKey = process.env['ANTHROPIC_API_KEY'] ?? '';
const budget = Number(process.env['WEEKLY_BUDGET_GBP'] ?? '5');
const usdToGbp = Number(process.env['USD_TO_GBP'] ?? '0.8');

if (!apiKey) {
  console.error('Manca la chiave: apri il file .env e scrivila dopo ANTHROPIC_API_KEY=');
  process.exit(1);
}

const ledger = new Ledger('data/ledger.json');
const already = ledger.spent();
if (already >= budget) {
  console.error(`Tetto settimanale raggiunto (£${already.toFixed(2)} di £${budget.toFixed(2)}): nessuna chiamata.`);
  process.exit(1);
}

const claude = new ClaudeAdapter({ apiKey, usdToGbp, maxTokens: 60 });
try {
  const reply = await claude.reply({
    goal: 'Prova di collegamento.',
    history: [{ id: 1, from: 'user', to: ['claude'], text: 'Rispondi solo con: collegamento riuscito.', kind: 'message' }],
  });
  const total = ledger.add(reply.costGbp ?? 0);
  console.log(`Risposta di Claude: ${reply.text}`);
  console.log(`Costo di questa prova: £${(reply.costGbp ?? 0).toFixed(5)}`);
  console.log(`Spesa della settimana: £${total.toFixed(5)} di £${budget.toFixed(2)}`);
} catch (e) {
  console.error((e as Error).message);
  console.error('Controlla la chiave, il credito sull\'account API e la connessione.');
  process.exit(1);
}
