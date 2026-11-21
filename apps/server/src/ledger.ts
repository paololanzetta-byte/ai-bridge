import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Data (aaaa-mm-gg) del lunedì della settimana che contiene `d`, in ora locale. */
export function weekStart(d: Date): string {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const back = (x.getDay() + 6) % 7; // lunedì = 0
  x.setDate(x.getDate() - back);
  const mm = String(x.getMonth() + 1).padStart(2, '0');
  const dd = String(x.getDate()).padStart(2, '0');
  return `${x.getFullYear()}-${mm}-${dd}`;
}

interface Data {
  weekStart: string;
  spentGbp: number;
}

/** Registro della spesa settimanale, salvato in un file locale. Si azzera da solo ogni lunedì. */
export class Ledger {
  constructor(private readonly path: string) {}

  spent(now: Date = new Date()): number {
    const data = this.read();
    return data && data.weekStart === weekStart(now) ? data.spentGbp : 0;
  }

  add(gbp: number, now: Date = new Date()): number {
    const total = this.spent(now) + gbp;
    mkdirSync(dirname(this.path), { recursive: true });
    const data: Data = { weekStart: weekStart(now), spentGbp: total };
    writeFileSync(this.path, JSON.stringify(data, null, 2));
    return total;
  }

  private read(): Data | undefined {
    if (!existsSync(this.path)) return undefined;
    try {
      return JSON.parse(readFileSync(this.path, 'utf8')) as Data;
    } catch {
      return undefined;
    }
  }
}
