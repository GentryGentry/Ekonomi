import type Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';

/**
 * Minimal BAS-kontoplan för enskild firma (kontantmetoden). Utkast: konsult bekräftar (D-009).
 * Kontoplanen utökas via addAccount; konton raderas aldrig.
 */
export const BAS_SEED: ReadonlyArray<readonly [number, string]> = [
  [1930, 'Företagskonto / checkkonto'],
  [2013, 'Egna uttag'],
  [2018, 'Egna insättningar'],
  [2010, 'Eget kapital'],
  [2611, 'Utgående moms 25 %'],
  [2621, 'Utgående moms 12 %'],
  [2631, 'Utgående moms 6 %'],
  [2641, 'Ingående moms'],
  [2650, 'Redovisningskonto för moms'],
  [3001, 'Försäljning inom Sverige, 25 % moms'],
  [3010, 'Försäljning tjänster, 25 % moms'],
  [3740, 'Öres- och kronutjämning'],
  [5410, 'Förbrukningsinventarier'],
  [5800, 'Resekostnader'],
  [6110, 'Kontorsmaterial'],
  [6540, 'IT-tjänster'],
  [6570, 'Bankkostnader'],
  [8999, 'Årets resultat'],
];

export function initSchema(db: Database.Database): void {
  db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
}

export function seedAccounts(db: Database.Database): void {
  const ins = db.prepare('INSERT OR IGNORE INTO account(number, name) VALUES (?, ?)');
  db.transaction(() => { for (const [n, name] of BAS_SEED) ins.run(n, name); })();
}

/** Kalenderår. Räkenskapsår = kalenderår för enskild firma. */
export function openFiscalYear(db: Database.Database, year: number): number {
  const r = db.prepare('INSERT INTO fiscal_year(start_date, end_date) VALUES (?, ?)')
    .run(`${year}-01-01`, `${year}-12-31`);
  return Number(r.lastInsertRowid);
}
