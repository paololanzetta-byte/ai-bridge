import type { Adapter, AdapterInput, AdapterReply, Message } from '../../orchestrator/src/index.js';
import { buildSystemPrompt, parseReply } from './protocol.js';

const API_VERSION = '2023-06-01';

/** Prezzi in dollari per milione di token (Sonnet 5.5: 2 in entrata, 10 in uscita, 21-11-2026). */
const PRICES: Record<string, { in: number; out: number }> = {
  'claude-sonnet-5-5': { in: 2, out: 10 },
  'claude-haiku-5-5': { in: 0.1, out: 0.5 },
};
/** Per un modello sconosciuto si assume il prezzo più alto noto: meglio sovrastimare. */
const FALLBACK_PRICE = { in: 10, out: 50 };

export interface ClaudeConfig {
  apiKey: string;
  model?: string;
  maxTokens?: number;
  /** Cambio dollaro-sterlina usato per la stima. Prudente: più alto del cambio reale. */
  usdToGbp?: number;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

type ClaudeMessage = { role: 'user' | 'assistant'; content: string };

const WHO: Record<string, string> = { user: 'Utente', chatgpt: 'ChatGPT', claude: 'Claude' };

/** Converte la cronologia della stanza nel formato richiesto dall'API (ruoli alternati, si parte e si finisce da "user"). */
export function toClaudeMessages(history: readonly Message[]): ClaudeMessage[] {
  const out: ClaudeMessage[] = [];
  const push = (role: ClaudeMessage['role'], content: string) => {
    const last = out[out.length - 1];
    if (last && last.role === role) last.content += `\n\n${content}`;
    else out.push({ role, content });
  };
  for (const m of history) {
    if (m.kind === 'system' || m.kind === 'decision_request') continue;
    if (m.from === 'claude') push('assistant', m.text);
    else if (m.kind === 'decision_answer') push('user', `[Utente, decisione] ${m.text}`);
    else push('user', `[${WHO[m.from] ?? m.from}] ${m.text}`);
  }
  if (out[0]?.role !== 'user') out.unshift({ role: 'user', content: 'Inizia la discussione.' });
  if (out[out.length - 1]?.role !== 'user') out.push({ role: 'user', content: 'Continua.' });
  return out;
}

export function costGbp(model: string, inputTokens: number, outputTokens: number, usdToGbp: number): number {
  const p = PRICES[model] ?? FALLBACK_PRICE;
  return ((inputTokens * p.in + outputTokens * p.out) / 1_000_000) * usdToGbp;
}

/** Adattatore REALE per Claude tramite API a chiave. La chiave non viene mai scritta in log né in errori. */
export class ClaudeAdapter implements Adapter {
  readonly id = 'claude' as const;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly usdToGbp: number;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: ClaudeConfig) {
    if (!config.apiKey) throw new Error('Chiave API Claude mancante.');
    this.model = config.model ?? 'claude-sonnet-5-5';
    this.maxTokens = config.maxTokens ?? 400;
    this.usdToGbp = config.usdToGbp ?? 0.8;
    this.baseUrl = (config.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '');
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async reply(input: AdapterInput): Promise<AdapterReply> {
    const body = {
      model: this.model,
      max_tokens: this.maxTokens,
      system: buildSystemPrompt('Claude', 'ChatGPT', input.goal),
      messages: toClaudeMessages(input.history),
    };
    const res = await this.fetchImpl(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.config.apiKey,
        'anthropic-version': API_VERSION,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Errore dal servizio Claude (HTTP ${res.status})`);
    const data = (await res.json()) as {
      content?: { type: string; text?: string }[];
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const raw = (data.content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('\n');
    const cost = costGbp(this.model, data.usage?.input_tokens ?? 0, data.usage?.output_tokens ?? 0, this.usdToGbp);
    return { ...parseReply(raw), costGbp: cost };
  }
}
