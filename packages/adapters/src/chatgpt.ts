import type { Adapter, AdapterInput, AdapterReply } from '../../orchestrator/src/index.js';
import { buildSystemPrompt, parseReply, toRoleMessages } from './protocol.js';
import { sseEvents } from './sse.js';

export interface ChatGPTConfig {
  /** Restituisce un access token valido (rinnovandolo se serve). Il token non viene mai scritto in log né in errori. */
  getAccessToken: () => Promise<string>;
  model: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Adattatore REALE per ChatGPT con il piano dell'utente ("Sign in with ChatGPT", anteprima).
 * Regole dell'anteprima: store=false, stream=true, niente temperature/max_output_tokens,
 * niente messaggi "system" (si usa `instructions`), cronologia sempre rinviata per intero.
 * Il costo in denaro è 0: l'uso conta sulla quota del piano ChatGPT.
 */
export class ChatGPTAdapter implements Adapter {
  readonly id = 'chatgpt' as const;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: ChatGPTConfig) {
    this.baseUrl = (config.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async reply(input: AdapterInput): Promise<AdapterReply> {
    const token = await this.config.getAccessToken();
    const res = await this.fetchImpl(`${this.baseUrl}/responses`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.config.model,
        instructions: buildSystemPrompt('ChatGPT', 'Claude', input.goal),
        input: toRoleMessages(input.history, 'chatgpt'),
        store: false,
        stream: true,
      }),
    });

    if (!res.ok || !res.body) {
      let code = '';
      try {
        const body = (await res.json()) as { error?: { code?: string } };
        code = body.error?.code ?? '';
      } catch {
        // corpo non JSON
      }
      throw new Error(`Errore dal servizio ChatGPT (HTTP ${res.status}${code ? `, ${code}` : ''})`);
    }

    let text = '';
    let completed = false;
    for await (const ev of sseEvents(res.body)) {
      if (ev.type === 'response.output_text.delta' && typeof ev.delta === 'string') text += ev.delta;
      else if (ev.type === 'response.failed') {
        throw new Error(`Errore dal servizio ChatGPT (${ev.response?.error?.code ?? 'sconosciuto'})`);
      } else if (ev.type === 'response.incomplete') {
        throw new Error('Risposta di ChatGPT incompleta.');
      } else if (ev.type === 'response.completed') completed = true;
    }
    if (!completed) throw new Error('Risposta di ChatGPT interrotta.');
    return { ...parseReply(text), costGbp: 0 };
  }
}
