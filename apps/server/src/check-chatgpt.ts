import { ChatGPTAdapter } from '../../../packages/adapters/src/index.js';
import { OpenAIAuth } from './openai-auth.js';

try {
  process.loadEnvFile('.env');
} catch {
  // nessun file .env
}

const auth = new OpenAIAuth();
try {
  const token = await auth.getAccessToken();
  let model = process.env.CHATGPT_MODEL;
  if (!model) {
    const r = await fetch('https://api.openai.com/v1/models', { headers: { authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(`Elenco modelli non disponibile (HTTP ${r.status}).`);
    type M = { slug?: string; id?: string; visibility?: string; supported_in_api?: boolean };
    const body = (await r.json()) as { models?: M[]; data?: M[] };
    const listed = (body.models ?? body.data ?? []).filter((m) => m.visibility === 'list');
    model = listed[0]?.slug ?? listed[0]?.id;
    console.log('Modelli disponibili:', listed.map((m) => m.slug ?? m.id).join(', ') || '(nessuno)');
  }
  if (!model) throw new Error('Nessun modello disponibile: imposta CHATGPT_MODEL.');
  console.log(`Provo una chiamata minuscola con il modello ${model}...`);
  const adapter = new ChatGPTAdapter({ getAccessToken: () => auth.getAccessToken(), model });
  const reply = await adapter.reply({
    goal: 'Prova di collegamento: rispondi con una sola frase breve.',
    history: [],
  });
  console.log('Risposta di ChatGPT:', reply.text);
  console.log('Costo in denaro: £0 (usa la quota del tuo piano ChatGPT).');
} catch (e) {
  console.error(e instanceof Error ? e.message : 'Errore sconosciuto.');
  process.exitCode = 1;
}
