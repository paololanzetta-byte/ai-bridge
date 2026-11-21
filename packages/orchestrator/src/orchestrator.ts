import { buildReport, type Report } from './report.js';
import { similarity } from './similarity.js';
import {
  AGENT_NAMES,
  DEFAULT_OPTIONS,
  type Adapter,
  type AdapterReply,
  type AgentId,
  type Message,
  type MessageKind,
  type Options,
  type ParticipantId,
  type State,
  type StopReason,
  type Tag,
} from './types.js';

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
  private spent: number;
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
    this.spent = this.opts.spentGbp;
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
  get spentGbp(): number {
    return this.spent;
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
    if (this.overBudget()) {
      return this.end('stopped', 'tetto_spesa', 'Tetto di spesa settimanale raggiunto: discussione fermata.');
    }
    const speaker = this.forcedNext.shift() ?? (this.lastSpeaker ? other(this.lastSpeaker) : 'claude');

    this.busy = true;
    let reply: AdapterReply;
    try {
      reply = await this.adapters[speaker].reply({ goal: this.goal, history: [...this.messages] });
    } catch {
      this.busy = false;
      return this.end('stopped', 'errore', `Errore dal servizio di ${AGENT_NAMES[speaker]}: discussione fermata.`);
    }
    this.busy = false;

    const repeated = this.isRepetition(speaker, reply.text);
    this.push(speaker, ['user', other(speaker)], reply.text, 'message', reply.tag);
    this.spent += reply.costGbp ?? 0;
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

  stop(): void {
    if (this._state === 'idle' || this._state === 'stopped' || this._state === 'finished') return;
    this.end('stopped', 'fermata_utente', 'Discussione fermata dall\'utente.');
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
    if (this.overBudget()) {
      this.push('system', ['user'], 'Tetto di spesa settimanale raggiunto: domanda non inviata.', 'system');
      this.emit();
      return;
    }
    this.busy = true;
    try {
      const reply = await this.adapters[agent].reply({ goal: this.goal, history: [...this.messages] });
      this.push(agent, ['user'], reply.text, 'message', reply.tag);
      this.spent += reply.costGbp ?? 0;
    } catch {
      this.push('system', ['user'], `Errore dal servizio di ${AGENT_NAMES[agent]}: nessuna risposta.`, 'system');
    } finally {
      this.busy = false;
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

  private overBudget(): boolean {
    return this.spent + this.opts.estimatedCostPerTurnGbp > this.opts.weeklyBudgetGbp;
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
