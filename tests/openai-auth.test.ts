import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, statSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { OpenAIAuth } from '../apps/server/src/openai-auth.js';

const servers: Server[] = [];
after(() => servers.forEach((s) => s.close()));

const jwt = (claims: object) => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`;

interface Fake {
  url: string;
  requests: URLSearchParams[];
  next: { status: number; body: Record<string, unknown> }[];
}

function fakeToken(): Promise<Fake> {
  const f: Fake = { url: '', requests: [], next: [] };
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      f.requests.push(new URLSearchParams(raw));
      const n = f.next.shift() ?? { status: 500, body: {} };
      res.writeHead(n.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(n.body));
    });
  });
  servers.push(server);
  return new Promise((r) =>
    server.listen(0, '127.0.0.1', () => {
      f.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/token`;
      r(f);
    }),
  );
}

const path = () => join(mkdtempSync(join(tmpdir(), 'aib-')), 'sub', 'openai.json');

/** Simula il browser: legge l'URL di autorizzazione e richiama il ritorno su 127.0.0.1. */
function browser(extra: (u: URL) => string, seen: { url?: URL }) {
  return async (url: string) => {
    const u = new URL(url);
    seen.url = u;
    const cb = new URL(u.searchParams.get('redirect_uri') as string);
    cb.searchParams.set('state', u.searchParams.get('state') as string);
    for (const [k, v] of new URLSearchParams(extra(u))) cb.searchParams.set(k, v);
    setTimeout(() => void fetch(cb).catch(() => undefined), 20);
  };
}

describe('OpenAIAuth', () => {
  it('accesso: PKCE, scope, salvataggio 0600 e client id emesso', async () => {
    const f = await fakeToken();
    const seen: { url?: URL } = {};
    const file = path();
    const auth = new OpenAIAuth({
      credentialsPath: file,
      tokenUrl: f.url,
      port: 0,
      openBrowser: browser(() => 'code=abc&client_id=oaiapp_xyz', seen),
    });
    f.next.push({
      status: 200,
      body: {
        access_token: 'AT1',
        refresh_token: 'RT1',
        expires_in: 3600,
        scope: 'openid chatgpt.tokens.use.direct',
        id_token: '',
      },
    });
    await auth.login();
    const u = seen.url as URL;
    assert.equal(u.searchParams.get('client_id'), 'dynamic_agent_client');
    assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
    assert.match(u.searchParams.get('redirect_uri') ?? '', /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
    assert.match(u.searchParams.get('ext_agent_host_id') ?? '', /^urn:uuid:/);
    assert.ok((u.searchParams.get('scope') ?? '').includes('chatgpt.tokens.use.direct'));
    const req = f.requests[0] as URLSearchParams;
    const challenge = createHash('sha256').update(req.get('code_verifier') as string).digest('base64url');
    assert.equal(challenge, u.searchParams.get('code_challenge'));
    assert.equal(req.get('client_id'), 'oaiapp_xyz');
    assert.equal(req.get('code'), 'abc');
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).clientId, 'oaiapp_xyz');
    assert.equal(await auth.getAccessToken(), 'AT1');
  });

  it('rifiuta se manca lo scope del piano o se l\'utente nega', async () => {
    const f = await fakeToken();
    const noScope = new OpenAIAuth({ credentialsPath: path(), tokenUrl: f.url, port: 0, openBrowser: browser(() => 'code=abc', {}) });
    f.next.push({ status: 200, body: { access_token: 'A', scope: 'openid' } });
    await assert.rejects(noScope.login(), /permesso/);
    const denied = new OpenAIAuth({ credentialsPath: path(), tokenUrl: f.url, port: 0, openBrowser: browser(() => 'error=access_denied', {}) });
    await assert.rejects(denied.login(), /access_denied/);
  });

  it('controlla il nonce del token di identità', async () => {
    const f = await fakeToken();
    const auth = new OpenAIAuth({ credentialsPath: path(), tokenUrl: f.url, port: 0, openBrowser: browser(() => 'code=abc&client_id=oaiapp_1', {}) });
    f.next.push({
      status: 200,
      body: {
        access_token: 'A',
        scope: 'chatgpt.tokens.use.direct',
        id_token: jwt({ iss: 'https://auth.openai.com', aud: 'oaiapp_1', exp: 9999999999, nonce: 'sbagliato' }),
      },
    });
    await assert.rejects(auth.login(), /nonce/);
  });

  it('rinnova il token scaduto e ruota il refresh token', async () => {
    const f = await fakeToken();
    let now = 1_000_000;
    const file = path();
    const auth = new OpenAIAuth({ credentialsPath: file, tokenUrl: f.url, port: 0, now: () => now, openBrowser: browser(() => 'code=abc&client_id=oaiapp_1', {}) });
    f.next.push({ status: 200, body: { access_token: 'AT1', refresh_token: 'RT1', expires_in: 3600, scope: 'chatgpt.tokens.use.direct' } });
    await auth.login();
    now += 3_600_000;
    f.next.push({ status: 200, body: { access_token: 'AT2', refresh_token: 'RT2', expires_in: 3600 } });
    assert.equal(await auth.getAccessToken(), 'AT2');
    assert.equal(f.requests[1]?.get('grant_type'), 'refresh_token');
    assert.equal(f.requests[1]?.get('refresh_token'), 'RT1');
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).refreshToken, 'RT2');
  });

  it('rinnovo fallito: cancella i token e chiede un nuovo accesso', async () => {
    const f = await fakeToken();
    let now = 1_000_000;
    const file = path();
    const auth = new OpenAIAuth({ credentialsPath: file, tokenUrl: f.url, port: 0, now: () => now, openBrowser: browser(() => 'code=abc&client_id=oaiapp_1', {}) });
    f.next.push({ status: 200, body: { access_token: 'AT1', refresh_token: 'RT1', expires_in: 60, scope: 'chatgpt.tokens.use.direct' } });
    await auth.login();
    now += 3_600_000;
    f.next.push({ status: 400, body: { error: 'invalid_grant' } });
    await assert.rejects(auth.getAccessToken(), /rifai l'accesso/);
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(saved.refreshToken, undefined);
    assert.equal(saved.clientId, 'oaiapp_1');
    assert.equal(await auth.isLoggedIn(), false);
  });
});
