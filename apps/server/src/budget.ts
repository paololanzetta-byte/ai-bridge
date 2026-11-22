import type { DatabaseSync } from 'node:sqlite';
import type { BudgetGate, Reservation } from '../../../packages/orchestrator/src/index.js';
import { Ledger, weekStart } from './ledger.js';

const EPS = 1e-9;

/**
 * Registro UNICO della spesa, nello stesso archivio SQLite delle discussioni.
 * Ogni chiamata a un servizio a pagamento prima RISERVA il costo massimo (in una transazione esclusiva: due
 * discussioni non possono impegnare lo stesso budget), poi chiude la prenotazione con il costo reale.
 * La settimana parte il lunedì. Il totale impegnato = speso + prenotato.
 * Nota onesta: è un tetto dell'app calcolato su prezzi noti; la fattura del fornitore resta separata.
 */
export class Budget {
  constructor(
    private readonly db: DatabaseSync,
    private readonly weeklyBudgetGbp: number,
    private readonly now: () => Date = () => new Date(),
  ) {
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec(`
      CREATE TABLE IF NOT EXISTS spend (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        week TEXT NOT NULL,
        status TEXT NOT NULL,            -- reserved | settled | released
        reserved_gbp REAL NOT NULL,
        actual_gbp REAL NOT NULL DEFAULT 0,
        note TEXT,
        created_at TEXT NOT NULL
      );
    `);
  }

  /** Impegnato nella settimana corrente: speso + prenotato. */
  weeklySpentGbp(): number {
    return this.committed(weekStart(this.now()));
  }

  private committed(week: string): number {
    const r = this.db
      .prepare(`SELECT COALESCE(SUM(CASE status WHEN 'reserved' THEN reserved_gbp WHEN 'settled' THEN actual_gbp ELSE 0 END), 0) AS t FROM spend WHERE week = ?`)
      .get(week) as { t: number };
    return Number(r.t);
  }

  /** Prenota il costo massimo; undefined se supererebbe il budget settimanale. Atomico anche tra più processi. */
  reserve(maxCostGbp: number, note = ''): Reservation | undefined {
    const max = Math.max(0, maxCostGbp);
    const week = weekStart(this.now());
    this.db.exec('BEGIN IMMEDIATE');
    let id: number;
    try {
      if (this.committed(week) + max > this.weeklyBudgetGbp + EPS) {
        this.db.exec('ROLLBACK');
        return undefined;
      }
      id = Number(
        this.db
          .prepare(`INSERT INTO spend (week, status, reserved_gbp, note, created_at) VALUES (?, 'reserved', ?, ?, ?)`)
          .run(week, max, note, this.now().toISOString()).lastInsertRowid,
      );
      this.db.exec('COMMIT');
    } catch (e) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // nessuna transazione aperta
      }
      throw e;
    }
    let closed = false;
    return {
      settle: (actual) => {
        if (closed) return;
        closed = true;
        this.db.prepare(`UPDATE spend SET status = 'settled', actual_gbp = ? WHERE id = ? AND status = 'reserved'`).run(Math.max(0, actual), id);
      },
      release: () => {
        if (closed) return;
        closed = true;
        this.db.prepare(`UPDATE spend SET status = 'released' WHERE id = ? AND status = 'reserved'`).run(id);
      },
    };
  }

  /** Spesa già avvenuta fuori da una discussione (es. prova della chiave). */
  record(gbp: number, note: string): void {
    this.db
      .prepare(`INSERT INTO spend (week, status, reserved_gbp, actual_gbp, note, created_at) VALUES (?, 'settled', ?, ?, ?, ?)`)
      .run(weekStart(this.now()), gbp, gbp, note, this.now().toISOString());
  }

  /** All'avvio: prenotazioni rimaste aperte (crash a metà chiamata) contano come spese, per prudenza. */
  settleOrphans(): number {
    const r = this.db.prepare(`UPDATE spend SET status = 'settled', actual_gbp = reserved_gbp, note = COALESCE(note,'') || ' (orfana)' WHERE status = 'reserved'`).run();
    return Number(r.changes);
  }

  /** Porta nel registro, una volta sola, la spesa del vecchio file ledger.json. */
  importLegacy(ledgerPath: string): void {
    const done = this.db.prepare(`SELECT 1 FROM spend WHERE note = 'import ledger.json' LIMIT 1`).get();
    if (done) return;
    const spent = new Ledger(ledgerPath).spent(this.now());
    this.db
      .prepare(`INSERT INTO spend (week, status, reserved_gbp, actual_gbp, note, created_at) VALUES (?, 'settled', ?, ?, 'import ledger.json', ?)`)
      .run(weekStart(this.now()), spent, spent, this.now().toISOString());
  }

  /** Il budget come lo vede il coordinatore. */
  gate(): BudgetGate {
    return { reserve: (max) => this.reserve(max), weeklySpentGbp: () => this.weeklySpentGbp() };
  }
}
