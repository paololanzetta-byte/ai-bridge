import type { Adapter, AdapterInput, AdapterReply, AgentId } from '../../orchestrator/src/index.js';

export interface ScriptedOptions {
  /** Cosa fare quando il copione finisce: ripetere l'ultima battuta o dichiarare di aver concluso. */
  afterScript?: 'repeat-last' | 'done';
  /** Pausa artificiale, in millisecondi, per simulare i tempi di una vera AI. */
  delayMs?: number;
}

/**
 * Adattatore FINTO: legge battute da un copione. Non usa nessuna AI e costa zero.
 * Serve a provare il coordinatore senza spendere e senza collegamenti reali.
 */
export class ScriptedAdapter implements Adapter {
  private index = 0;

  constructor(
    readonly id: AgentId,
    private readonly script: AdapterReply[],
    private readonly options: ScriptedOptions = {},
  ) {}

  async reply(input: AdapterInput): Promise<AdapterReply> {
    if (this.options.delayMs) await new Promise((r) => setTimeout(r, this.options.delayMs));

    // Domanda diretta dell'utente a questa sola AI: risposta di cortesia, senza consumare il copione.
    const last = input.history[input.history.length - 1];
    if (last && last.from === 'user' && last.kind === 'message' && last.to.length === 1 && last.to[0] === this.id) {
      const short = last.text.length > 60 ? `${last.text.slice(0, 60)}…` : last.text;
      return { text: `(risposta simulata) Ho ricevuto la tua domanda: «${short}». Con una vera AI qui ci sarebbe una risposta vera.`, costGbp: 0 };
    }

    const line = this.script[this.index];
    if (line) {
      this.index++;
      return { costGbp: 0, ...line };
    }
    const prev = this.script[this.script.length - 1];
    if (this.options.afterScript === 'repeat-last' && prev) return { costGbp: 0, ...prev };
    return { text: 'Non ho altro da aggiungere.', tag: 'accordo', done: true, costGbp: 0 };
  }
}
