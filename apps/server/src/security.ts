import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface Settings {
  name: string;
  pin?: { salt: string; hash: string };
  failed: number;
  lockCount: number;
  lockedUntil: number;
  avatars: Record<string, string>;
}

const FRESH: Settings = { name: 'Paolo', failed: 0, lockCount: 0, lockedUntil: 0, avatars: {} };
const SESSION_MS = 12 * 3600_000;

/**
 * PIN di 4 cifre, salvato solo come impronta cifrata (scrypt con sale).
 * Dopo 5 errori consecutivi l'accesso si blocca: 5 minuti, poi 15, poi un'ora.
 */
export class Security {
  private readonly sessions = new Map<string, number>();

  constructor(
    private readonly path: string,
    private readonly now: () => number = Date.now,
  ) {}

  load(): Settings {
    try {
      return { ...FRESH, ...(JSON.parse(readFileSync(this.path, 'utf8')) as Partial<Settings>) };
    } catch {
      return { ...FRESH, avatars: {} };
    }
  }

  save(s: Settings): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
  }

  exists(): boolean {
    return existsSync(this.path);
  }
  hasPin(): boolean {
    return Boolean(this.load().pin);
  }
  name(): string {
    return this.load().name;
  }

  setName(name: string): void {
    const s = this.load();
    s.name = name.trim().slice(0, 40) || 'Paolo';
    this.save(s);
  }

  static validPin(pin: unknown): pin is string {
    return typeof pin === 'string' && /^\d{4}$/.test(pin);
  }

  private hash(pin: string, salt: Buffer): Buffer {
    return scryptSync(pin, salt, 32);
  }

  setPin(pin: string): void {
    if (!Security.validPin(pin)) throw new Error('Il PIN deve essere di 4 cifre.');
    const salt = randomBytes(16);
    const s = this.load();
    s.pin = { salt: salt.toString('hex'), hash: this.hash(pin, salt).toString('hex') };
    s.failed = 0;
    s.lockCount = 0;
    s.lockedUntil = 0;
    this.save(s);
  }

  verify(pin: unknown): { ok: boolean; retryAfterSec?: number; left?: number } {
    const s = this.load();
    const t = this.now();
    if (s.lockedUntil > t) return { ok: false, retryAfterSec: Math.ceil((s.lockedUntil - t) / 1000) };
    if (!s.pin || !Security.validPin(pin)) return { ok: false, left: Math.max(0, 5 - s.failed) };
    const good = timingSafeEqual(this.hash(pin, Buffer.from(s.pin.salt, 'hex')), Buffer.from(s.pin.hash, 'hex'));
    if (good) {
      s.failed = 0;
      s.lockCount = 0;
      this.save(s);
      return { ok: true };
    }
    s.failed += 1;
    if (s.failed >= 5) {
      const minutes = [5, 15, 60][Math.min(s.lockCount, 2)] as number;
      s.lockedUntil = t + minutes * 60_000;
      s.lockCount += 1;
      s.failed = 0;
      this.save(s);
      return { ok: false, retryAfterSec: minutes * 60 };
    }
    this.save(s);
    return { ok: false, left: 5 - s.failed };
  }

  issue(): string {
    const token = randomBytes(32).toString('hex');
    this.sessions.set(token, this.now() + SESSION_MS);
    return token;
  }

  check(token: string | undefined): boolean {
    if (!token) return false;
    const exp = this.sessions.get(token);
    if (!exp) return false;
    if (exp < this.now()) {
      this.sessions.delete(token);
      return false;
    }
    return true;
  }

  revoke(token: string | undefined): void {
    if (token) this.sessions.delete(token);
  }

  revokeAll(): void {
    this.sessions.clear();
  }
}
