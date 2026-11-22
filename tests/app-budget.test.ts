import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { DEMO_CHATGPT, DEMO_CLAUDE, ScriptedAdapter } from '../packages/adapters/src/index.js';
import { createApp, isLoopbackHost } from '../apps/server/src/app.js';

describe('web app: budget, avvisi e accesso', () => {
  let server: Server;
  let app: ReturnType<typeof createApp>;
  let port = 0;
  let cookie = '';

  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = r.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0] ?? '';
    return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
  };

  before(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aibbw-'));
    const pub = join(dir, 'pub');
    mkdirSync(pub);
    writeFileSync(join(pub, 'index.html'), 'ok');
    app = createApp({
      dataDir: join(dir, 'data'), publicDir: pub, weeklyBudgetGbp: 5, demo: true,
      makeAdapters: async () => ({
        claude: new ScriptedAdapter('claude', DEMO_CLAUDE, { delayMs: 5000 }),
        chatgpt: new ScriptedAdapter('chatgpt', DEMO_CHATGPT),
      }),
    });
    server = createServer(app.handler);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
    await call('POST', '/api/setup', { pin: '4821' });
  });
  after(() => { server.close(); app.close(); });

  it('gli avvisi usano la spesa impegnata di tutte le discussioni: 50%, 80%, tetto', async () => {
    assert.equal((await call('GET', '/api/me')).json.budget.level, 'ok');
    app.budget.record(2.6, 'prova');
    assert.equal((await call('GET', '/api/me')).json.budget.level, '50');
    app.budget.record(1.5, 'prova');
    assert.equal((await call('GET', '/api/me')).json.budget.level, '80');
    const open = app.budget.reserve(0.9); // una chiamata in corso conta subito
    assert.equal((await call('GET', '/api/me')).json.budget.level, 'tetto');
    assert.equal((await call('POST', '/api/sessions', { goal: 'Prova a tetto raggiunto', mode: 'ibrida' })).status, 400);
    open?.release();
  });

  it('la spesa mostrata per la discussione non è il totale settimanale; STOP via API ferma subito', async () => {
    const id = (await call('POST', '/api/sessions', { goal: 'Prova spesa sessione', mode: 'ibrida' })).json.id;
    await new Promise((r) => setTimeout(r, 50));
    const t0 = Date.now();
    assert.equal((await call('POST', `/api/sessions/${id}/stop`, {})).status, 202);
    const d = (await call('GET', `/api/sessions/${id}`)).json;
    assert.equal(d.state, 'stopped');
    assert.equal(d.spentGbp, 0); // il totale settimanale è 4.1: non deve comparire qui
    assert.ok((await call('GET', '/api/me')).json.budget.spent >= 4.1);
    assert.ok(Date.now() - t0 < 1000);
  });

  it('il cookie è Secure solo fuori da 127.0.0.1 (dietro Tailscale Serve) e il server accetta solo indirizzi locali', async () => {
    assert.ok(isLoopbackHost('127.0.0.1') && isLoopbackHost('localhost') && isLoopbackHost('::1'));
    assert.ok(!isLoopbackHost('0.0.0.0') && !isLoopbackHost('192.168.1.5'));
    const login = (host: string) =>
      new Promise<string>((resolve) => {
        const req = request({ host: '127.0.0.1', port, path: '/api/login', method: 'POST', headers: { host, 'content-type': 'application/json' } }, (res) => {
          res.resume();
          resolve(String(res.headers['set-cookie'] ?? ''));
        });
        req.end(JSON.stringify({ pin: '4821' }));
      });
    assert.doesNotMatch(await login(`127.0.0.1:${port}`), /Secure/);
    assert.match(await login('mac.rete-tua.ts.net'), /Secure/);
  });
});
