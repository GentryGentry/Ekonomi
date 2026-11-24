import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';

function setup() {
  const db = new Database(':memory:');
  db.exec(readFileSync(new URL('../src/core/schema.sql', import.meta.url), 'utf8'));
  db.prepare("INSERT INTO fiscal_year(id,start_date,end_date) VALUES (1,'2026-01-01','2026-12-31')").run();
  db.prepare("INSERT INTO account(number,name) VALUES (1930,'Företagskonto'),(3010,'Försäljning')").run();
  db.prepare(`INSERT INTO voucher(id,fiscal_year_id,series,number,entry_date,registered_at,description,prev_hash,hash)
              VALUES (1,1,'B',1,'2026-12-01','2026-12-01T10:00:00Z','Testbetalning','0','h1')`).run();
  db.prepare('INSERT INTO voucher_line(voucher_id,line_no,account_number,debit) VALUES (1,1,1930,10000)').run();
  db.prepare('INSERT INTO voucher_line(voucher_id,line_no,account_number,credit) VALUES (1,2,3010,10000)').run();
  return db;
}

describe('oföränderlig bokföring', () => {
  it('stoppar UPDATE och DELETE på verifikation och rader', () => {
    const db = setup();
    expect(() => db.prepare("UPDATE voucher SET description='x' WHERE id=1").run()).toThrow(/immutable/);
    expect(() => db.prepare('DELETE FROM voucher WHERE id=1').run()).toThrow(/immutable/);
    expect(() => db.prepare('UPDATE voucher_line SET debit=1 WHERE id=1').run()).toThrow(/immutable/);
    expect(() => db.prepare('DELETE FROM voucher_line WHERE id=1').run()).toThrow(/immutable/);
  });
  it('tillåter inte samma verifikationsnummer två gånger', () => {
    const db = setup();
    expect(() => db.prepare(`INSERT INTO voucher(fiscal_year_id,series,number,entry_date,registered_at,description,prev_hash,hash)
      VALUES (1,'B',1,'2026-12-02','2026-12-02T10:00:00Z','dubbel','h1','h2')`).run()).toThrow();
  });
  it('avvisar rad med både debet och kredit', () => {
    const db = setup();
    expect(() => db.prepare('INSERT INTO voucher_line(voucher_id,line_no,account_number,debit,credit) VALUES (1,3,1930,5,5)').run()).toThrow();
  });
});
