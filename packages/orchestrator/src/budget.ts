import type { BudgetGate, Reservation } from './types.js';

const EPS = 1e-9;

/** Budget in memoria (prove e uso senza archivio): stesso comportamento di quello SQLite, ma non condiviso. */
export class MemoryBudget implements BudgetGate {
  private committed: number;

  constructor(
    private readonly weeklyBudgetGbp: number,
    alreadySpentGbp = 0,
  ) {
    this.committed = alreadySpentGbp;
  }

  reserve(maxCostGbp: number): Reservation | undefined {
    const max = Math.max(0, maxCostGbp);
    if (this.committed + max > this.weeklyBudgetGbp + EPS) return undefined;
    this.committed += max;
    let closed = false;
    return {
      settle: (actual) => {
        if (closed) return;
        closed = true;
        this.committed += Math.max(0, actual) - max;
      },
      release: () => {
        if (closed) return;
        closed = true;
        this.committed -= max;
      },
    };
  }

  weeklySpentGbp(): number {
    return this.committed;
  }
}
