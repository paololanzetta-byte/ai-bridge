import { DEMO_CHATGPT, DEMO_CLAUDE, DEMO_GOAL, ScriptedAdapter } from '../packages/adapters/src/index.js';
import {
  AGENT_NAMES,
  Orchestrator,
  reportToText,
  type AgentId,
  type Message,
  type State,
} from '../packages/orchestrator/src/index.js';

const MAX_TURNS = 12;
const WEEKLY_BUDGET = 5;

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const STATE_LABEL: Record<State, string> = {
  idle: 'Pronta',
  running: 'In corso',
  paused: 'In pausa',
  waiting_user: 'Attende te',
  stopped: 'Fermata',
  finished: 'Conclusa',
};
const TAG_LABEL = { accordo: 'Accordo', disaccordo: 'Disaccordo', non_verificato: 'Non verificato' } as const;
const WHO: Record<string, string> = { user: 'Tu', claude: 'Claude', chatgpt: 'ChatGPT', system: 'Sistema' };

function newRoom(): Orchestrator {
  return new Orchestrator(
    {
      claude: new ScriptedAdapter('claude', DEMO_CLAUDE, { delayMs: 900 }),
      chatgpt: new ScriptedAdapter('chatgpt', DEMO_CHATGPT, { delayMs: 900 }),
    },
    { maxTurns: MAX_TURNS, weeklyBudgetGbp: WEEKLY_BUDGET, spentGbp: 0, estimatedCostPerTurnGbp: 0 },
  );
}

let room = newRoom();
let unsubscribe = room.onChange(render);

function hint(text = ''): void {
  $('hint').textContent = text;
}

function target(): AgentId[] {
  const v = $<HTMLSelectElement>('target').value;
  return v === 'claude' || v === 'chatgpt' ? [v] : ['claude', 'chatgpt'];
}

function bubble(m: Message): HTMLElement {
  const el = document.createElement('div');
  const cls = m.kind === 'decision_request' ? 'decision' : m.from;
  el.className = `bubble b-${cls}`;

  const head = document.createElement('div');
  head.className = 'head';
  let who = WHO[m.from] ?? String(m.from);
  if (m.kind === 'decision_request') who += ' chiede a te';
  else if (m.kind === 'decision_answer') who = 'La tua decisione';
  else if (m.from === 'user' && m.to.length === 1) who += ` → ${AGENT_NAMES[m.to[0] as AgentId]}`;
  const name = document.createElement('span');
  name.textContent = who;
  head.append(name);
  if (m.tag) {
    const chip = document.createElement('span');
    chip.className = `chip chip-${m.tag}`;
    chip.textContent = TAG_LABEL[m.tag];
    head.append(chip);
  }
  const body = document.createElement('div');
  body.textContent = m.text;
  el.append(head, body);
  return el;
}

function render(): void {
  const s = room.state;
  const pill = $('state');
  pill.textContent = STATE_LABEL[s];
  pill.dataset.state = s;
  $('turns').textContent = `${room.turnsDone} / ${MAX_TURNS}`;
  $('spent').textContent = `£${room.spentGbp.toFixed(2)} / £${room.weeklyBudgetGbp.toFixed(2)}`;

  const chat = $('chat');
  chat.replaceChildren(...room.history().map(bubble));
  if (room.history().length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'Premi «Avvia» per far partire la conversazione simulata tra Claude e ChatGPT.';
    chat.append(empty);
  }
  chat.scrollTop = chat.scrollHeight;

  const ended = s === 'stopped' || s === 'finished';
  $<HTMLButtonElement>('start').disabled = s !== 'idle';
  $<HTMLButtonElement>('pause').disabled = s !== 'running';
  $<HTMLButtonElement>('resume').disabled = s !== 'paused';
  $<HTMLButtonElement>('stop').disabled = !(s === 'running' || s === 'paused' || s === 'waiting_user');
  $<HTMLButtonElement>('say').disabled = !(s === 'running' || s === 'paused' || s === 'waiting_user');
  $<HTMLButtonElement>('ask').disabled = s === 'running';

  const decision = $('decision');
  decision.hidden = s !== 'waiting_user';
  $('question').textContent = room.question ?? '';

  const report = $('report');
  report.hidden = !ended;
  if (ended) $('reportText').textContent = reportToText(room.report());
}

function reset(): void {
  room.stop();
  unsubscribe();
  room = newRoom();
  unsubscribe = room.onChange(render);
  hint();
  render();
}

$('start').addEventListener('click', () => {
  hint();
  room.start(DEMO_GOAL);
  void room.run();
});
$('pause').addEventListener('click', () => room.pause());
$('resume').addEventListener('click', () => void room.resume());
$('stop').addEventListener('click', () => room.stop());
$('reset').addEventListener('click', reset);

function sendDecision(text: string): void {
  const t = text.trim();
  if (!t) return hint('Scrivi una risposta o scegline una.');
  hint();
  $<HTMLInputElement>('answer').value = '';
  void room.answerDecision(t);
}
$('answerBtn').addEventListener('click', () => sendDecision($<HTMLInputElement>('answer').value));
document.querySelectorAll<HTMLButtonElement>('[data-quick]').forEach((b) =>
  b.addEventListener('click', () => sendDecision(b.dataset.quick ?? '')),
);

function composerText(): string {
  const input = $<HTMLInputElement>('msg');
  const t = input.value.trim();
  if (t) input.value = '';
  return t;
}
$('say').addEventListener('click', () => {
  const t = composerText();
  if (!t) return hint('Scrivi un messaggio.');
  hint();
  room.sendUserMessage(t, target());
});
$('ask').addEventListener('click', () => {
  const t = $<HTMLInputElement>('msg').value.trim();
  if (!t) return hint('Scrivi una domanda.');
  const who = target();
  if (who.length !== 1) return hint('Per una domanda diretta scegli Claude oppure ChatGPT.');
  composerText();
  hint();
  room.ask(who[0] as AgentId, t).catch((e: Error) => hint(e.message));
});

render();
