import { MemoryBudget } from './budget.js';
import { buildReport, type Report } from './report.js';
import { similarity } from './similarity.js';
import {
  AGENT_NAMES,
  DEFAULT_OPTIONS,
  type Adapter,
  type AdapterInput,
  type AdapterReply,
  type BudgetGate,
  type AgentId,
  type Message,
  type MessageKind,
  type Options,
  type Reservation,
  type ParticipantId,
  type State,
  type StopReason,
  type Tag,
} from './types.js';

type CallOutcome =
  | { kind: 'ok'; reply: AdapterReply }
  | { kind: 'refused' }
  | { kind: 'failed'; timedOut: boolean }
  | { kind: 'discarded' };

const AGENTS: AgentId[] = ['claude', 'chatgpt'];
const other = (a: AgentId): AgentId => (a === 'claude' ? 'chatgpt' : 'claude');

/**
 * Coordinatore della stanza: decide chi parla, quando fermarsi e quando chiedere all'utente.
 * Non parla con nessun servizio direttamente: usa gli adattatori che riceve.
 */
export class Orchestrator {
  private readonly opts: Options;
  private messages: Message[] = [];
  private nextId = 1;
  private _state: State = 'idle';
  private _stopReason?: StopReason;
  private turns = 0;
  /** Spesa di QUESTA discussione (mai il totale settimanale). */
  private spent = 0;
  private readonly budget: BudgetGate;
  private inflight?: { controller: AbortController; timedOut: boolean };
  private stopEpoch = 0;
  private goal = '';
  private lastSpeaker?: AgentId;
  private forcedNext: AgentId[] = [];
  private done: Record<AgentId, boolean> = { claude: false, chatgpt: false };
  private pendingQuestion?: string;
  private busy = false;
  private listeners = new Set<() => void>();

  constructor(
    private readonly adapters: Record<AgentId, Adapter>,
    options: Partial<Options> = {},
  ) {
    this.opts = { ...DEFAULT_OPTIONS, ...options };
    this.budget = this.opts.budget ?? new MemoryBudget(this.opts.weeklyBudgetGbp, this.opts.spentGbp);
  }

  get state(): State {
    return this._state;
  }
  get stopReason(): StopReason | undefined {
    return this._stopReason;
  }
  get question(): string | undefined {
    return this.pendingQuestion;
  }
  get turnsDone(): number {
    return this.turns;
  }
  /** Spesa di questa discussione. */
  get spentGbp(): number {
    return this.spent;
  }
  /** Speso e prenotato nella settimana da tutte le discussioni. */
  get weeklySpentGbp(): number {
    return this.budget.weeklySpentGbp();
  }
  get weeklyBudgetGbp(): number {
    return this.opts.weeklyBudgetGbp;
  }
  history(): readonly Message[] {
    return this.messages;
  }
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Modalità autonoma: l'utente assegna un obiettivo, le AI discutono. Chiamare poi run(). */
  start(goal: string): void {
    if (this._state !== 'idle') throw new Error('La sessione è già avviata.');
    this.goal = goal;
    this.push('user', ['claude', 'chatgpt'], goal, 'message');
    this._state = 'running';
    this.emit();
  }

  /** Esegue turni finché la sessione resta "running". */
  async run(): Promise<void> {
    while (this._state === 'running' && !this.busy) {
      await this.step();
    }
  }

  /** Un solo turno di un'AI. */
  async step(): Promise<void> {
    if (this._state !== 'running' || this.busy) return;
    if (this.turns >= this.opts.maxTurns) {
      return this.end('finished', 'limite_turni', 'Limite di turni raggiunto: discussione chiusa.');
    }
    const speaker = this.forcedNext.shift() ?? (this.lastSpeaker ? other(this.lastSpeaker) : 'claude');

    const outcome = await this.call(speaker);
    if (outcome.kind === 'refused') {
      return this.end('stopped', 'tetto_spesa', 'Tetto di spesa settimanale raggiunto: discussione fermata.');
    }
    if (outcome.kind === 'discarded') {
      this.emit();
      return;
    }
    if (outcome.kind === 'failed') {
      return this.end('stopped', 'errore', outcome.timedOut
        ? `${AGENT_NAMES[speaker]} non ha risposto entro ${Math.round(this.opts.callTimeoutMs / 1000)} secondi: discussione fermata.`
        : `Errore dal servizio di ${AGENT_NAMES[speaker]}: discussione fermata.`);
    }
    const reply = outcome.reply;

    const repeated = this.isRepetition(speaker, reply.text);
    this.push(speaker, ['user', other(speaker)], reply.text, 'message', reply.tag);
    this.turns++;
    this.lastSpeaker = speaker;
    this.done[speaker] = !!reply.done;

    if (reply.needsUser) {
      this.pendingQuestion = reply.needsUser;
      this.push(speaker, ['user'], reply.needsUser, 'decision_request');
      this._state = 'waiting_user';
      this.emit();
      return;
    }
    if (this._state !== 'running') {
      this.emit();
      return;
    }
    if (repeated) {
      return this.end('stopped', 'ripetizione', 'Le AI si ripetono: discussione fermata per evitare sprechi.');
    }
    if (this.done.claude && this.done.chatgpt) {
      return this.end('finished', 'conclusa', 'Entrambe le AI hanno concluso: discussione chiusa.');
    }
    this.emit();
  }

  pause(): void {
    if (this._state === 'running') {
      this._state = 'paused';
      this.emit();
    }
  }

  async resume(): Promise<void> {
    if (this._state !== 'paused') return;
    this._state = 'running';
    this.emit();
    await this.run();
  }

  /**
   * STOP: la discussione si ferma subito. La richiesta in corso viene cancellata; se la risposta arriva lo stesso
   * viene scartata (non riavvia nulla), ma l'eventuale costo resta contabilizzato.
   */
  stop(): void {
    this.stopEpoch++;
    if (this._state !== 'idle' && this._state !== 'stopped' && this._state !== 'finished') {
      this.end('stopped', 'fermata_utente', 'Discussione fermata dall\'utente.');
    }
    this.inflight?.controller.abort();
  }

  /** Modalità ibrida: messaggio dell'utente nella stanza. Se ha un solo destinatario, parla lui per primo. */
  sendUserMessage(text: string, to: AgentId[] = AGENTS): void {
    const recipients = to.length ? to : AGENTS;
    this.push('user', recipients, text, 'message');
    if ((this._state === 'running' || this._state === 'paused') && recipients.length === 1) {
      this.forcedNext = [recipients[0] as AgentId];
    }
    this.emit();
  }

  /** Modalità diretta: domanda a una sola AI, senza coinvolgere l'altra né avviare la discussione. */
  async ask(agent: AgentId, text: string): Promise<void> {
    if (this._state === 'running' || this.busy) {
      throw new Error('Metti in pausa la discussione prima di fare una domanda diretta.');
    }
    this.push('user', [agent], text, 'message');
    const outcome = await this.call(agent);
    if (outcome.kind === 'refused') {
      this.push('system', ['user'], 'Tetto di spesa settimanale raggiunto: domanda non inviata.', 'system');
    } else if (outcome.kind === 'failed') {
      this.push('system', ['user'], outcome.timedOut
        ? `${AGENT_NAMES[agent]} non ha risposto in tempo: nessuna risposta.`
        : `Errore dal servizio di ${AGENT_NAMES[agent]}: nessuna risposta.`, 'system');
    } else if (outcome.kind === 'ok') {
      this.push(agent, ['user'], outcome.reply.text, 'message', outcome.reply.tag);
    }
    this.emit();
  }

  /** L'utente risponde a una richiesta di decisione e la discussione riprende. */
  async answerDecision(text: string): Promise<void> {
    if (this._state !== 'waiting_user') throw new Error('Nessuna decisione in attesa.');
    this.push('user', ['claude', 'chatgpt'], text, 'decision_answer');
    this.pendingQuestion = undefined;
    this._state = 'running';
    this.emit();
    await this.run();
  }

  report(): Report {
    return buildReport(this.goal, this.messages, this._state, this._stopReason, this.turns, this.spent);
  }

  /**
   * Una chiamata a un servizio AI con il budget in regola: prima si riserva il costo MASSIMO possibile,
   * poi si chiama (con tempo limite e possibilità di annullare), infine si chiude la prenotazione.
   * Se non si sa quanto è costata (errore di rete, tempo scaduto, stop) si conta il massimo riservato: meglio sovrastimare.
   */
  private async call(agent: AgentId): Promise<CallOutcome> {
    const input: AdapterInput = { goal: this.goal, history: [...this.messages] };
    const adapter = this.adapters[agent];
    const estimate = adapter.estimateMaxCostGbp?.(input) ?? this.opts.estimatedCostPerTurnGbp;
    const reservation: Reservation | undefined = this.budget.reserve(estimate);
    if (!reservation) return { kind: 'refused' };

    const slot = { controller: new AbortController(), timedOut: false };
    this.inflight = slot;
    const timer = setTimeout(() => {
      slot.timedOut = true;
      slot.controller.abort();
    }, this.opts.callTimeoutMs);
    const epoch = this.stopEpoch;
    this.busy = true;
    try {
      const reply = await adapter.reply({ ...input, signal: slot.controller.signal });
      const cost = reply.costGbp ?? 0;
      reservation.settle(cost);
      this.spent += cost;
      return epoch === this.stopEpoch ? { kind: 'ok', reply } : { kind: 'discarded' };
    } catch (e) {
      const notCharged = (e as { billed?: boolean }).billed === false && !slot.controller.signal.aborted;
      if (notCharged) reservation.release();
      else {
        reservation.settle(estimate);
        this.spent += estimate;
      }
      return epoch === this.stopEpoch ? { kind: 'failed', timedOut: slot.timedOut } : { kind: 'discarded' };
    } finally {
      clearTimeout(timer);
      this.busy = false;
      if (this.inflight === slot) this.inflight = undefined;
    }
  }

  private isRepetition(speaker: AgentId, text: string): boolean {
    const own = this.lastMessageFrom(speaker);
    const theirs = this.lastMessageFrom(other(speaker));
    return [own, theirs].some((m) => m && similarity(m.text, text) >= this.opts.repetitionThreshold);
  }

  private lastMessageFrom(who: AgentId): Message | undefined {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i] as Message;
      if (m.from === who && m.kind === 'message') return m;
    }
    return undefined;
  }

  private end(state: 'stopped' | 'finished', reason: StopReason, note: string): void {
    this._state = state;
    this._stopReason = reason;
    this.pendingQuestion = undefined;
    this.push('system', ['user'], note, 'system');
    this.emit();
  }

  private push(
    from: ParticipantId | 'system',
    to: ParticipantId[],
    text: string,
    kind: MessageKind,
    tag?: Tag,
  ): void {
    const m: Message = { id: this.nextId++, from, to, text, kind };
    if (tag) m.tag = tag;
    this.messages.push(m);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}
