import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { DEMO_CHATGPT, DEMO_CLAUDE, DEMO_GOAL, ScriptedAdapter } from '../packages/adapters/src/index.js';
import { Orchestrator } from '../packages/orchestrator/src/index.js';
import { Store } from '../apps/server/src/store.js';

describe('Store', () => {
  it('salva conversazione, stato e rapporto, e li rilegge dopo la chiusura', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'aib-')), 'sub', 'db.sqlite');
    const store = new Store(file);
    const orch = new Orchestrator({ claude: new ScriptedAdapter('claude', DEMO_CLAUDE), chatgpt: new ScriptedAdapter('chatgpt', DEMO_CHATGPT) });
    const { sessionId } = store.attach(orch, DEMO_GOAL);
    orch.start(DEMO_GOAL);
    await orch.run();
    while (orch.state === 'waiting_user') await orch.answerDecision('Procedete pure.');
    const expected = orch.history().length;
    store.close();

    const again = new Store(file);
    const s = again.getSession(sessionId);
    assert.ok(s);
    assert.equal(s.goal, DEMO_GOAL);
    assert.equal(s.state, orch.state);
    assert.equal(s.turns, orch.turnsDone);
    assert.ok(s.endedAt);
    assert.match(s.reportText ?? '', /RAPPORTO FINALE/);
    const msgs = again.messages(sessionId);
    assert.equal(msgs.length, expected);
    assert.equal(msgs[0]?.from, 'user');
    assert.deepEqual(again.listSessions().map((x) => x.id), [sessionId]);
    again.close();
  });

  it('più sessioni: la più recente è la prima', () => {
    const store = new Store(':memory:');
    const a = store.createSession('uno');
    const b = store.createSession('due');
    assert.deepEqual(store.listSessions().map((x) => x.id), [b, a]);
    assert.equal(store.getSession(999), undefined);
    store.close();
  });
});
