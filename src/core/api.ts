/**
 * Gränssnitt mellan bokföringskärnan (src/core) och fakturering (src/invoicing).
 * Fakturering importerar BARA från denna fil. Kärnan vet inget om fakturor.
 * Belopp är heltal i öre. Datum är ISO-strängar (YYYY-MM-DD).
 */
export type Ore = number;

export interface LedgerLine {
  account: number; // BAS-konto
  debit?: Ore;     // exakt en av debit/credit, > 0
  credit?: Ore;
}

export interface PostVoucherInput {
  series: 'A' | 'B';       // A manuell, B betalning/bank. K används bara av correctVoucher
  entryDate: string;       // vid kontantmetoden: betaldatum
  description: string;
  lines: LedgerLine[];     // summa debet måste vara lika med summa kredit
  /** Idempotensnyckel. Samma (sourceType, sourceId) bokförs aldrig två gånger. */
  source?: { type: string; id: string };
  attachments?: { sha256: string; filename: string }[];
}

export interface PostedVoucher {
  id: number;
  series: string;
  number: number;          // gapfri per (räkenskapsår, serie)
  fiscalYearId: number;
}

export interface LedgerCore {
  /** Atomisk: validerar balans, öppet år, allokerar nummer, hash-kedjar. Kastar vid fel. */
  postVoucher(input: PostVoucherInput): PostedVoucher;
  /** Rättelse = ny verifikation i serie K som vänder originalet och bokar rätt. Originalet rörs aldrig. */
  correctVoucher(voucherId: number, reason: string, replacement?: PostVoucherInput): PostedVoucher;
  /** Läser hash-kedjan och kontrollerar nummerföljd. Returnerar fel, kastar inte. */
  verifyIntegrity(): { ok: boolean; problems: string[] };
}

/**
 * Fakturamodulens enda skrivning in i kärnan, vid registrerad betalning (kontantmetoden):
 *   debet 1930 (belopp inkl moms), kredit 3xxx (netto), kredit 2611 (utgående moms 25 %).
 * Utfärdad faktura skapar INGEN verifikation. Se docs/DECISIONS.md D-006.
 */
export function paymentVoucher(p: {
  paymentId: string; paidDate: string; invoiceNumber: number;
  netOre: Ore; vatOre: Ore; revenueAccount: number;
}): PostVoucherInput {
  return {
    series: 'B',
    entryDate: p.paidDate,
    description: `Betalning faktura ${p.invoiceNumber}`,
    source: { type: 'invoice_payment', id: p.paymentId },
    lines: [
      { account: 1930, debit: p.netOre + p.vatOre },
      { account: p.revenueAccount, credit: p.netOre },
      ...(p.vatOre > 0 ? [{ account: 2611, credit: p.vatOre }] : []),
    ],
  };
}
