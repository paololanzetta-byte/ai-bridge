import { createServer } from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Accesso "Sign in with ChatGPT" (anteprima per app open source locali).
 * Da verificare dal vivo: nomi esatti dei parametri di rinnovo e della registrazione iniziale.
 * I token restano SOLO nel file delle credenziali (permessi 0600) e non vengono mai scritti in log o errori.
 */
export interface OpenAIAuthConfig {
  credentialsPath?: string;
  authorizeUrl?: string;
  tokenUrl?: string;
  issuer?: string;
  port?: number;
  fetchImpl?: typeof fetch;
  openBrowser?: (url: string) => void | Promise<void>;
  now?: () => number;
  loginTimeoutMs?: number;
}

export interface Credentials {
  hostId: string;
  clientId?: string;
  accessToken?: string;
  refreshToken?: string;
  /** istante di scadenza dell'access token, in millisecondi */
  expiresAt?: number;
}

const SCOPE = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const RESOURCE = 'https://api.openai.com/v1';
const DYNAMIC_CLIENT = 'dynamic_agent_client';
const RELOGIN_CODES = [
  'invalid_grant',
  'invalid_refresh_token',
  'token_expired',
  'refresh_token_expired',
  'refresh_token_invalidated',
  'refresh_token_reused',
];

const b64url = (b: Buffer) => b.toString('base64url');

export function defaultCredentialsPath(): string {
  return join(homedir(), '.config', 'ai-bridge', 'openai.json');
}

export class OpenAIAuth {
  private readonly path: string;
  private readonly authorizeUrl: string;
  private readonly tokenUrl: string;
  private readonly issuer: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly cfg: OpenAIAuthConfig = {}) {
    this.path = cfg.credentialsPath ?? defaultCredentialsPath();
    this.authorizeUrl = cfg.authorizeUrl ?? 'https://auth.openai.com/api/accounts/authorize';
    this.tokenUrl = cfg.tokenUrl ?? 'https://auth.openai.com/api/accounts/oauth/token';
    this.issuer = cfg.issuer ?? 'https://auth.openai.com';
    this.fetchImpl = cfg.fetchImpl ?? fetch;
    this.now = cfg.now ?? Date.now;
  }

  async load(): Promise<Credentials | undefined> {
    try {
      return JSON.parse(await readFile(this.path, 'utf8')) as Credentials;
    } catch {
      return undefined;
    }
  }

  private async save(c: Credentials): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(c, null, 2), { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, this.path);
  }

  async isLoggedIn(): Promise<boolean> {
    const c = await this.load();
    return Boolean(c?.refreshToken || c?.accessToken);
  }

  /** Accesso interattivo: apre il browser, attende il ritorno su 127.0.0.1 e salva i token. */
  async login(): Promise<void> {
    const saved = (await this.load()) ?? { hostId: `urn:uuid:${randomUUID()}` };
    await this.save(saved); // il codice dell'app va salvato PRIMA del primo accesso
    const firstTime = !saved.clientId;
    let clientId = saved.clientId ?? DYNAMIC_CLIENT;

    const verifier = b64url(randomBytes(32));
    const challenge = b64url(createHash('sha256').update(verifier).digest());
    const state = b64url(randomBytes(16));
    const nonce = b64url(randomBytes(16));

    const { port, result, close } = await this.listen(state);
    const redirectUri = `http://127.0.0.1:${port}/auth/callback`;
    try {
      const url = new URL(this.authorizeUrl);
      const p = url.searchParams;
      p.set('client_id', clientId);
      if (firstTime) p.set('agent_name_hint', 'AI Bridge');
      p.set('ext_agent_host_id', saved.hostId);
      p.set('response_type', 'code');
      p.set('redirect_uri', redirectUri);
      p.set('scope', SCOPE);
      p.set('resource', RESOURCE);
      p.set('state', state);
      p.set('nonce', nonce);
      p.set('code_challenge', challenge);
      p.set('code_challenge_method', 'S256');
      await (this.cfg.openBrowser ?? (() => undefined))(url.toString());

      const cb = await result;
      if (cb.error) throw new Error(`Accesso non completato (${cb.error}).`);
      if (!cb.code) throw new Error('Accesso non completato: codice mancante.');
      if (cb.clientId) clientId = cb.clientId;

      const tok = await this.tokenRequest({
        grant_type: 'authorization_code',
        client_id: clientId,
        code: cb.code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
        resource: RESOURCE,
      });
      const scopes = String(tok.scope ?? '').split(/\s+/);
      if (!scopes.includes('chatgpt.tokens.use.direct')) {
        throw new Error('Il tuo account non ha concesso il permesso di usare il piano ChatGPT (chatgpt.tokens.use.direct).');
      }
      this.checkIdToken(tok.id_token, clientId, nonce);
      await this.save({ ...saved, ...this.toStored(tok), clientId });
    } finally {
      close();
    }
  }

  /** Access token valido; lo rinnova se sta per scadere. */
  async getAccessToken(): Promise<string> {
    const c = await this.load();
    if (!c?.refreshToken && !c?.accessToken) throw new Error('Non hai ancora fatto l\'accesso a ChatGPT (npm run login:chatgpt).');
    if (c.accessToken && c.expiresAt && c.expiresAt - 60_000 > this.now()) return c.accessToken;
    if (!c.refreshToken || !c.clientId) throw new Error('Sessione ChatGPT scaduta: rifai l\'accesso (npm run login:chatgpt).');
    try {
      const tok = await this.tokenRequest({
        grant_type: 'refresh_token',
        client_id: c.clientId,
        refresh_token: c.refreshToken,
        resource: RESOURCE,
      });
      const next = { ...c, ...this.toStored(tok) };
      await this.save(next);
      return next.accessToken as string;
    } catch (e) {
      if (e instanceof AuthError && e.code && RELOGIN_CODES.includes(e.code)) {
        const { accessToken: _a, refreshToken: _r, expiresAt: _e, ...rest } = c;
        await this.save(rest);
        throw new Error('Sessione ChatGPT scaduta: rifai l\'accesso (npm run login:chatgpt).');
      }
      throw e;
    }
  }

  private toStored(tok: Record<string, unknown>): Partial<Credentials> {
    const expiresIn = Number(tok.expires_in ?? 3600);
    return {
      accessToken: String(tok.access_token),
      refreshToken: typeof tok.refresh_token === 'string' ? tok.refresh_token : undefined,
      expiresAt: this.now() + expiresIn * 1000,
    };
  }

  private async tokenRequest(params: Record<string, string>): Promise<Record<string, unknown>> {
    const res = await this.fetchImpl(this.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    });
    let body: Record<string, unknown> = {};
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      // corpo non JSON
    }
    if (!res.ok || typeof body.access_token !== 'string') {
      const code = typeof body.error === 'string' ? body.error : typeof (body.error as { code?: string })?.code === 'string' ? (body.error as { code: string }).code : undefined;
      throw new AuthError(`Errore di accesso a ChatGPT (HTTP ${res.status}${code ? `, ${code}` : ''})`, code);
    }
    return body;
  }

  /** Controlla emittente, destinatario, scadenza e nonce. La firma non viene verificata (token ricevuto direttamente via TLS). */
  private checkIdToken(idToken: unknown, clientId: string, nonce: string): void {
    if (typeof idToken !== 'string' || !idToken) return;
    let claims: { iss?: string; aud?: string | string[]; exp?: number; nonce?: string };
    try {
      claims = JSON.parse(Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString('utf8'));
    } catch {
      throw new Error('Token di identità non leggibile.');
    }
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.iss !== this.issuer) throw new Error('Token di identità: emittente inatteso.');
    if (!aud.includes(clientId)) throw new Error('Token di identità: destinatario inatteso.');
    if (typeof claims.exp === 'number' && claims.exp * 1000 < this.now()) throw new Error('Token di identità scaduto.');
    if (claims.nonce !== nonce) throw new Error('Token di identità: nonce non corrispondente.');
  }

  private listen(state: string): Promise<{
    port: number;
    result: Promise<{ code?: string; error?: string; clientId?: string }>;
    close: () => void;
  }> {
    return new Promise((resolveListen, rejectListen) => {
      let settle!: (v: { code?: string; error?: string; clientId?: string }) => void;
      let fail!: (e: Error) => void;
      const result = new Promise<{ code?: string; error?: string; clientId?: string }>((res, rej) => {
        settle = res;
        fail = rej;
      });
      result.catch(() => undefined);
      const server = createServer((req, res) => {
        const u = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (u.pathname !== '/auth/callback') {
          res.writeHead(404).end();
          return;
        }
        if (u.searchParams.get('state') !== state) {
          res.writeHead(400).end('Richiesta non valida.');
          return;
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<p>Accesso completato. Puoi chiudere questa scheda e tornare al Terminale.</p>');
        settle({
          code: u.searchParams.get('code') ?? undefined,
          error: u.searchParams.get('error') ?? undefined,
          clientId: u.searchParams.get('client_id') ?? undefined,
        });
      });
      const timer = setTimeout(() => fail(new Error('Tempo scaduto: accesso non completato.')), this.cfg.loginTimeoutMs ?? 300_000);
      const close = () => {
        clearTimeout(timer);
        server.close();
      };
      const start = (port: number, retry: boolean) => {
        server.once('error', (err: NodeJS.ErrnoException) => {
          if (retry && err.code === 'EADDRINUSE') start(0, false);
          else rejectListen(err);
        });
        server.listen(port, '127.0.0.1', () => {
          const addr = server.address();
          resolveListen({ port: typeof addr === 'object' && addr ? addr.port : port, result, close });
        });
      };
      start(this.cfg.port ?? 1455, this.cfg.port === undefined);
    });
  }
}

class AuthError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}
