import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { createLedger, LedgerError } from '../src/core/ledger.js';
import { initSchema, seedAccounts, openFiscalYear } from '../src/core/bas.js';
import { paymentVoucher } from '../src/core/api.js';

function setup(nowIso = '2026-12-05T10:00:00Z') {
  const db = new Database(':memory:');
  initSchema(db); seedAccounts(db); openFiscalYear(db, 2026);
  const ledger = createLedger(db, { now: () => new Date(nowIso) });
  return { db, ledger };
}
const pay = (id: string, net = 100000, vat = 25000, date = '2026-12-01') =>
  paymentVoucher({ paymentId: id, paidDate: date, invoiceNumber: 1001, netOre: net, vatOre: vat, revenueAccount: 3010 });
const code = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as LedgerError).code; } return 'NO_ERROR'; };

describe('postVoucher', () => {
  it('bokför balanserad verifikation med gapfria nummer', () => {
    const { ledger } = setup();
    expect(ledger.postVoucher(pay('p1')).number).toBe(1);
    expect(ledger.postVoucher(pay('p2')).number).toBe(2);
    expect(ledger.verifyIntegrity()).toEqual({ ok: true, problems: [] });
  });
  it('avvisar obalans, flyttal, okänt konto, noll och dubbelsidig rad', () => {
    const { ledger } = setup();
    const base = { series: 'A' as const, entryDate: '2026-12-01', description: 't' };
    expect(code(() => ledger.postVoucher({ ...base, lines: [{ account: 1930, debit: 100 }, { account: 3010, credit: 99 }] }))).toBe('UNBALANCED');
    expect(code(() => ledger.postVoucher({ ...base, lines: [{ account: 1930, debit: 10.5 }, { account: 3010, credit: 10.5 }] }))).toBe('BAD_AMOUNT');
    expect(code(() => ledger.postVoucher({ ...base, lines: [{ account: 1930, debit: 100 }, { account: 9999, credit: 100 }] }))).toBe('UNKNOWN_ACCOUNT');
    expect(code(() => ledger.postVoucher({ ...base, lines: [{ account: 1930, debit: 100, credit: 100 }, { account: 3010, credit: 0 }] }))).toBe('BAD_LINE');
    expect(code(() => ledger.postVoucher({ ...base, lines: [{ account: 1930, debit: 100 }] }))).toBe('TOO_FEW_LINES');
  });
  it('bränner inte nummer vid misslyckad bokning', () => {
    const { ledger } = setup();
    ledger.postVoucher(pay('p1'));
    expect(code(() => ledger.postVoucher({ series: 'A', entryDate: '2026-12-01', description: 't',
      lines: [{ account: 1930, debit: 100 }, { account: 9999, credit: 100 }] }))).toBe('UNKNOWN_ACCOUNT');
    expect(ledger.postVoucher(pay('p2')).number).toBe(2);
  });
  it('är idempotent per källa, men avvisar annat innehåll', () => {
    const { ledger, db } = setup();
    const a = ledger.postVoucher(pay('p1'));
    const b = ledger.postVoucher(pay('p1'));
    expect(b).toEqual(a);
    expect(db.prepare('SELECT COUNT(*) c FROM voucher').get()).toEqual({ c: 1 });
    expect(code(() => ledger.postVoucher(pay('p1', 200000, 50000)))).toBe('IDEMPOTENCY_CONFLICT');
  });
  it('avvisar serie K, saknat år och stängt år', () => {
    const { ledger, db } = setup();
    expect(code(() => ledger.postVoucher({ ...pay('x'), series: 'K' as never }))).toBe('BAD_SERIES');
    expect(code(() => ledger.postVoucher(pay('x', 1, 0, '2027-01-02')))).toBe('NO_FISCAL_YEAR');
    db.prepare("UPDATE fiscal_year SET closed_at='2027-02-01' WHERE id=1").run();
    expect(code(() => ledger.postVoucher(pay('y')))).toBe('YEAR_CLOSED');
  });
  it('numrerar per år och serie', () => {
    const { ledger, db } = setup();
    openFiscalYear(db, 2027);
    ledger.postVoucher(pay('p1'));
    expect(ledger.postVoucher({ ...pay('p2'), series: 'A', source: undefined }).number).toBe(1);
    expect(ledger.postVoucher(pay('p3', 100, 0, '2027-01-05')).number).toBe(1);
    expect(ledger.verifyIntegrity().ok).toBe(true);
  });
  it('sparar underlag med sha256', () => {
    const { ledger, db } = setup();
    const sha = 'a'.repeat(64);
    ledger.postVoucher({ ...pay('p1'), attachments: [{ sha256: sha, filename: 'f1001.pdf' }] });
    expect(db.prepare('SELECT sha256 FROM attachment').get()).toEqual({ sha256: sha });
    expect(code(() => ledger.postVoucher({ ...pay('p2'), attachments: [{ sha256: 'zz', filename: 'x' }] }))).toBe('BAD_ATTACHMENT');
    expect(db.prepare('SELECT COUNT(*) c FROM voucher').get()).toEqual({ c: 1 }); // rullad tillbaka
  });
});

describe('correctVoucher', () => {
  it('vänder originalet i serie K utan att röra det', () => {
    const { ledger, db } = setup();
    const orig = ledger.postVoucher(pay('p1'));
    const k = ledger.correctVoucher(orig.id, 'fel belopp');
    expect(k.series).toBe('K');
    const sums = db.prepare(`SELECT account_number a, SUM(debit)-SUM(credit) s FROM voucher_line GROUP BY account_number`).all() as { a: number; s: number }[];
    expect(sums.every(r => r.s === 0)).toBe(true);
    expect(db.prepare('SELECT corrects_voucher_id c FROM voucher WHERE id=?').get(k.id)).toEqual({ c: orig.id });
    expect(ledger.verifyIntegrity().ok).toBe(true);
  });
  it('vänder och bokar rätt i samma verifikation', () => {
    const { ledger, db } = setup();
    const orig = ledger.postVoucher(pay('p1'));
    const k = ledger.correctVoucher(orig.id, 'fel belopp', { ...pay('ignored', 90000, 22500), source: undefined, series: 'B' });
    const net = db.prepare('SELECT SUM(debit)-SUM(credit) s FROM voucher_line WHERE account_number=1930').get() as { s: number };
    expect(net.s).toBe(112500);
    expect(k.number).toBe(1);
  });
  it('kan inte rättas två gånger eller rätta en rättelse, och kräver orsak', () => {
    const { ledger } = setup();
    const o = ledger.postVoucher(pay('p1'));
    expect(code(() => ledger.correctVoucher(o.id, ' '))).toBe('NO_REASON');
    const k = ledger.correctVoucher(o.id, 'x');
    expect(code(() => ledger.correctVoucher(o.id, 'y'))).toBe('ALREADY_CORRECTED');
    expect(code(() => ledger.correctVoucher(k.id, 'z'))).toBe('CANNOT_CORRECT_CORRECTION');
    expect(code(() => ledger.correctVoucher(999, 'z'))).toBe('NOT_FOUND');
  });
  it('rättelse av verifikation i stängt år bokas i dagens öppna år', () => {
    const { ledger, db } = setup('2027-01-10T10:00:00Z');
    const o = ledger.postVoucher(pay('p1'));
    openFiscalYear(db, 2027);
    db.prepare("UPDATE fiscal_year SET closed_at='2027-01-09' WHERE id=1").run();
    const k = ledger.correctVoucher(o.id, 'upptäckt efter bokslut');
    expect(db.prepare('SELECT entry_date d FROM voucher WHERE id=?').get(k.id)).toEqual({ d: '2027-01-10' });
  });
});

describe('verifyIntegrity', () => {
  it('upptäcker manipulation som gjorts runt triggers', () => {
    const { ledger, db } = setup();
    ledger.postVoucher(pay('p1'));
    ledger.postVoucher(pay('p2'));
    db.exec('DROP TRIGGER line_no_update');
    db.prepare('UPDATE voucher_line SET debit = debit + 1 WHERE id = 1').run();
    const r = ledger.verifyIntegrity();
    expect(r.ok).toBe(false);
    expect(r.problems.join('\n')).toMatch(/hash stämmer inte/);
  });
  it('upptäcker lucka i nummerföljd', () => {
    const { ledger, db } = setup();
    ledger.postVoucher(pay('p1'));
    ledger.postVoucher(pay('p2'));
    db.exec('DROP TRIGGER voucher_no_delete; DROP TRIGGER line_no_delete');
    db.prepare('DELETE FROM voucher_line WHERE voucher_id=1').run();
    db.prepare('DELETE FROM voucher WHERE id=1').run();
    expect(ledger.verifyIntegrity().ok).toBe(false);
  });
});
