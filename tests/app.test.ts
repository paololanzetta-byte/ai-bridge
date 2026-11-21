import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { DEMO_CHATGPT, DEMO_CLAUDE, ScriptedAdapter } from '../packages/adapters/src/index.js';
import { createApp } from '../apps/server/src/app.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40)]);

describe('web app', () => {
  let server: Server;
  let base = '';
  let cookie = '';
  let app: ReturnType<typeof createApp>;

  const call = async (method: string, path: string, body?: unknown, extra: Record<string, string> = {}) => {
    const headers: Record<string, string> = { ...extra };
    if (cookie) headers['cookie'] = cookie;
    let payload: BodyInit | undefined;
    if (Buffer.isBuffer(body)) payload = new Uint8Array(body);
    else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    const r = await fetch(base + path, { method, headers, body: payload });
    const text = await r.text();
    let json: any = {};
    try { json = JSON.parse(text); } catch { /* testo */ }
    const set = r.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0] ?? '';
    return { status: r.status, json, text };
  };
  const until = async (fn: () => Promise<boolean>) => {
    for (let i = 0; i < 100; i++) { if (await fn()) return; await new Promise((r) => setTimeout(r, 30)); }
    assert.fail('timeout');
  };

  before(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aibweb-'));
    const pub = join(dir, 'pub');
    mkdirSync(pub);
    writeFileSync(join(pub, 'index.html'), '<h1>ok</h1>');
    app = createApp({
      dataDir: join(dir, 'data'), publicDir: pub, weeklyBudgetGbp: 5, demo: true,
      makeAdapters: async () => ({ claude: new ScriptedAdapter('claude', DEMO_CLAUDE), chatgpt: new ScriptedAdapter('chatgpt', DEMO_CHATGPT) }),
    });
    server = createServer(app.handler);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => { server.close(); app.close(); });

  it('serve la pagina con intestazioni di sicurezza e blocca i percorsi fuori cartella', async () => {
    const r = await fetch(base + '/');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-security-policy') ?? '', /default-src 'self'/);
    assert.equal((await fetch(base + '/..%2f..%2fetc/passwd')).status, 404);
  });

  it('richiede il PIN, lo crea, riconosce Paolo', async () => {
    assert.equal((await call('GET', '/api/sessions')).status, 401);
    assert.equal((await call('GET', '/api/public')).json.name, 'Paolo');
    assert.equal((await call('POST', '/api/setup', { pin: '12' })).status, 400);
    assert.equal((await call('POST', '/api/setup', { pin: '4821' })).status, 200);
    assert.equal((await call('GET', '/api/me')).json.name, 'Paolo');
    assert.equal((await call('POST', '/api/setup', { pin: '1111' })).status, 409);
  });

  it('rifiuta richieste da un altro sito (Origin)', async () => {
    const r = await call('POST', '/api/profile', { name: 'X' }, { origin: 'http://evil.example' });
    assert.equal(r.status, 403);
  });

  it('foto profilo: accetta solo immagini vere', async () => {
    assert.equal((await call('PUT', '/api/avatar/user', Buffer.from('non sono una foto'))).status, 400);
    assert.equal((await call('PUT', '/api/avatar/user', PNG)).status, 200);
    assert.ok((await call('GET', '/api/me')).json.avatars.user);
    assert.equal((await call('PUT', '/api/avatar/hacker', PNG)).status, 404);
    assert.equal((await call('DELETE', '/api/avatar/user')).status, 200);
  });

  it('discussione ibrida: parte, chiede una decisione, finisce, si scarica il rapporto', async () => {
    const c = await call('POST', '/api/sessions', { goal: 'Scegliere il database', mode: 'ibrida', maxTurns: 6 });
    assert.equal(c.status, 201);
    const id = c.json.id;
    await until(async () => (await call('GET', `/api/sessions/${id}`)).json.state === 'waiting_user');
    assert.equal((await call('POST', `/api/sessions/${id}/message`, { text: 'ciao' })).status, 409);
    assert.equal((await call('POST', `/api/sessions/${id}/decision`, { text: 'Solo Mac' })).status, 202);
    await until(async () => (await call('GET', `/api/sessions/${id}`)).json.state === 'finished');
    const d = (await call('GET', `/api/sessions/${id}`)).json;
    assert.ok(d.messages.length >= 4);
    assert.ok((await call('GET', '/api/sessions')).json.length >= 1);
    const rep = await call('GET', `/api/sessions/${id}/report.txt`);
    assert.match(rep.text, /RAPPORTO FINALE/);
    assert.equal((await call('POST', `/api/sessions/${id}/message`, { text: 'ancora?' })).status, 409);
  });

  it('modalità autonoma: non si può scrivere; diretta: domanda a un solo agente', async () => {
    const a = (await call('POST', '/api/sessions', { goal: 'Prova autonoma', mode: 'autonoma' })).json.id;
    assert.equal((await call('POST', `/api/sessions/${a}/message`, { text: 'ciao' })).status, 409);
    await call('POST', `/api/sessions/${a}/stop`, {});
    const b = (await call('POST', '/api/sessions', { goal: 'Prova diretta', mode: 'diretta' })).json.id;
    assert.equal((await call('POST', `/api/sessions/${b}/message`, { text: 'Che ne pensi?', to: 'claude' })).status, 202);
    await until(async () => (await call('GET', `/api/sessions/${b}`)).json.messages.some((m: any) => m.from === 'claude'));
    await call('POST', `/api/sessions/${b}/stop`, {});
  });

  it('blocco dopo 5 PIN sbagliati', async () => {
    await call('POST', '/api/logout', {});
    cookie = '';
    let last = 0;
    for (let i = 0; i < 5; i++) last = (await call('POST', '/api/login', { pin: '0000' })).status;
    assert.equal(last, 429);
    assert.equal((await call('POST', '/api/login', { pin: '4821' })).status, 429);
  });
});
