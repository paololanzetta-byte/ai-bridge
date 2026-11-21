import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { reportToText, type Message, type Orchestrator } from '../../../packages/orchestrator/src/index.js';

export interface SessionRow {
  id: number;
  goal: string;
  state: string;
  stopReason: string | null;
  turns: number;
  spentGbp: number;
  startedAt: string;
  endedAt: string | null;
  reportText: string | null;
}

/** Archivio locale (un solo file SQLite, gratuito, senza server). Conserva conversazioni e rapporti. */
export class Store {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        goal TEXT NOT NULL,
        state TEXT NOT NULL,
        stop_reason TEXT,
        turns INTEGER NOT NULL DEFAULT 0,
        spent_gbp REAL NOT NULL DEFAULT 0,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        report_text TEXT
      );
      CREATE TABLE IF NOT EXISTS messages (
        session_id INTEGER NOT NULL REFERENCES sessions(id),
        seq INTEGER NOT NULL,
        sender TEXT NOT NULL,
        recipients TEXT NOT NULL,
        kind TEXT NOT NULL,
        tag TEXT,
        text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (session_id, seq)
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  createSession(goal: string, now: Date = new Date()): number {
    const r = this.db
      .prepare("INSERT INTO sessions (goal, state, started_at) VALUES (?, 'idle', ?)")
      .run(goal, now.toISOString());
    return Number(r.lastInsertRowid);
  }

  /**
   * Salva la sessione man mano che procede: ogni cambiamento del coordinatore aggiorna stato e nuovi messaggi.
   * Restituisce l'id della sessione e una funzione per chiudere il collegamento.
   */
  attach(orch: Orchestrator, goal: string): { sessionId: number; detach: () => void } {
    const sessionId = this.createSession(goal);
    let saved = 0;
    const sync = () => {
      const h: readonly Message[] = orch.history();
      for (; saved < h.length; saved++) this.addMessage(sessionId, saved, h[saved] as Message);
      const over = orch.state === 'finished' || orch.state === 'stopped';
      this.db
        .prepare('UPDATE sessions SET state = ?, stop_reason = ?, turns = ?, spent_gbp = ?, ended_at = ?, report_text = ? WHERE id = ?')
        .run(
          orch.state,
          orch.stopReason ?? null,
          orch.turnsDone,
          orch.spentGbp,
          over ? new Date().toISOString() : null,
          over ? reportToText(orch.report()) : null,
          sessionId,
        );
    };
    const detach = orch.onChange(sync);
    sync();
    return { sessionId, detach };
  }

  private addMessage(sessionId: number, seq: number, m: Message): void {
    this.db
      .prepare('INSERT OR REPLACE INTO messages (session_id, seq, sender, recipients, kind, tag, text, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(sessionId, seq, m.from, JSON.stringify(m.to), m.kind, m.tag ?? null, m.text, new Date().toISOString());
  }

  listSessions(limit = 20): SessionRow[] {
    return (this.db.prepare('SELECT * FROM sessions ORDER BY id DESC LIMIT ?').all(limit) as Record<string, unknown>[]).map(toSession);
  }

  getSession(id: number): SessionRow | undefined {
    const r = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return r ? toSession(r) : undefined;
  }

  messages(sessionId: number): Message[] {
    const rows = this.db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY seq').all(sessionId) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: Number(r.seq) + 1,
      from: r.sender as Message['from'],
      to: JSON.parse(String(r.recipients)) as Message['to'],
      text: String(r.text),
      kind: r.kind as Message['kind'],
      ...(r.tag ? { tag: r.tag as NonNullable<Message['tag']> } : {}),
    }));
  }
}

function toSession(r: Record<string, unknown>): SessionRow {
  return {
    id: Number(r.id),
    goal: String(r.goal),
    state: String(r.state),
    stopReason: (r.stop_reason as string | null) ?? null,
    turns: Number(r.turns),
    spentGbp: Number(r.spent_gbp),
    startedAt: String(r.started_at),
    endedAt: (r.ended_at as string | null) ?? null,
    reportText: (r.report_text as string | null) ?? null,
  };
}
