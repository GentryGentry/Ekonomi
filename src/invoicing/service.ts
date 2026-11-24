import type Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { paymentVoucher, type LedgerCore } from '../core/api.js';
import { splitPayment, totals, type MoneyLine, type Totals } from './money.js';
import { renderInvoicePdf, renderReminderPdf, sha256, type InvoicePdfData } from './pdf.js';

type Db = Database.Database;

/** Momssatser som fakturering tillåter just nu. Kärnans paymentVoucher() bokar bara 25 % (konto 2611). */
export const SUPPORTED_VAT_RATES = [25];

export class InvoicingError extends Error {
  constructor(public code: string, message: string) { super(`${code}: ${message}`); }
}

export function initInvoicingSchema(db: Db): void {
  db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
}

const isoDate = /^\d{4}-\d{2}-\d{2}$/;
function assertDate(s: string, what: string) {
  if (!isoDate.test(s) || Number.isNaN(Date.parse(s + 'T00:00:00Z'))) throw new InvoicingError('BAD_DATE', `${what}: ${s}`);
}
export function addDays(date: string, days: number): string {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export interface IssuerInput {
  name: string; addressLines: string[]; vatNumber: string; orgNumber?: string; fSkatt: boolean;
  cashMethod: boolean; cashMethodText?: string; paymentDays: number; firstNumber: number;
  bankgiro?: string; bankAccount?: string; contactEmail?: string;
}
export interface CustomerInput { name: string; orgNumber?: string; addressLines: string[]; reference?: string; email?: string }
export interface ArticleInput { code: string; description: string; unit?: string; unitPriceOre: number; vatRate: number; revenueAccount: number }

export class InvoicingService {
  constructor(private db: Db, private ledger: LedgerCore) {}

  // ---------- stamdata ----------
  createIssuer(i: IssuerInput): number {
    return this.db.transaction(() => {
      const id = Number(this.db.prepare(`INSERT INTO issuer(name,address_lines,vat_number,org_number,f_skatt,cash_method,cash_method_text,
        payment_days,first_number,bankgiro,bank_account,contact_email) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(i.name, i.addressLines.join('\n'), i.vatNumber, i.orgNumber ?? null, +i.fSkatt, +i.cashMethod, i.cashMethodText ?? null,
          i.paymentDays, i.firstNumber, i.bankgiro ?? null, i.bankAccount ?? null, i.contactEmail ?? null).lastInsertRowid);
      this.db.prepare('INSERT INTO number_series(issuer_id,next_number) VALUES (?,?)').run(id, i.firstNumber);
      return id;
    })();
  }

  createCustomer(c: CustomerInput): number {
    return Number(this.db.prepare('INSERT INTO customer(name,org_number,address_lines,reference,email) VALUES (?,?,?,?,?)')
      .run(c.name, c.orgNumber ?? null, c.addressLines.join('\n'), c.reference ?? null, c.email ?? null).lastInsertRowid);
  }

  createArticle(a: ArticleInput): number {
    this.assertRate(a.vatRate);
    return Number(this.db.prepare('INSERT INTO article(code,description,unit,unit_price_ore,vat_rate,revenue_account) VALUES (?,?,?,?,?,?)')
      .run(a.code, a.description, a.unit ?? 'st', a.unitPriceOre, a.vatRate, a.revenueAccount).lastInsertRowid);
  }

  /** Läser artiklar från en seedfil (config/articles.seed.json). Priserna kommer från Notion Grund, inte från kod. */
  seedArticles(file: URL | string): number {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { articles: (ArticleInput & { code: string })[] };
    let n = 0;
    for (const a of parsed.articles) {
      if (this.db.prepare('SELECT 1 FROM article WHERE code=?').get(a.code)) continue;
      this.createArticle(a); n++;
    }
    return n;
  }

  private assertRate(rate: number) {
    if (!SUPPORTED_VAT_RATES.includes(rate))
      throw new InvoicingError('VAT_RATE_UNSUPPORTED', `Momssats ${rate} % stöds inte än (kärnan bokar bara ${SUPPORTED_VAT_RATES.join(', ')} %)`);
  }

  // ---------- utkast ----------
  createDraft(args: { issuerId: number; customerId: number; customerReference?: string }): number {
    return Number(this.db.prepare(`INSERT INTO invoice(issuer_id,customer_id,kind,status,customer_reference) VALUES (?,?, 'invoice','draft',?)`)
      .run(args.issuerId, args.customerId, args.customerReference ?? null).lastInsertRowid);
  }

  addLine(invoiceId: number, l: { articleCode?: string; description?: string; unit?: string; qty: number; unitPriceOre?: number; vatRate?: number; revenueAccount?: number }): void {
    const art = l.articleCode
      ? this.db.prepare('SELECT * FROM article WHERE code=? AND active=1').get(l.articleCode) as any
      : undefined;
    if (l.articleCode && !art) throw new InvoicingError('NO_ARTICLE', l.articleCode);
    const description = l.description ?? art?.description;
    const unitPrice = l.unitPriceOre ?? art?.unit_price_ore;
    const vatRate = l.vatRate ?? art?.vat_rate;
    const account = l.revenueAccount ?? art?.revenue_account;
    if (description == null || unitPrice == null || vatRate == null || account == null)
      throw new InvoicingError('INCOMPLETE_LINE', 'beskrivning, pris, momssats och intäktskonto krävs (direkt eller via artikel)');
    this.assertRate(vatRate);
    const qtyMilli = Math.round(l.qty * 1000);
    if (qtyMilli <= 0) throw new InvoicingError('BAD_QTY', 'antal måste vara > 0');
    const next = (this.db.prepare('SELECT COALESCE(MAX(line_no),0)+1 n FROM invoice_line WHERE invoice_id=?').get(invoiceId) as any).n;
    this.db.prepare(`INSERT INTO invoice_line(invoice_id,line_no,article_code,description,unit,qty_milli,unit_price_ore,vat_rate,revenue_account)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(invoiceId, next, l.articleCode ?? null, description, l.unit ?? art?.unit ?? 'st', qtyMilli, unitPrice, vatRate, account);
  }

  // ---------- utfärda ----------
  /**
   * Utfärdar ett utkast: tilldelar nästa nummer, räknar förfallodatum, renderar och fryser PDF + sha256
   * i EN transaktion. Misslyckas något (t.ex. PDF) rullas numret tillbaka, så serien förblir gapfri.
   * Ingen verifikation skapas (kontantmetoden, D-006).
   */
  async issue(invoiceId: number, args: { invoiceDate: string; deliveryDate: string }): Promise<{ number: number; pdfSha256: string }> {
    assertDate(args.invoiceDate, 'fakturadatum');
    if (!args.deliveryDate.trim()) throw new InvoicingError('NO_DELIVERY_DATE', 'leveransdatum eller period krävs på fakturan');
    // PDF renderas före transaktionen (async), men numret är känt först i den. Därför reserverar vi nästa nummer
    // under BEGIN IMMEDIATE, renderar, och skriver. Eftersom better-sqlite3 är synkron låser vi genom att
    // räkna ut numret, rendera, och verifiera att numret fortfarande är det förväntade vid skrivning.
    const inv = this.loadInvoice(invoiceId);
    if (inv.status !== 'draft') throw new InvoicingError('NOT_DRAFT', `faktura ${inv.number} är redan utfärdad`);
    const lines = this.loadLines(invoiceId);
    if (lines.length === 0) throw new InvoicingError('NO_LINES', 'fakturan saknar rader');
    this.assertSingleRevenueAccount(lines);
    const issuer = this.loadIssuer(inv.issuer_id);
    if (issuer.cash_method && !issuer.cash_method_text?.trim())
      throw new InvoicingError('CASH_METHOD_TEXT_MISSING', 'utfärdaren använder kontantmetoden men saknar verifierad fakturatext (öppen punkt mot Skatteverket)');
    const customer = this.loadCustomer(inv.customer_id);

    const expected = (this.db.prepare('SELECT next_number n FROM number_series WHERE issuer_id=?').get(inv.issuer_id) as any).n as number;
    const dueDate = addDays(args.invoiceDate, issuer.payment_days);
    const pdfData = this.pdfData(inv, issuer, customer, lines, { number: expected, invoiceDate: args.invoiceDate, deliveryDate: args.deliveryDate, dueDate });
    const pdf = await renderInvoicePdf(pdfData);
    const hash = sha256(pdf);

    this.db.transaction(() => {
      const cur = (this.db.prepare('SELECT next_number n FROM number_series WHERE issuer_id=?').get(inv.issuer_id) as any).n as number;
      if (cur !== expected) throw new InvoicingError('NUMBER_RACE', 'nummerserien ändrades under utfärdandet, försök igen');
      this.db.prepare(`UPDATE invoice SET status='issued', number=?, invoice_date=?, delivery_date=?, due_date=?, issued_at=?, pdf_sha256=?, pdf=?
        WHERE id=? AND status='draft'`).run(expected, args.invoiceDate, args.deliveryDate, dueDate, args.invoiceDate, hash, Buffer.from(pdf), invoiceId);
      this.db.prepare('UPDATE number_series SET next_number=next_number+1 WHERE issuer_id=?').run(inv.issuer_id);
    }).immediate();
    return { number: expected, pdfSha256: hash };
  }

  // ---------- betalning ----------
  /**
   * Registrerar en (del)betalning och bokför den via kärnan (idempotent på paymentId).
   * Kraschar processen efter att betalningen sparats men före bokföring, kan anropet göras om med samma paymentId:
   * kärnan bokar aldrig samma (source_type, source_id) två gånger.
   */
  recordPayment(args: { paymentId: string; invoiceId: number; paidDate: string; amountOre: number }): { voucherId: number; voucherNumber: number } {
    assertDate(args.paidDate, 'betaldatum');
    const inv = this.loadInvoice(args.invoiceId);
    if (inv.status !== 'issued' || inv.kind !== 'invoice') throw new InvoicingError('NOT_PAYABLE', 'bara utfärdade fakturor kan betalas');
    if (args.paidDate < inv.invoice_date) throw new InvoicingError('PAID_BEFORE_INVOICE', 'betaldatum före fakturadatum');
    const lines = this.loadLines(args.invoiceId);
    const account = this.assertSingleRevenueAccount(lines);

    let payment = this.db.prepare('SELECT * FROM payment WHERE id=?').get(args.paymentId) as any;
    if (payment) {
      if (payment.invoice_id !== args.invoiceId || payment.amount_ore !== args.amountOre || payment.paid_date !== args.paidDate)
        throw new InvoicingError('PAYMENT_ID_REUSED', `betalnings-id ${args.paymentId} finns redan med andra uppgifter`);
    } else {
      const eff = this.effectiveTotals(args.invoiceId);
      const paid = this.db.prepare('SELECT COALESCE(SUM(amount_ore),0) a, COALESCE(SUM(vat_ore),0) v FROM payment WHERE invoice_id=?').get(args.invoiceId) as any;
      let split;
      try {
        split = splitPayment({ amountOre: args.amountOre, invoiceGrossOre: eff.grossOre, invoiceVatOre: eff.vatOre, paidSoFarOre: paid.a, paidVatSoFarOre: paid.v });
      } catch (e) { throw new InvoicingError('BAD_PAYMENT', (e as Error).message); }
      this.db.prepare('INSERT INTO payment(id,invoice_id,paid_date,amount_ore,net_ore,vat_ore) VALUES (?,?,?,?,?,?)')
        .run(args.paymentId, args.invoiceId, args.paidDate, args.amountOre, split.netOre, split.vatOre);
      payment = this.db.prepare('SELECT * FROM payment WHERE id=?').get(args.paymentId);
    }

    const posted = this.ledger.postVoucher(paymentVoucher({
      paymentId: payment.id, paidDate: payment.paid_date, invoiceNumber: inv.number,
      netOre: payment.net_ore, vatOre: payment.vat_ore, revenueAccount: account,
    }));
    if (payment.voucher_id == null)
      this.db.prepare('UPDATE payment SET voucher_id=?, voucher_number=? WHERE id=?').run(posted.id, `${posted.series}${posted.number}`, payment.id);
    return { voucherId: posted.id, voucherNumber: posted.number };
  }

  // ---------- kreditfaktura ----------
  /**
   * Fullständig kreditfaktura mot en utfärdad faktura. Eget nummer i samma serie.
   * Skapar inget verifikat: obetald faktura ger ingen bokföring, och återbetalning av betalt belopp
   * kräver postRefund i kärnan (saknas i api.ts, se docs/FAKTURERING.md, öppna punkter).
   */
  async createCreditNote(invoiceId: number, args: { creditDate: string }): Promise<{ number: number; pdfSha256: string; creditId: number }> {
    assertDate(args.creditDate, 'kreditdatum');
    const orig = this.loadInvoice(invoiceId);
    if (orig.status !== 'issued' || orig.kind !== 'invoice') throw new InvoicingError('NOT_CREDITABLE', 'bara utfärdade fakturor kan krediteras');
    const already = this.db.prepare(`SELECT 1 FROM invoice WHERE credits_invoice_id=?`).get(invoiceId);
    if (already) throw new InvoicingError('ALREADY_CREDITED', `faktura ${orig.number} är redan krediterad`);
    if (args.creditDate < orig.invoice_date) throw new InvoicingError('BAD_DATE', 'kreditdatum före fakturadatum');
    const creditId = Number(this.db.prepare(`INSERT INTO invoice(issuer_id,customer_id,kind,credits_invoice_id,status,customer_reference)
      VALUES (?,?,'credit',?,'draft',?)`).run(orig.issuer_id, orig.customer_id, invoiceId, orig.customer_reference).lastInsertRowid);
    // Raderna kopieras med negativt antal (CHECK i schemat kräver qty <> 0, inte > 0).
    for (const l of this.loadLines(invoiceId))
      this.db.prepare(`INSERT INTO invoice_line(invoice_id,line_no,article_code,description,unit,qty_milli,unit_price_ore,vat_rate,revenue_account)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(creditId, l.line_no, l.article_code, l.description, l.unit, -l.qty_milli, l.unit_price_ore, l.vat_rate, l.revenue_account);
    const r = await this.issueCredit(creditId, args.creditDate, orig.delivery_date);
    return { ...r, creditId };
  }

  private async issueCredit(creditId: number, date: string, deliveryDate: string) {
    // Samma utfärdandelogik som faktura, men utan förfallodatum-krav (kreditfaktura har inget betalningsvillkor).
    const inv = this.loadInvoice(creditId);
    const lines = this.loadLines(creditId);
    const issuer = this.loadIssuer(inv.issuer_id);
    if (issuer.cash_method && !issuer.cash_method_text?.trim())
      throw new InvoicingError('CASH_METHOD_TEXT_MISSING', 'utfärdaren saknar verifierad fakturatext');
    const customer = this.loadCustomer(inv.customer_id);
    const orig = this.loadInvoice(inv.credits_invoice_id);
    const expected = (this.db.prepare('SELECT next_number n FROM number_series WHERE issuer_id=?').get(inv.issuer_id) as any).n as number;
    const pdf = await renderInvoicePdf({ ...this.pdfData(inv, issuer, customer, lines, { number: expected, invoiceDate: date, deliveryDate, dueDate: date }), creditsNumber: orig.number });
    const hash = sha256(pdf);
    this.db.transaction(() => {
      const cur = (this.db.prepare('SELECT next_number n FROM number_series WHERE issuer_id=?').get(inv.issuer_id) as any).n as number;
      if (cur !== expected) throw new InvoicingError('NUMBER_RACE', 'nummerserien ändrades, försök igen');
      this.db.prepare(`UPDATE invoice SET status='issued', number=?, invoice_date=?, delivery_date=?, due_date=?, issued_at=?, pdf_sha256=?, pdf=? WHERE id=? AND status='draft'`)
        .run(expected, date, deliveryDate, date, date, hash, Buffer.from(pdf), creditId);
      this.db.prepare('UPDATE number_series SET next_number=next_number+1 WHERE issuer_id=?').run(inv.issuer_id);
    }).immediate();
    return { number: expected, pdfSha256: hash };
  }

  // ---------- påminnelse ----------
  /**
   * Påminnelse för obetald (rest av) faktura. Avgift och ny förfallotid anges av anroparen:
   * lagstadgat tak för påminnelseavgift och ränta är öppna punkter att verifiera, de hårdkodas inte.
   */
  async createReminder(invoiceId: number, args: { reminderDate: string; newDueDate: string; feeOre?: number }): Promise<{ reminderId: number; pdfSha256: string }> {
    assertDate(args.reminderDate, 'påminnelsedatum'); assertDate(args.newDueDate, 'nytt förfallodatum');
    const inv = this.loadInvoice(invoiceId);
    if (inv.status !== 'issued' || inv.kind !== 'invoice') throw new InvoicingError('NOT_REMINDABLE', 'bara utfärdade fakturor');
    if (args.reminderDate <= inv.due_date) throw new InvoicingError('NOT_OVERDUE', `förfaller ${inv.due_date}`);
    const out = this.outstandingOre(invoiceId);
    if (out <= 0) throw new InvoicingError('NOT_OUTSTANDING', 'ingenting att påminna om');
    const issuer = this.loadIssuer(inv.issuer_id);
    const customer = this.loadCustomer(inv.customer_id);
    const fee = args.feeOre ?? 0;
    const pdf = await renderReminderPdf({
      issuer: this.pdfIssuer(issuer), customer: this.pdfParty(customer), invoiceNumber: inv.number, invoiceDate: inv.invoice_date,
      originalDueDate: inv.due_date, reminderDate: args.reminderDate, newDueDate: args.newDueDate, outstandingOre: out, feeOre: fee,
    });
    const hash = sha256(pdf);
    const id = Number(this.db.prepare('INSERT INTO reminder(invoice_id,reminder_date,fee_ore,new_due_date,pdf_sha256,pdf) VALUES (?,?,?,?,?,?)')
      .run(invoiceId, args.reminderDate, fee, args.newDueDate, hash, Buffer.from(pdf)).lastInsertRowid);
    return { reminderId: id, pdfSha256: hash };
  }

  // ---------- läsning ----------
  /** Fakturans belopp efter ev. kreditfaktura (en kredit upphäver hela fakturan). */
  effectiveTotals(invoiceId: number): Totals {
    const credited = this.db.prepare(`SELECT 1 FROM invoice WHERE credits_invoice_id=? AND status='issued'`).get(invoiceId);
    if (credited) return { netOre: 0, vatOre: 0, grossOre: 0, groups: [] };
    return totals(this.moneyLines(invoiceId));
  }
  invoiceTotals(invoiceId: number): Totals { return totals(this.moneyLines(invoiceId)); }

  outstandingOre(invoiceId: number): number {
    const paid = (this.db.prepare('SELECT COALESCE(SUM(amount_ore),0) a FROM payment WHERE invoice_id=?').get(invoiceId) as any).a as number;
    return this.effectiveTotals(invoiceId).grossOre - paid;
  }

  /** Utfärdade fakturor med utestående belopp. Negativt belopp = betalt men krediterat: återbetalning återstår. */
  listOpen(asOf: string): { number: number; invoiceId: number; dueDate: string; outstandingOre: number; overdue: boolean }[] {
    const rows = this.db.prepare(`SELECT id, number, due_date FROM invoice WHERE kind='invoice' AND status='issued' ORDER BY number`).all() as any[];
    return rows.map(r => ({ number: r.number, invoiceId: r.id, dueDate: r.due_date, outstandingOre: this.outstandingOre(r.id), overdue: asOf > r.due_date }))
      .filter(r => r.outstandingOre !== 0);
  }

  /** Betalningar som sparats men ännu inte fått verifikat (t.ex. bokföringsfel). Ska vara tom innan årsstängning. */
  unbookedPayments(): { id: string; invoiceId: number; paidDate: string; amountOre: number }[] {
    return (this.db.prepare('SELECT id, invoice_id i, paid_date d, amount_ore a FROM payment WHERE voucher_id IS NULL ORDER BY paid_date').all() as any[])
      .map(r => ({ id: r.id, invoiceId: r.i, paidDate: r.d, amountOre: r.a }));
  }

  getPdf(invoiceId: number): Buffer { return (this.db.prepare('SELECT pdf FROM invoice WHERE id=?').get(invoiceId) as any).pdf; }

  // ---------- intern ----------
  private loadInvoice(id: number): any {
    const r = this.db.prepare('SELECT * FROM invoice WHERE id=?').get(id);
    if (!r) throw new InvoicingError('NO_INVOICE', String(id));
    return r;
  }
  private loadLines(id: number): any[] { return this.db.prepare('SELECT * FROM invoice_line WHERE invoice_id=? ORDER BY line_no').all(id); }
  private moneyLines(id: number): MoneyLine[] {
    return this.loadLines(id).map(l => ({ qtyMilli: l.qty_milli, unitPriceOre: l.unit_price_ore, vatRate: l.vat_rate }));
  }
  private loadIssuer(id: number): any { return this.db.prepare('SELECT * FROM issuer WHERE id=?').get(id); }
  private loadCustomer(id: number): any { return this.db.prepare('SELECT * FROM customer WHERE id=?').get(id); }
  private assertSingleRevenueAccount(lines: any[]): number {
    const accounts = new Set(lines.map(l => l.revenue_account));
    if (accounts.size !== 1) throw new InvoicingError('MIXED_REVENUE_ACCOUNTS', 'en faktura får just nu bara ha ett intäktskonto (kärnans betalningsverifikat tar ett)');
    return [...accounts][0] as number;
  }
  private pdfParty(c: any) { return { name: c.name, addressLines: String(c.address_lines).split('\n'), orgNumber: c.org_number }; }
  private pdfIssuer(i: any): InvoicePdfData['issuer'] {
    return { ...this.pdfParty(i), vatNumber: i.vat_number, fSkatt: !!i.f_skatt, cashMethodText: i.cash_method_text,
      bankgiro: i.bankgiro, bankAccount: i.bank_account, contactEmail: i.contact_email };
  }
  private pdfData(inv: any, issuer: any, customer: any, lines: any[], x: { number: number; invoiceDate: string; deliveryDate: string; dueDate: string }): InvoicePdfData {
    return {
      kind: inv.kind, number: x.number, invoiceDate: x.invoiceDate, deliveryDate: x.deliveryDate, dueDate: x.dueDate,
      paymentDays: issuer.payment_days, issuer: this.pdfIssuer(issuer), customer: this.pdfParty(customer),
      customerReference: inv.customer_reference,
      lines: lines.map(l => ({ description: l.description, unit: l.unit, qtyMilli: l.qty_milli, unitPriceOre: l.unit_price_ore, vatRate: l.vat_rate })),
    };
  }
}
