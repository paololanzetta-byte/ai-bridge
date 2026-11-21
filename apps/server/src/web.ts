/**
 * Avvia la pagina web di AI Bridge.
 * Uso: npm run web   (poi apri http://127.0.0.1:3000)
 * Prova senza chiavi e senza costi: npm run web:prova
 * Per aprirla dal telefono (Tailscale) avvia con HOST=0.0.0.0 — vedi docs/GUIDA-MAC.md.
 */
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { ChatGPTAdapter, ClaudeAdapter, ScriptedAdapter, DEMO_CHATGPT, DEMO_CLAUDE } from '../../../packages/adapters/src/index.js';
import { createApp, UserError } from './app.js';
import { OpenAIAuth } from './openai-auth.js';

try {
  process.loadEnvFile('.env');
} catch {
  // nessun file .env
}

const demo = process.env['AIBRIDGE_DEMO'] === '1';
const host = process.env['HOST'] ?? '127.0.0.1';
const port = Number(process.env['PORT'] ?? '3000');
const budget = Number(process.env['WEEKLY_BUDGET_GBP'] ?? '5');
const dataDir = resolve(demo ? 'data-prova' : 'data');
const auth = new OpenAIAuth();

async function chatgptModel(): Promise<string> {
  const fixed = process.env['CHATGPT_MODEL'];
  if (fixed) return fixed;
  const token = await auth.getAccessToken();
  const r = await fetch('https://api.openai.com/v1/models', { headers: { authorization: `Bearer ${token}` } });
  if (!r.ok) throw new UserError('Non riesco a leggere i modelli di ChatGPT. Scrivi CHATGPT_MODEL nel file .env.');
  type M = { slug?: string; id?: string; visibility?: string };
  const body = (await r.json()) as { models?: M[]; data?: M[] };
  const first = (body.models ?? body.data ?? []).find((m) => m.visibility === 'list');
  const model = first?.slug ?? first?.id;
  if (!model) throw new UserError('Nessun modello ChatGPT disponibile: scrivi CHATGPT_MODEL nel file .env.');
  return model;
}

const app = createApp({
  dataDir,
  publicDir: resolve('apps/web/public'),
  weeklyBudgetGbp: budget,
  demo,
  status: async () => ({ claude: demo || Boolean(process.env['ANTHROPIC_API_KEY']), chatgpt: demo || (await auth.isLoggedIn()) }),
  makeAdapters: async () => {
    if (demo) {
      const opt = { delayMs: 900, afterScript: 'repeat-last' as const };
      return { claude: new ScriptedAdapter('claude', DEMO_CLAUDE, opt), chatgpt: new ScriptedAdapter('chatgpt', DEMO_CHATGPT, opt) };
    }
    const apiKey = process.env['ANTHROPIC_API_KEY'] ?? '';
    if (!apiKey) throw new UserError('Manca la chiave di Claude nel file .env.');
    if (!(await auth.isLoggedIn())) throw new UserError('Non hai ancora fatto l\'accesso a ChatGPT: esegui npm run login:chatgpt.');
    const model = await chatgptModel();
    return {
      claude: new ClaudeAdapter({ apiKey, usdToGbp: Number(process.env['USD_TO_GBP'] ?? '0.8') }),
      chatgpt: new ChatGPTAdapter({ getAccessToken: () => auth.getAccessToken(), model }),
    };
  },
});

const server = createServer(app.handler);
server.listen(port, host, () => {
  console.log(`AI Bridge${demo ? ' (PROVA, risposte simulate)' : ''} attivo su http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`);
  if (host !== '127.0.0.1') console.log('Attenzione: raggiungibile da altri dispositivi della tua rete. Il PIN è obbligatorio.');
});
const stop = () => {
  server.close();
  app.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
