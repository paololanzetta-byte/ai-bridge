import { AGENT_NAMES, type AgentId, type Message, type State, type StopReason } from './types.js';

export interface Report {
  goal: string;
  stato: State;
  motivo?: StopReason;
  turni: number;
  spesaGbp: number;
  accordi: string[];
  disaccordi: string[];
  nonVerificato: string[];
  decisioniUtente: { domanda: string; risposta: string }[];
}

const REASONS: Record<StopReason, string> = {
  limite_turni: 'limite di turni raggiunto',
  ripetizione: 'le AI si ripetevano',
  tetto_spesa: 'tetto di spesa raggiunto',
  conclusa: 'entrambe le AI hanno concluso',
  fermata_utente: 'fermata dall\'utente',
  errore: 'errore di un servizio',
};

const STATES: Record<State, string> = {
  idle: 'non avviata',
  running: 'in corso',
  paused: 'in pausa',
  waiting_user: 'in attesa di una decisione',
  stopped: 'fermata',
  finished: 'conclusa',
};

function label(m: Message): string {
  const who = m.from === 'claude' || m.from === 'chatgpt' ? AGENT_NAMES[m.from as AgentId] : String(m.from);
  return `${who}: ${m.text}`;
}

export function buildReport(
  goal: string,
  messages: readonly Message[],
  state: State,
  reason: StopReason | undefined,
  turns: number,
  spentGbp: number,
): Report {
  const report: Report = {
    goal,
    stato: state,
    motivo: reason,
    turni: turns,
    spesaGbp: spentGbp,
    accordi: [],
    disaccordi: [],
    nonVerificato: [],
    decisioniUtente: [],
  };
  let lastQuestion = '';
  for (const m of messages) {
    if (m.kind === 'decision_request') lastQuestion = m.text;
    else if (m.kind === 'decision_answer') {
      report.decisioniUtente.push({ domanda: lastQuestion, risposta: m.text });
    } else if (m.kind === 'message' && m.tag) {
      if (m.tag === 'accordo') report.accordi.push(label(m));
      else if (m.tag === 'disaccordo') report.disaccordi.push(label(m));
      else report.nonVerificato.push(label(m));
    }
  }
  return report;
}

export function reportToText(r: Report): string {
  const list = (items: string[]) => (items.length ? items.map((i) => `- ${i}`).join('\n') : '- nessuno');
  const decisions = r.decisioniUtente.length
    ? r.decisioniUtente.map((d) => `- ${d.domanda} -> ${d.risposta}`).join('\n')
    : '- nessuna';
  return [
    `RAPPORTO FINALE`,
    `Obiettivo: ${r.goal}`,
    `Stato: ${STATES[r.stato]}${r.motivo ? ` (${REASONS[r.motivo]})` : ''}`,
    `Turni: ${r.turni} | Spesa: £${r.spesaGbp.toFixed(2)}`,
    ``,
    `Accordi:\n${list(r.accordi)}`,
    ``,
    `Disaccordi:\n${list(r.disaccordi)}`,
    ``,
    `Informazioni non verificate:\n${list(r.nonVerificato)}`,
    ``,
    `Decisioni dell'utente:\n${decisions}`,
  ].join('\n');
}
