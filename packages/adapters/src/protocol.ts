import type { AdapterReply, AgentId, Message } from '../../orchestrator/src/index.js';

export type RoleMessage = { role: 'user' | 'assistant'; content: string };

const WHO: Record<string, string> = { user: 'Utente', chatgpt: 'ChatGPT', claude: 'Claude' };

/**
 * Converte la cronologia della stanza in messaggi "user"/"assistant" dal punto di vista di `self`:
 * i suoi interventi sono "assistant", tutto il resto è "user" con il nome di chi ha parlato.
 * Ruoli consecutivi uguali vengono uniti; si parte e si finisce sempre da "user".
 */
export function toRoleMessages(history: readonly Message[], self: AgentId): RoleMessage[] {
  const out: RoleMessage[] = [];
  const push = (role: RoleMessage['role'], content: string) => {
    const last = out[out.length - 1];
    if (last && last.role === role) last.content += `\n\n${content}`;
    else out.push({ role, content });
  };
  for (const m of history) {
    if (m.kind === 'system' || m.kind === 'decision_request') continue;
    if (m.from === self) push('assistant', m.text);
    else if (m.kind === 'decision_answer') push('user', `[Utente, decisione] ${m.text}`);
    else push('user', `[${WHO[m.from] ?? m.from}] ${m.text}`);
  }
  if (out[0]?.role !== 'user') out.unshift({ role: 'user', content: 'Inizia la discussione.' });
  if (out[out.length - 1]?.role !== 'user') out.push({ role: 'user', content: 'Continua.' });
  return out;
}

/** Istruzioni di ruolo comuni a tutte le AI reali (Claude, ChatGPT). */
export function buildSystemPrompt(selfName: string, otherName: string, goal: string): string {
  return [
    `Sei ${selfName} in una chat room a tre: ${otherName} e un utente umano che supervisiona.`,
    `Obiettivo della sessione: ${goal}`,
    'Rispondi in italiano, in modo breve (massimo 120 parole).',
    "Se non sei d'accordo con l'altra AI, dillo con rispetto e spiega perché.",
    'Distingui i fatti verificati dalle ipotesi. Non presentare come certo ciò che non hai verificato e non inventare dati.',
    'Non dire di avere accesso a file, memoria o account dell\'utente.',
    "Se ti serve un dato che solo l'utente può darti, termina con una riga: CHIEDI_UTENTE: <domanda>",
    'Se utile, classifica il tuo intervento con UNA riga finale: TAG: accordo, TAG: disaccordo oppure TAG: non_verificato',
    'Se ritieni la discussione conclusa (accordo raggiunto o disaccordo documentato), aggiungi una riga: CONCLUSO',
  ].join('\n');
}

const TAG_RE = /^\s*TAG:\s*(accordo|disaccordo|non_verificato)\s*$/i;
const ASK_RE = /^\s*CHIEDI_UTENTE:\s*(.+?)\s*$/i;
const DONE_RE = /^\s*CONCLUSO\.?\s*$/i;

/** Separa il testo dalle righe di servizio (TAG, CHIEDI_UTENTE, CONCLUSO). */
export function parseReply(raw: string): Pick<AdapterReply, 'text' | 'tag' | 'needsUser' | 'done'> {
  const kept: string[] = [];
  const out: Pick<AdapterReply, 'text' | 'tag' | 'needsUser' | 'done'> = { text: '' };
  for (const line of raw.split(/\r?\n/)) {
    const tag = TAG_RE.exec(line);
    const ask = ASK_RE.exec(line);
    if (tag) out.tag = (tag[1] as string).toLowerCase() as NonNullable<AdapterReply['tag']>;
    else if (ask) out.needsUser = ask[1] as string;
    else if (DONE_RE.test(line)) out.done = true;
    else kept.push(line);
  }
  out.text = kept.join('\n').trim() || '(nessun testo)';
  return out;
}
