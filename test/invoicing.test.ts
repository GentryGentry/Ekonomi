import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { createLedger } from '../src/core/ledger.js';
import { initSchema, seedAccounts, openFiscalYear } from '../src/core/bas.js';
import { InvoicingService, initInvoicingSchema, InvoicingError } from '../src/invoicing/service.js';
import { divRound, lineNet, totals, splitPayment, formatOre } from '../src/invoicing/money.js';

// Allt här är påhittat. Ingen riktig kund- eller medlemsdata.
function setup(opts: { cashText?: string | null } = {}) {
  const db = new Database(':memory:');
  initSchema(db); seedAccounts(db); openFiscalYear(db, 2026); initInvoicingSchema(db);
  const ledger = createLedger(db, { now: () => new Date('2026-12-05T10:00:00Z') });
  const svc = new InvoicingService(db, ledger);
  const issuerId = svc.createIssuer({
    name: 'Testfirma Enskild', addressLines: ['Testvägen 1', '123 45 Teststad'], vatNumber: 'SE000000000001',
    fSkatt: true, cashMethod: true, cashMethodText: opts.cashText === null ? undefined : (opts.cashText ?? 'TESTTEXT kontantmetod'),
    paymentDays: 30, firstNumber: 1001, bankgiro: '000-0000', contactEmail: 'test@example.invalid',
  });
  const customerId = svc.createCustomer({ name: 'Brf Testet', orgNumber: '000000-0000', addressLines: ['Brfvägen 2', '123 45 Teststad'], reference: 'Test Testsson' });
  svc.seedArticles(new URL('../config/articles.seed.json', import.meta.url));
  return { db, ledger, svc, issuerId, customerId };
}
async function issued(s: ReturnType<typeof setup>, date = '2026-12-01') {
  const id = s.svc.createDraft({ issuerId: s.issuerId, customerId: s.customerId });
  s.svc.addLine(id, { articleCode: 'STANDARD', qty: 1 });
  s.svc.addLine(id, { articleCode: 'STARTAVGIFT', qty: 1 });
  const r = await s.svc.issue(id, { invoiceDate: date, deliveryDate: date });
  return { id, ...r };
}
const code = async (fn: () => unknown) => { try { await fn(); } catch (e) { return (e as InvoicingError).code ?? (e as Error).message; } return 'NO_ERROR'; };

describe('pengar och moms', () => {
  it('avrundar halv upp, symmetriskt för negativa', () => {
    expect(divRound(5, 2)).toBe(3); expect(divRound(-5, 2)).toBe(-3); expect(divRound(4, 3)).toBe(1);
  });
  it('räknar moms en gång per momssats', () => {
    // 3 rader à 0,10 kr (10 öre) med 25 %: per-rad-avrundning vore 3×3=9, per summa 30*0,25=7,5 → 8
    const t = totals([1, 2, 3].map(() => ({ qtyMilli: 1000, unitPriceOre: 10, vatRate: 25 })));
    expect(t).toMatchObject({ netOre: 30, vatOre: 8, grossOre: 38 });
  });
  it('räknar brutto för paketet enligt Grund (handräknat)', () => {
    // 699 + 2900 = 3599 kr netto, moms 899,75 kr, brutto 4498,75 kr
    const t = totals([{ qtyMilli: 1000, unitPriceOre: 69900, vatRate: 25 }, { qtyMilli: 1000, unitPriceOre: 290000, vatRate: 25 }]);
    expect(t).toMatchObject({ netOre: 359900, vatOre: 89975, grossOre: 449875 });
  });
  it('antal i tusendelar', () => { expect(lineNet({ qtyMilli: 1500, unitPriceOre: 10001, vatRate: 25 })).toBe(15002); });
  it('delbetalningar summerar exakt till fakturan', () => {
    const gross = 449875, vat = 89975;
    let paid = 0, paidVat = 0;
    for (const a of [100001, 100001, 249873]) {
      const s = splitPayment({ amountOre: a, invoiceGrossOre: gross, invoiceVatOre: vat, paidSoFarOre: paid, paidVatSoFarOre: paidVat });
      expect(s.netOre + s.vatOre).toBe(a);
      paid += a; paidVat += s.vatOre;
    }
    expect(paid).toBe(gross); expect(paidVat).toBe(vat);
  });
  it('avvisar överbetalning', () => {
    expect(() => splitPayment({ amountOre: 101, invoiceGrossOre: 100, invoiceVatOre: 20, paidSoFarOre: 0, paidVatSoFarOre: 0 })).toThrow();
  });
  it('formaterar öre', () => { expect(formatOre(449875)).toBe('4 498,75'); expect(formatOre(-5)).toBe('-0,05'); });
});

describe('utfärda faktura', () => {
  it('numrerar från 1001 utan luckor och ger ingen verifikation', async () => {
    const s = setup();
    const a = await issued(s); const b = await issued(s);
    expect([a.number, b.number]).toEqual([1001, 1002]);
    expect((s.db.prepare('SELECT COUNT(*) c FROM voucher').get() as any).c).toBe(0);
  });
  it('förfallodatum = fakturadatum + betalningsvillkor från utfärdaren', async () => {
    const s = setup(); const a = await issued(s, '2026-12-01');
    expect((s.db.prepare('SELECT due_date d FROM invoice WHERE id=?').get(a.id) as any).d).toBe('2026-12-31');
  });
  it('bränner inget nummer när utfärdandet misslyckas', async () => {
    const s = setup();
    const empty = s.svc.createDraft({ issuerId: s.issuerId, customerId: s.customerId });
    expect(await code(() => s.svc.issue(empty, { invoiceDate: '2026-12-01', deliveryDate: '2026-12-01' }))).toBe('NO_LINES');
    expect(await code(() => s.svc.issue(empty, { invoiceDate: '2026-13-01', deliveryDate: 'x' }))).toBe('BAD_DATE');
    expect((await issued(s)).number).toBe(1001);
  });
  it('kräver verifierad kontantmetodtext, ingen standardtext', async () => {
    const s = setup({ cashText: null });
    const id = s.svc.createDraft({ issuerId: s.issuerId, customerId: s.customerId });
    s.svc.addLine(id, { articleCode: 'PLUS', qty: 1 });
    expect(await code(() => s.svc.issue(id, { invoiceDate: '2026-12-01', deliveryDate: '2026-12-01' }))).toBe('CASH_METHOD_TEXT_MISSING');
  });
  it('kräver leveransdatum', async () => {
    const s = setup();
    const id = s.svc.createDraft({ issuerId: s.issuerId, customerId: s.customerId });
    s.svc.addLine(id, { articleCode: 'PLUS', qty: 1 });
    expect(await code(() => s.svc.issue(id, { invoiceDate: '2026-12-01', deliveryDate: ' ' }))).toBe('NO_DELIVERY_DATE');
  });
  it('avvisar momssatser som kärnan inte kan bokföra', () => {
    const s = setup();
    const id = s.svc.createDraft({ issuerId: s.issuerId, customerId: s.customerId });
    expect(() => s.svc.addLine(id, { description: 'x', qty: 1, unitPriceOre: 100, vatRate: 6, revenueAccount: 3010 })).toThrow(/VAT_RATE_UNSUPPORTED/);
  });
  it('utfärdad faktura och rader är oföränderliga i databasen', async () => {
    const s = setup(); const a = await issued(s);
    expect(() => s.db.prepare("UPDATE invoice SET due_date='2027-01-01' WHERE id=?").run(a.id)).toThrow(/immutable/);
    expect(() => s.db.prepare('DELETE FROM invoice WHERE id=?').run(a.id)).toThrow(/immutable/);
    expect(() => s.db.prepare('UPDATE invoice_line SET qty_milli=2000 WHERE invoice_id=?').run(a.id)).toThrow(/immutable/);
    expect(() => s.db.prepare('DELETE FROM invoice_line WHERE invoice_id=?').run(a.id)).toThrow(/immutable/);
    expect(() => s.db.prepare("INSERT INTO invoice_line(invoice_id,line_no,description,unit,qty_milli,unit_price_ore,vat_rate,revenue_account) VALUES (?,9,'x','st',1000,1,25,3010)").run(a.id)).toThrow(/issued/);
  });
  it('nummerserien kan inte hoppa eller backa', async () => {
    const s = setup(); await issued(s);
    expect(() => s.db.prepare('UPDATE number_series SET next_number=9999').run()).toThrow(/forward/);
    expect(() => s.db.prepare('UPDATE number_series SET next_number=1001').run()).toThrow(/forward/);
  });
  it('PDF är deterministisk, innehåller lagkrav och sha256 matchar lagrad fil', async () => {
    const s1 = setup(); const s2 = setup();
    const a = await issued(s1); const b = await issued(s2);
    expect(a.pdfSha256).toBe(b.pdfSha256);
    const pdf = s1.svc.getPdf(a.id);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    const { createHash } = await import('node:crypto');
    expect(createHash('sha256').update(pdf).digest('hex')).toBe(a.pdfSha256);
  });
});

describe('betalning och bokföring', () => {
  it('betalning ger verifikat i serie B med rätt belopp', async () => {
    const s = setup(); const a = await issued(s);
    const v = s.svc.recordPayment({ paymentId: 'p1', invoiceId: a.id, paidDate: '2026-12-10', amountOre: 449875 });
    expect(v.voucherNumber).toBe(1);
    const lines = s.db.prepare('SELECT account_number a, debit d, credit c FROM voucher_line ORDER BY line_no').all();
    expect(lines).toEqual([{ a: 1930, d: 449875, c: 0 }, { a: 3010, d: 0, c: 359900 }, { a: 2611, d: 0, c: 89975 }]);
    expect(s.svc.outstandingOre(a.id)).toBe(0);
    expect(s.ledger.verifyIntegrity().ok).toBe(true);
  });
  it('samma betalnings-id bokförs aldrig två gånger', async () => {
    const s = setup(); const a = await issued(s);
    const v1 = s.svc.recordPayment({ paymentId: 'p1', invoiceId: a.id, paidDate: '2026-12-10', amountOre: 100000 });
    const v2 = s.svc.recordPayment({ paymentId: 'p1', invoiceId: a.id, paidDate: '2026-12-10', amountOre: 100000 });
    expect(v2.voucherId).toBe(v1.voucherId);
    expect((s.db.prepare('SELECT COUNT(*) c FROM voucher').get() as any).c).toBe(1);
    expect((s.db.prepare('SELECT COUNT(*) c FROM payment').get() as any).c).toBe(1);
    expect(await code(() => s.svc.recordPayment({ paymentId: 'p1', invoiceId: a.id, paidDate: '2026-12-10', amountOre: 5 }))).toBe('PAYMENT_ID_REUSED');
  });
  it('delbetalningar ger flera verifikat och summan blir exakt fakturan', async () => {
    const s = setup(); const a = await issued(s);
    for (const [id, amt] of [['p1', 100001], ['p2', 100001], ['p3', 249873]] as const)
      s.svc.recordPayment({ paymentId: id, invoiceId: a.id, paidDate: '2026-12-10', amountOre: amt });
    const sums = s.db.prepare("SELECT SUM(credit) c FROM voucher_line WHERE account_number=2611").get() as any;
    expect(sums.c).toBe(89975);
    expect(s.svc.outstandingOre(a.id)).toBe(0);
    expect(await code(() => s.svc.recordPayment({ paymentId: 'p4', invoiceId: a.id, paidDate: '2026-12-11', amountOre: 1 }))).toBe('BAD_PAYMENT');
  });
  it('kraschåterhämtning: sparad betalning utan verifikat bokförs vid omförsök', async () => {
    const s = setup(); const a = await issued(s);
    s.db.prepare('INSERT INTO payment(id,invoice_id,paid_date,amount_ore,net_ore,vat_ore) VALUES (?,?,?,?,?,?)').run('p1', a.id, '2026-12-10', 449875, 359900, 89975);
    const v = s.svc.recordPayment({ paymentId: 'p1', invoiceId: a.id, paidDate: '2026-12-10', amountOre: 449875 });
    expect(v.voucherNumber).toBe(1);
    expect((s.db.prepare('SELECT voucher_id v FROM payment').get() as any).v).toBe(v.voucherId);
  });
  it('låter bokföringsfel (stängt år) slå igenom utan att markera betalningen bokförd', async () => {
    const s = setup(); const a = await issued(s);
    s.db.prepare("UPDATE fiscal_year SET closed_at='2027-01-31'").run();
    expect(() => s.svc.recordPayment({ paymentId: 'p1', invoiceId: a.id, paidDate: '2026-12-10', amountOre: 100 })).toThrow(/stängt/);
    expect((s.db.prepare('SELECT voucher_id v FROM payment').get() as any).v).toBeNull();
    expect(s.svc.unbookedPayments().map(p => p.id)).toEqual(['p1']);
  });
  it('avvisar betalning före fakturadatum och betalning på utkast', async () => {
    const s = setup(); const a = await issued(s, '2026-12-05');
    expect(await code(() => s.svc.recordPayment({ paymentId: 'x', invoiceId: a.id, paidDate: '2026-12-01', amountOre: 100 }))).toBe('PAID_BEFORE_INVOICE');
    const d = s.svc.createDraft({ issuerId: s.issuerId, customerId: s.customerId });
    expect(await code(() => s.svc.recordPayment({ paymentId: 'y', invoiceId: d, paidDate: '2026-12-10', amountOre: 100 }))).toBe('NOT_PAYABLE');
  });
});

describe('kreditfaktura och påminnelse', () => {
  it('kreditfaktura får eget nummer, nollar utestående och skapar inget verifikat för obetald faktura', async () => {
    const s = setup(); const a = await issued(s);
    const c = await s.svc.createCreditNote(a.id, { creditDate: '2026-12-15' });
    expect(c.number).toBe(1002);
    expect(s.svc.outstandingOre(a.id)).toBe(0);
    expect((s.db.prepare('SELECT COUNT(*) c FROM voucher').get() as any).c).toBe(0);
    expect(s.svc.invoiceTotals(c.creditId)).toMatchObject({ grossOre: -449875, vatOre: -89975 });
    expect(await code(() => s.svc.createCreditNote(a.id, { creditDate: '2026-12-16' }))).toBe('ALREADY_CREDITED');
  });
  it('betald och krediterad faktura visar återbetalning som återstår (negativt belopp)', async () => {
    const s = setup(); const a = await issued(s);
    s.svc.recordPayment({ paymentId: 'p1', invoiceId: a.id, paidDate: '2026-12-10', amountOre: 449875 });
    await s.svc.createCreditNote(a.id, { creditDate: '2026-12-15' });
    expect(s.svc.listOpen('2026-12-20')).toEqual([expect.objectContaining({ number: 1001, outstandingOre: -449875 })]);
  });
  it('påminnelse bara efter förfallodatum och för utestående belopp', async () => {
    const s = setup(); openFiscalYear(s.db, 2027); const a = await issued(s, '2026-12-01');
    expect(await code(() => s.svc.createReminder(a.id, { reminderDate: '2026-12-31', newDueDate: '2027-01-10' }))).toBe('NOT_OVERDUE');
    const r = await s.svc.createReminder(a.id, { reminderDate: '2027-01-02', newDueDate: '2027-01-12' });
    expect(r.pdfSha256).toMatch(/^[0-9a-f]{64}$/);
    s.svc.recordPayment({ paymentId: 'p1', invoiceId: a.id, paidDate: '2027-01-03', amountOre: 449875 });
    expect(await code(() => s.svc.createReminder(a.id, { reminderDate: '2027-01-20', newDueDate: '2027-01-30' }))).toBe('NOT_OUTSTANDING');
    expect(() => s.db.prepare('DELETE FROM reminder').run()).toThrow(/immutable/);
  });
});

describe('utfärdare som data', () => {
  it('ny utfärdare (AB) får egen serie som börjar om', async () => {
    const s = setup(); await issued(s);
    const ab = s.svc.createIssuer({ name: 'Test AB', addressLines: ['x'], vatNumber: 'SE000000000002', fSkatt: true, cashMethod: false, paymentDays: 30, firstNumber: 1 });
    const id = s.svc.createDraft({ issuerId: ab, customerId: s.customerId });
    s.svc.addLine(id, { articleCode: 'PLUS', qty: 1 });
    expect((await s.svc.issue(id, { invoiceDate: '2027-01-02', deliveryDate: '2027-01-02' })).number).toBe(1);
  });
});
