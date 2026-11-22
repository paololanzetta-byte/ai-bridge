import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import {
  Orchestrator,
  buildReport,
  reportToText,
  type Adapter,
  type AgentId,
  type State,
  type StopReason,
} from '../../../packages/orchestrator/src/index.js';
import { Budget } from './budget.js';
import { Security } from './security.js';
import { Store } from './store.js';

/** Errore con un messaggio scritto per l'utente (si può mostrare così com'è). */
export class UserError extends Error {}

/** Il server si apre solo sul Mac stesso (127.0.0.1): per il telefono si usa Tailscale Serve. */
export function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

export type Mode = 'autonoma' | 'diretta' | 'ibrida';
const MODES: Mode[] = ['autonoma', 'diretta', 'ibrida'];
const WHO = ['user', 'claude', 'chatgpt'] as const;
type Who = (typeof WHO)[number];

export interface AppOptions {
  dataDir: string;
  publicDir: string;
  weeklyBudgetGbp: number;
  makeAdapters: () => Promise<Record<AgentId, Adapter>>;
  status?: () => Promise<{ claude: boolean; chatgpt: boolean }>;
  demo?: boolean;
  estimatedCostPerTurnGbp?: number;
  now?: () => number;
}

export const TEMPLATES = [
  { id: 'tecnologia', titolo: 'Scegli la tecnologia', testo: 'Quale tecnologia è la scelta migliore per: ' },
  { id: 'piano', titolo: 'Rivedi un piano', testo: 'Rivedete criticamente questo piano e indicate i punti deboli: ' },
  { id: 'proscontro', titolo: 'Pro e contro', testo: 'Elencate pro e contro di questa opzione: ' },
  { id: 'rischi', titolo: 'Cerca i rischi', testo: 'Quali sono i rischi principali di questa idea e come ridurli: ' },
  { id: 'decisione', titolo: 'Prepara una decisione', testo: 'Preparate le opzioni e una raccomandazione per decidere su: ' },
];

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};
const IMAGE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };
const COOKIE = 'ai_bridge_session';
const MAX_IMAGE = 2 * 1024 * 1024;

interface Live {
  orch: Orchestrator;
  mode: Mode;
  maxTurns: number;
}

function sniffImage(b: Buffer): 'png' | 'jpg' | 'webp' | undefined {
  if (b.length > 12 && b.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return 'png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.length > 12 && b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP') return 'webp';
  return undefined;
}

export function createApp(opts: AppOptions) {
  mkdirSync(opts.dataDir, { recursive: true });
  const now = opts.now ?? Date.now;
  const security = new Security(join(opts.dataDir, 'settings.json'), now);
  const store = new Store(join(opts.dataDir, 'ai-bridge.db'));
  store.closeOrphans();
  const budget = new Budget(store.database, opts.weeklyBudgetGbp, () => new Date(now()));
  budget.settleOrphans();
  budget.importLegacy(join(opts.dataDir, 'ledger.json'));
  const avatarDir = join(opts.dataDir, 'avatars');
  const live = new Map<number, Live>();
  const clients = new Set<ServerResponse>();
  const publicRoot = resolve(opts.publicDir);

  const broadcast = (id: number) => {
    for (const c of clients) c.write(`event: update\ndata: ${id}\n\n`);
  };

  // ---------- utilità HTTP ----------
  const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    const isBuf = Buffer.isBuffer(body);
    const payload = isBuf ? body : typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, {
      'content-type': isBuf || typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...headers,
    });
    res.end(payload);
  };
  const fail = (res: ServerResponse, status: number, message: string) => send(res, status, { error: message });

  const readBody = (req: IncomingMessage, limit: number): Promise<Buffer> =>
    new Promise((resolveBody, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > limit) {
          reject(new UserError('Il file è troppo grande.'));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => resolveBody(Buffer.concat(chunks)));
      req.on('error', reject);
    });

  const readJson = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
    const raw = await readBody(req, 64 * 1024);
    if (!raw.length) return {};
    try {
      const v = JSON.parse(raw.toString('utf8')) as unknown;
      return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
    } catch {
      throw new UserError('Richiesta non valida.');
    }
  };

  const cookieOf = (req: IncomingMessage): string | undefined => {
    const m = /(?:^|;\s*)ai_bridge_session=([a-f0-9]+)/.exec(req.headers.cookie ?? '');
    return m?.[1];
  };
  // Fuori da 127.0.0.1 (cioè dietro Tailscale Serve, che è HTTPS) il cookie viaggia solo su connessioni protette.
  const secureFlag = (req: IncomingMessage): string => {
    const host = (req.headers.host ?? '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    return isLoopbackHost(host) ? '' : '; Secure';
  };
  const setCookie = (token: string, req: IncomingMessage) => `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${12 * 3600}${secureFlag(req)}`;
  const clearCookie = `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;

  // ---------- dati ----------
  const level = (): 'ok' | '50' | '80' | 'tetto' => {
    const r = budget.weeklySpentGbp() / opts.weeklyBudgetGbp;
    return r >= 1 ? 'tetto' : r >= 0.8 ? '80' : r >= 0.5 ? '50' : 'ok';
  };

  const avatarsInfo = (): Record<Who, string | null> => {
    const s = security.load();
    const out = { user: null, claude: null, chatgpt: null } as Record<Who, string | null>;
    for (const w of WHO) {
      const ext = s.avatars[w];
      const f = ext ? join(avatarDir, `${w}.${ext}`) : '';
      out[w] = ext && existsSync(f) ? String(Math.floor(statSync(f).mtimeMs)) : null;
    }
    return out;
  };

  const detail = (id: number) => {
    const s = store.getSession(id);
    if (!s) return undefined;
    const l = live.get(id);
    const messages = store.timedMessages(id);
    const report = buildReport(s.goal, messages, s.state as State, (s.stopReason ?? undefined) as StopReason | undefined, s.turns, s.spentGbp);
    return {
      id: s.id,
      goal: s.goal,
      state: l ? l.orch.state : s.state,
      stopReason: l ? (l.orch.stopReason ?? null) : s.stopReason,
      turns: l ? l.orch.turnsDone : s.turns,
      maxTurns: l?.maxTurns ?? null,
      spentGbp: l ? l.orch.spentGbp : s.spentGbp,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      live: Boolean(l),
      mode: l?.mode ?? null,
      question: l?.orch.question ?? null,
      messages: messages.map((m, i) => ({ seq: i, from: m.from, to: m.to, kind: m.kind, tag: m.tag ?? null, text: m.text, at: m.at })),
      report,
    };
  };

  const listing = () =>
    store.listSessions(100).map((s) => {
      const last = store.lastMessage(s.id);
      const l = live.get(s.id);
      return {
        id: s.id,
        goal: s.goal,
        state: l ? l.orch.state : s.state,
        turns: s.turns,
        startedAt: s.startedAt,
        live: Boolean(l),
        preview: last?.text.slice(0, 140) ?? '',
        at: last?.at ?? s.startedAt,
      };
    });

  const background = (p: Promise<unknown>) => {
    p.catch(() => undefined);
  };

  const createSession = async (goal: string, mode: Mode, maxTurns: number): Promise<number> => {
    if (level() === 'tetto') throw new UserError('Il tetto di spesa settimanale è già raggiunto.');
    const adapters = await opts.makeAdapters();
    const orch = new Orchestrator(adapters, {
      maxTurns,
      weeklyBudgetGbp: opts.weeklyBudgetGbp,
      budget: budget.gate(),
      estimatedCostPerTurnGbp: opts.estimatedCostPerTurnGbp ?? (opts.demo ? 0 : 0.02),
    });
    const { sessionId } = store.attach(orch, goal);
    const l: Live = { orch, mode, maxTurns };
    live.set(sessionId, l);
    orch.onChange(() => broadcast(sessionId));
    orch.start(goal);
    if (mode === 'diretta') orch.pause();
    else background(orch.run());
    return sessionId;
  };

  const getLive = (res: ServerResponse, id: number): Live | undefined => {
    const l = live.get(id);
    if (!l) fail(res, 409, 'Questa discussione è archiviata: si può solo leggere.');
    return l;
  };

  // ---------- percorsi ----------
  const api = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> => {
    const method = req.method ?? 'GET';
    const path = url.pathname;

    if (method !== 'GET' && method !== 'HEAD') {
      const origin = req.headers.origin;
      if (origin) {
        let host = '';
        try {
          host = new URL(origin).host;
        } catch {
          // origine illeggibile
        }
        if (host !== req.headers.host) return fail(res, 403, 'Richiesta non consentita.');
      }
    }

    // pubblici
    if (method === 'GET' && path === '/api/public') {
      return send(res, 200, {
        hasPin: security.hasPin(),
        authed: security.check(cookieOf(req)),
        name: security.name(),
        avatar: avatarsInfo().user,
      });
    }
    if (method === 'POST' && path === '/api/setup') {
      if (security.hasPin()) return fail(res, 409, 'Il PIN è già impostato.');
      const body = await readJson(req);
      if (!Security.validPin(body.pin)) return fail(res, 400, 'Il PIN deve essere di 4 cifre.');
      security.setPin(body.pin);
      return send(res, 200, { ok: true }, { 'set-cookie': setCookie(security.issue(), req) });
    }
    if (method === 'POST' && path === '/api/login') {
      const body = await readJson(req);
      const r = security.verify(body.pin);
      if (r.ok) return send(res, 200, { ok: true }, { 'set-cookie': setCookie(security.issue(), req) });
      if (r.retryAfterSec) return send(res, 429, { error: 'Troppi tentativi.', retryAfterSec: r.retryAfterSec });
      return send(res, 401, { error: 'PIN errato.', left: r.left ?? 0 });
    }
    if (method === 'POST' && path === '/api/logout') {
      security.revoke(cookieOf(req));
      return send(res, 200, { ok: true }, { 'set-cookie': clearCookie });
    }

    // da qui serve il PIN
    if (!security.check(cookieOf(req))) return fail(res, 401, 'Accesso richiesto.');

    if (method === 'GET' && path === '/api/me') {
      const spent = budget.weeklySpentGbp();
      return send(res, 200, {
        name: security.name(),
        demo: Boolean(opts.demo),
        avatars: avatarsInfo(),
        budget: { weekly: opts.weeklyBudgetGbp, spent, level: level() },
        templates: TEMPLATES,
        connections: opts.status ? await opts.status() : { claude: true, chatgpt: true },
      });
    }
    if (method === 'POST' && path === '/api/profile') {
      const body = await readJson(req);
      if (typeof body.name !== 'string' || !body.name.trim()) return fail(res, 400, 'Scrivi un nome.');
      security.setName(body.name);
      return send(res, 200, { ok: true });
    }
    if (method === 'POST' && path === '/api/pin') {
      const body = await readJson(req);
      if (!Security.validPin(body.next)) return fail(res, 400, 'Il nuovo PIN deve essere di 4 cifre.');
      const r = security.verify(body.current);
      if (!r.ok) return fail(res, r.retryAfterSec ? 429 : 401, r.retryAfterSec ? 'Troppi tentativi: riprova più tardi.' : 'Il PIN attuale non è corretto.');
      security.setPin(body.next);
      return send(res, 200, { ok: true });
    }

    const av = /^\/api\/avatar\/(user|claude|chatgpt)$/.exec(path);
    if (av) {
      const who = av[1] as Who;
      if (method === 'GET') {
        const s = security.load();
        const ext = s.avatars[who];
        const f = ext ? join(avatarDir, `${who}.${ext}`) : '';
        if (!ext || !existsSync(f)) return fail(res, 404, 'Nessuna foto.');
        res.writeHead(200, { 'content-type': IMAGE_TYPES[ext] ?? 'application/octet-stream', 'cache-control': 'private, max-age=0, must-revalidate', 'x-content-type-options': 'nosniff' });
        createReadStream(f).pipe(res);
        return;
      }
      if (method === 'PUT') {
        const data = await readBody(req, MAX_IMAGE);
        const ext = sniffImage(data);
        if (!ext) return fail(res, 400, 'Formato non valido: usa PNG, JPG o WebP.');
        mkdirSync(avatarDir, { recursive: true });
        for (const e of Object.keys(IMAGE_TYPES)) rmSync(join(avatarDir, `${who}.${e}`), { force: true });
        writeFileSync(join(avatarDir, `${who}.${ext}`), data, { mode: 0o600 });
        const s = security.load();
        s.avatars[who] = ext;
        security.save(s);
        return send(res, 200, { ok: true });
      }
      if (method === 'DELETE') {
        const s = security.load();
        for (const e of Object.keys(IMAGE_TYPES)) rmSync(join(avatarDir, `${who}.${e}`), { force: true });
        delete s.avatars[who];
        security.save(s);
        return send(res, 200, { ok: true });
      }
    }

    if (method === 'GET' && path === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-content-type-options': 'nosniff' });
      res.write('retry: 2000\n\n');
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
      req.on('close', () => {
        clearInterval(ping);
        clients.delete(res);
      });
      return;
    }

    if (method === 'GET' && path === '/api/sessions') return send(res, 200, listing());
    if (method === 'POST' && path === '/api/sessions') {
      const body = await readJson(req);
      const goal = typeof body.goal === 'string' ? body.goal.trim() : '';
      if (goal.length < 5) return fail(res, 400, 'Scrivi un obiettivo per la discussione (almeno qualche parola).');
      if (goal.length > 2000) return fail(res, 400, 'L\'obiettivo è troppo lungo.');
      const mode = MODES.includes(body.mode as Mode) ? (body.mode as Mode) : 'ibrida';
      const maxTurns = Math.min(30, Math.max(2, Number(body.maxTurns) || 6));
      const id = await createSession(goal, mode, maxTurns);
      return send(res, 201, { id });
    }

    const m = /^\/api\/sessions\/(\d+)(?:\/([a-z.]+))?$/.exec(path);
    if (m) {
      const id = Number(m[1]);
      const action = m[2];
      if (!store.getSession(id)) return fail(res, 404, 'Discussione non trovata.');
      if (method === 'GET' && !action) return send(res, 200, detail(id));
      if (method === 'GET' && action === 'report.txt') {
        const d = detail(id);
        const text = reportToText(d!.report);
        return send(res, 200, text, { 'content-disposition': `attachment; filename="rapporto-${id}.txt"` });
      }
      if (method === 'POST') {
        const body = await readJson(req);
        if (action === 'message') {
          const l = getLive(res, id);
          if (!l) return;
          const text = typeof body.text === 'string' ? body.text.trim() : '';
          if (!text) return fail(res, 400, 'Scrivi un messaggio.');
          if (text.length > 4000) return fail(res, 400, 'Il messaggio è troppo lungo.');
          const to = body.to === 'claude' || body.to === 'chatgpt' ? (body.to as AgentId) : 'both';
          const st = l.orch.state;
          if (l.mode === 'autonoma') return fail(res, 409, 'In modalità Autonoma non puoi scrivere: metti in pausa o passa a Ibrida o Diretta.');
          if (st === 'waiting_user') return fail(res, 409, 'Prima rispondi alla decisione richiesta.');
          if (l.mode === 'diretta') {
            if (st === 'running') return fail(res, 409, 'Metti in pausa la discussione prima di fare una domanda diretta.');
            const targets: AgentId[] = to === 'both' ? ['claude', 'chatgpt'] : [to];
            background(
              (async () => {
                for (const t of targets) await l.orch.ask(t, text);
              })(),
            );
            return send(res, 202, { ok: true });
          }
          if (st === 'finished' || st === 'stopped') return fail(res, 409, 'La discussione è chiusa: passa a Diretta per fare domande.');
          l.orch.sendUserMessage(text, to === 'both' ? [] : [to]);
          if (st === 'paused') background(l.orch.resume());
          return send(res, 202, { ok: true });
        }
        if (action === 'decision') {
          const l = getLive(res, id);
          if (!l) return;
          const text = typeof body.text === 'string' ? body.text.trim() : '';
          if (!text) return fail(res, 400, 'Scrivi la tua decisione.');
          if (l.orch.state !== 'waiting_user') return fail(res, 409, 'Nessuna decisione in attesa.');
          background(l.orch.answerDecision(text));
          return send(res, 202, { ok: true });
        }
        if (action === 'pause' || action === 'resume' || action === 'stop') {
          const l = getLive(res, id);
          if (!l) return;
          if (action === 'pause') l.orch.pause();
          else if (action === 'stop') l.orch.stop();
          else background(l.orch.resume());
          return send(res, 202, { ok: true });
        }
        if (action === 'mode') {
          const l = getLive(res, id);
          if (!l) return;
          if (!MODES.includes(body.mode as Mode)) return fail(res, 400, 'Modalità non valida.');
          const next = body.mode as Mode;
          const prev = l.mode;
          l.mode = next;
          if (next === 'diretta' && l.orch.state === 'running') l.orch.pause();
          if (prev === 'diretta' && next !== 'diretta' && l.orch.state === 'paused') background(l.orch.resume());
          broadcast(id);
          return send(res, 200, { ok: true });
        }
      }
    }
    return fail(res, 404, 'Non trovato.');
  };

  const serveStatic = (res: ServerResponse, path: string) => {
    const rel = path === '/' ? 'index.html' : path.replace(/^\/+/, '');
    const file = normalize(join(publicRoot, rel));
    if (file !== publicRoot && !file.startsWith(publicRoot + sep)) return fail(res, 404, 'Non trovato.');
    if (!existsSync(file) || !statSync(file).isFile()) return fail(res, 404, 'Non trovato.');
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
    });
    createReadStream(file).pipe(res);
  };

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    res.setHeader('content-security-policy', "default-src 'self'; img-src 'self' blob: data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('x-frame-options', 'DENY');
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      api(req, res, url).catch((e: unknown) => {
        if (res.headersSent) return;
        if (e instanceof UserError) fail(res, 400, e.message);
        else fail(res, 500, 'Errore interno.');
      });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'Metodo non consentito.');
    serveStatic(res, url.pathname);
  };

  const files = () => (existsSync(publicRoot) ? readdirSync(publicRoot) : []);
  const close = () => {
    for (const c of clients) c.end();
    clients.clear();
    store.close();
  };
  return { handler, close, security, store, budget, files, readFileSync };
}
