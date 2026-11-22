export type AgentId = 'claude' | 'chatgpt';
export type ParticipantId = 'user' | AgentId;
export type MessageKind = 'message' | 'decision_request' | 'decision_answer' | 'system';
/** Come l'AI classifica il proprio intervento: serve al rapporto finale. */
export type Tag = 'accordo' | 'disaccordo' | 'non_verificato';

export interface Message {
  id: number;
  from: ParticipantId | 'system';
  /** Destinatari del messaggio. */
  to: ParticipantId[];
  text: string;
  kind: MessageKind;
  tag?: Tag;
}

export interface AdapterReply {
  text: string;
  tag?: Tag;
  /** Domanda per l'utente: ferma la discussione finché l'utente non risponde. */
  needsUser?: string;
  /** Costo stimato della chiamata, in sterline. */
  costGbp?: number;
  /** L'agente ritiene la discussione conclusa. */
  done?: boolean;
}

export interface AdapterInput {
  goal: string;
  history: readonly Message[];
  /** Si attiva con STOP o allo scadere del tempo massimo: l'adattatore deve interrompere la richiesta. */
  signal?: AbortSignal;
}

/** Ogni servizio AI (reale o finto) si collega al coordinatore con questa interfaccia. */
export interface Adapter {
  readonly id: AgentId;
  reply(input: AdapterInput): Promise<AdapterReply>;
  /** Costo MASSIMO possibile del prossimo turno, in sterline: viene riservato prima della chiamata. */
  estimateMaxCostGbp?(input: AdapterInput): number;
}

/**
 * Prenotazione di una parte del budget settimanale per UNA chiamata.
 * Va chiusa sempre: settle (costo reale o prudente) oppure release (sicuramente non addebitata).
 */
export interface Reservation {
  settle(actualGbp: number): void;
  release(): void;
}

/** Budget settimanale condiviso da tutte le discussioni. reserve() è atomico: undefined = rifiutata. */
export interface BudgetGate {
  reserve(maxCostGbp: number): Reservation | undefined;
  /** Speso + prenotato nella settimana, da tutte le discussioni. */
  weeklySpentGbp(): number;
}

/** Errore di un servizio. billed=false: la richiesta è stata respinta prima di elaborare, quindi non costa nulla. */
export function notBilled(e: Error): Error {
  return Object.assign(e, { billed: false });
}

export type State = 'idle' | 'running' | 'paused' | 'waiting_user' | 'stopped' | 'finished';
export type StopReason =
  | 'limite_turni'
  | 'ripetizione'
  | 'tetto_spesa'
  | 'conclusa'
  | 'fermata_utente'
  | 'errore';

export interface Options {
  /** Turni totali delle AI prima della chiusura automatica. */
  maxTurns: number;
  /** Somiglianza (0..1) oltre la quale due interventi contano come ripetizione. */
  repetitionThreshold: number;
  weeklyBudgetGbp: number;
  /** Già speso nella settimana in corso. */
  spentGbp: number;
  /** Stima del costo di un turno, usata se l'adattatore non sa stimare il proprio massimo. */
  estimatedCostPerTurnGbp: number;
  /** Tempo massimo di una chiamata a un servizio AI. */
  callTimeoutMs: number;
  /** Budget condiviso tra discussioni. Se manca, ne viene creato uno locale con weeklyBudgetGbp e spentGbp. */
  budget?: BudgetGate;
}

export const AGENT_NAMES: Record<AgentId, string> = { claude: 'Claude', chatgpt: 'ChatGPT' };

export const DEFAULT_OPTIONS: Options = {
  maxTurns: 12,
  repetitionThreshold: 0.8,
  weeklyBudgetGbp: 5,
  spentGbp: 0,
  estimatedCostPerTurnGbp: 0,
  callTimeoutMs: 120_000,
};
