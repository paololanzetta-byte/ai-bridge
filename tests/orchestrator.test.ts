import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEMO_CHATGPT, DEMO_CLAUDE, DEMO_GOAL, ScriptedAdapter } from '../packages/adapters/src/index.js';
import {
  Orchestrator,
  reportToText,
  similarity,
  type Adapter,
  type AdapterReply,
  type Options,
} from '../packages/orchestrator/src/index.js';

const line = (text: string, extra: Partial<AdapterReply> = {}): AdapterReply => ({ text, ...extra });

function make(claude: AdapterReply[], chatgpt: AdapterReply[], opts: Partial<Options> = {}, delayMs = 0) {
  const c = new ScriptedAdapter('claude', claude, { delayMs, afterScript: 'repeat-last' });
  const g = new ScriptedAdapter('chatgpt', chatgpt, { delayMs, afterScript: 'repeat-last' });
  return new Orchestrator({ claude: c, chatgpt: g }, opts);
}

const speakers = (o: Orchestrator) =>
  o.history().filter((m) => m.kind === 'message' && (m.from === 'claude' || m.from === 'chatgpt')).map((m) => m.from);

describe('turni', () => {
  it('alterna le AI partendo da Claude', async () => {
    const o = make(
      [line('alfa uno due tre'), line('bravo quattro cinque sei')],
      [line('charlie sette otto nove'), line('delta dieci undici dodici')],
      { maxTurns: 4 },
    );
    o.start('obiettivo');
    await o.run();
    assert.deepEqual(speakers(o), ['claude', 'chatgpt', 'claude', 'chatgpt']);
  });

  it('chiude al limite di turni', async () => {
    const o = make(
      [line('uno aaa bbb'), line('due ccc ddd'), line('tre eee fff')],
      [line('quattro ggg hhh'), line('cinque iii lll'), line('sei mmm nnn')],
      { maxTurns: 3 },
    );
    o.start('x');
    await o.run();
    assert.equal(o.state, 'finished');
    assert.equal(o.stopReason, 'limite_turni');
    assert.equal(o.turnsDone, 3);
  });

  it('conclude quando entrambe le AI dichiarano di aver finito', async () => {
    const o = make([line('prima proposta chiara', { done: true })], [line('seconda risposta diversa', { done: true })]);
    o.start('x');
    await o.run();
    assert.equal(o.state, 'finished');
    assert.equal(o.stopReason, 'conclusa');
  });
});

describe('ripetizioni', () => {
  it('ferma la discussione se le AI ripetono la stessa cosa', async () => {
    const o = make([line('Dobbiamo usare SQLite per iniziare')], [line('Dobbiamo usare SQLite per iniziare')]);
    o.start('x');
    await o.run();
    assert.equal(o.state, 'stopped');
    assert.equal(o.stopReason, 'ripetizione');
    assert.equal(o.turnsDone, 2);
  });

  it('similarity: identici = 1, diversi = 0', () => {
    assert.equal(similarity('ciao mondo bello', 'ciao mondo bello'), 1);
    assert.equal(similarity('ciao mondo bello', 'xxx yyy zzz'), 0);
  });
});

describe('decisioni dell\'utente', () => {
  it('si ferma sulla domanda e riprende con la risposta', async () => {
    const o = make(
      [line('apertura distinta uno', { needsUser: 'Quale budget?' }), line('chiusura diversa tre', { done: true })],
      [line('risposta autonoma due'), line('conferma finale quattro', { done: true })],
    );
    o.start('x');
    await o.run();
    assert.equal(o.state, 'waiting_user');
    assert.equal(o.question, 'Quale budget?');
    assert.equal(o.turnsDone, 1);

    await o.answerDecision('Cinque sterline');
    assert.equal(o.state, 'finished');
    const r = o.report();
    assert.deepEqual(r.decisioniUtente, [{ domanda: 'Quale budget?', risposta: 'Cinque sterline' }]);
  });

  it('rifiuta una risposta quando non c\'è nessuna domanda', async () => {
    const o = make([line('a b c')], [line('d e f')]);
    o.start('x');
    await assert.rejects(() => o.answerDecision('ciao'));
  });
});

describe('pausa, ripresa e stop', () => {
  it('in pausa non parte nessun nuovo turno, alla ripresa si continua', async () => {
    const o = make(
      [line('uno aaa bbb'), line('tre eee fff', { done: true })],
      [line('due ccc ddd'), line('quattro ggg hhh', { done: true })],
      {},
      5,
    );
    o.start('x');
    const running = o.run();
    o.pause();
    await running;
    assert.equal(o.state, 'paused');
    assert.equal(o.turnsDone, 1);

    await o.resume();
    assert.equal(o.state, 'finished');
    assert.equal(o.turnsDone, 4);
  });

  it('stop dell\'utente chiude la sessione', async () => {
    const o = make([line('uno aaa bbb')], [line('due ccc ddd')], {}, 5);
    o.start('x');
    const running = o.run();
    o.stop();
    await running;
    assert.equal(o.state, 'stopped');
    assert.equal(o.stopReason, 'fermata_utente');
  });
});

describe('tetto di spesa', () => {
  it('ferma la discussione prima di superare il tetto', async () => {
    const costly = (t: string) => line(t, { costGbp: 1 });
    const o = make(
      [costly('uno aaa bbb'), costly('tre eee fff'), costly('cinque iii lll')],
      [costly('due ccc ddd'), costly('quattro ggg hhh'), costly('sei mmm nnn')],
      { weeklyBudgetGbp: 2, estimatedCostPerTurnGbp: 1 },
    );
    o.start('x');
    await o.run();
    assert.equal(o.state, 'stopped');
    assert.equal(o.stopReason, 'tetto_spesa');
    assert.equal(o.turnsDone, 2);
    assert.equal(o.spentGbp, 2);
  });

  it('tiene conto di quanto è già stato speso nella settimana', async () => {
    const o = make([line('uno aaa bbb')], [line('due ccc ddd')], {
      weeklyBudgetGbp: 5,
      spentGbp: 5,
      estimatedCostPerTurnGbp: 0.5,
    });
    o.start('x');
    await o.run();
    assert.equal(o.turnsDone, 0);
    assert.equal(o.stopReason, 'tetto_spesa');
  });
});

describe('modalità diretta e ibrida', () => {
  it('la domanda diretta coinvolge una sola AI e non avvia la discussione', async () => {
    let chatgptCalls = 0;
    const claude = new ScriptedAdapter('claude', [line('x y z')]);
    const chatgpt: Adapter = {
      id: 'chatgpt',
      async reply() {
        chatgptCalls++;
        return { text: 'non dovrei parlare' };
      },
    };
    const o = new Orchestrator({ claude, chatgpt });
    await o.ask('claude', 'Una domanda solo per te');
    assert.equal(chatgptCalls, 0);
    assert.equal(o.state, 'idle');
    const last = o.history().at(-1);
    assert.equal(last?.from, 'claude');
    assert.deepEqual(last?.to, ['user']);
  });

  it('la domanda diretta è rifiutata mentre la discussione corre', async () => {
    const o = make([line('uno aaa bbb')], [line('due ccc ddd')], {}, 5);
    o.start('x');
    const running = o.run();
    await assert.rejects(() => o.ask('claude', 'ehi'));
    o.stop();
    await running;
  });

  it('un messaggio a una sola AI la fa parlare per prima', async () => {
    const o = make(
      [line('uno aaa bbb'), line('tre eee fff'), line('cinque iii lll')],
      [line('due ccc ddd'), line('quattro ggg hhh'), line('sei mmm nnn')],
    );
    o.start('x');
    await o.step();
    await o.step();
    o.sendUserMessage('Solo a ChatGPT: spiega meglio', ['chatgpt']);
    await o.step();
    assert.equal(speakers(o).at(-1), 'chatgpt');
    assert.equal(speakers(o).at(-2), 'chatgpt');
  });
});

describe('errori', () => {
  it('ferma la sessione se un servizio fallisce', async () => {
    const claude: Adapter = {
      id: 'claude',
      async reply() {
        throw new Error('rete assente');
      },
    };
    const chatgpt = new ScriptedAdapter('chatgpt', [line('a b c')]);
    const o = new Orchestrator({ claude, chatgpt });
    o.start('x');
    await o.run();
    assert.equal(o.state, 'stopped');
    assert.equal(o.stopReason, 'errore');
  });
});

describe('simulazione completa e rapporto finale', () => {
  it('percorre il copione dimostrativo fino alla conclusione', async () => {
    const o = new Orchestrator({
      claude: new ScriptedAdapter('claude', DEMO_CLAUDE),
      chatgpt: new ScriptedAdapter('chatgpt', DEMO_CHATGPT),
    });
    o.start(DEMO_GOAL);
    await o.run();
    assert.equal(o.state, 'waiting_user');
    await o.answerDecision('Solo dal Mac, all\'inizio.');
    assert.equal(o.state, 'finished');
    assert.equal(o.stopReason, 'conclusa');

    const r = o.report();
    assert.equal(r.accordi.length, 2);
    assert.equal(r.disaccordi.length, 1);
    assert.equal(r.nonVerificato.length, 1);
    assert.equal(r.decisioniUtente.length, 1);
    assert.equal(r.spesaGbp, 0);

    const text = reportToText(r);
    assert.match(text, /RAPPORTO FINALE/);
    assert.match(text, /Disaccordi:/);
    assert.match(text, /Informazioni non verificate:/);
  });
});
