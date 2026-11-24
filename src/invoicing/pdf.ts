import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { createHash } from 'node:crypto';
import { formatOre, lineNet, totals } from './money.js';

export interface PdfParty { name: string; addressLines: string[]; orgNumber?: string | null }

export interface InvoicePdfData {
  kind: 'invoice' | 'credit';
  number: number;
  invoiceDate: string;
  deliveryDate: string;
  dueDate: string;
  paymentDays: number;
  issuer: PdfParty & {
    vatNumber: string; fSkatt: boolean; cashMethodText?: string | null;
    bankgiro?: string | null; bankAccount?: string | null; contactEmail?: string | null;
  };
  customer: PdfParty;
  customerReference?: string | null;
  creditsNumber?: number | null;
  lines: { description: string; unit: string; qtyMilli: number; unitPriceOre: number; vatRate: number }[];
}

export interface ReminderPdfData {
  issuer: InvoicePdfData['issuer'];
  customer: PdfParty;
  invoiceNumber: number;
  invoiceDate: string;
  originalDueDate: string;
  reminderDate: string;
  newDueDate: string;
  outstandingOre: number;
  feeOre: number;
}

const FIXED_DATE = new Date('2000-01-01T00:00:00Z');
const MARGIN = 50;

async function newDoc(title: string) {
  const doc = await PDFDocument.create();
  // Deterministisk utdata: inga tidsstämplar från klockan, fasta metadata.
  doc.setTitle(title);
  doc.setAuthor('D&G Ekonomi');
  doc.setCreator('D&G Ekonomi');
  doc.setProducer('D&G Ekonomi');
  doc.setCreationDate(FIXED_DATE);
  doc.setModificationDate(FIXED_DATE);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  return { doc, font, bold };
}

function text(page: PDFPage, s: string, x: number, y: number, font: PDFFont, size = 10) {
  page.drawText(s, { x, y, size, font, color: rgb(0, 0, 0) });
}
function right(page: PDFPage, s: string, xRight: number, y: number, font: PDFFont, size = 10) {
  text(page, s, xRight - font.widthOfTextAtSize(s, size), y, font, size);
}

function wrap(s: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const out: string[] = [];
  let cur = '';
  for (const w of s.split(/\s+/)) {
    const next = cur ? `${cur} ${w}` : w;
    if (font.widthOfTextAtSize(next, size) > maxWidth && cur) { out.push(cur); cur = w; } else cur = next;
  }
  if (cur) out.push(cur);
  return out;
}

const fmtQty = (milli: number) => {
  const neg = milli < 0 ? '-' : '';
  const a = Math.abs(milli);
  const whole = Math.floor(a / 1000), frac = a % 1000;
  return `${neg}${whole}${frac ? ',' + String(frac).padStart(3, '0').replace(/0+$/, '') : ''}`;
};

export const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/**
 * Faktura-PDF med uppgifterna som mervärdesskattelagen kräver (17 kap. 24 §, lista i docs/FAKTURA-KRAV.md,
 * ⚖️ ska kontrolleras mot lagtext): fakturadatum, löpnummer, utfärdarens och köparens namn och adress,
 * utfärdarens momsregistreringsnummer, art och omfattning, leveransdatum, belopp per momssats exkl moms,
 * momssats, momsbelopp i SEK.
 */
export async function renderInvoicePdf(d: InvoicePdfData): Promise<Uint8Array> {
  const credit = d.kind === 'credit';
  const label = credit ? 'Kreditfaktura' : 'Faktura';
  const { doc, font, bold } = await newDoc(`${label} ${d.number}`);
  const page = doc.addPage([595.28, 841.89]);
  const W = 595.28 - MARGIN;
  let y = 790;

  text(page, label, MARGIN, y, bold, 20);
  y -= 26;
  [d.issuer.name, ...d.issuer.addressLines].forEach((l, i) => { text(page, l, MARGIN, y, i === 0 ? bold : font); y -= 13; });
  if (d.issuer.orgNumber) { text(page, `Org.nr: ${d.issuer.orgNumber}`, MARGIN, y, font); y -= 13; }
  text(page, `Momsreg.nr: ${d.issuer.vatNumber}`, MARGIN, y, font); y -= 13;
  if (d.issuer.fSkatt) { text(page, 'Godkänd för F-skatt', MARGIN, y, font); y -= 13; }

  // Högerspalt: nummer och datum
  let ry = 790;
  const meta: [string, string][] = [
    [`${label}snummer`, String(d.number)],
    [`${label}sdatum`, d.invoiceDate],
    ['Leveransdatum/period', d.deliveryDate],
  ];
  if (!credit) meta.push(['Förfallodatum', d.dueDate], ['Betalningsvillkor', `${d.paymentDays} dagar netto`]);
  if (credit && d.creditsNumber != null) meta.push(['Avser faktura', String(d.creditsNumber)]);
  if (d.customerReference) meta.push(['Er referens', d.customerReference]);
  for (const [k, v] of meta) { text(page, k, 340, ry, font, 9); right(page, v, W, ry, bold, 9); ry -= 13; }

  y = Math.min(y, ry) - 18;
  text(page, 'Fakturamottagare', MARGIN, y, font, 8); y -= 12;
  [d.customer.name, ...d.customer.addressLines].forEach((l, i) => { text(page, l, MARGIN, y, i === 0 ? bold : font); y -= 13; });
  if (d.customer.orgNumber) { text(page, `Org.nr: ${d.customer.orgNumber}`, MARGIN, y, font); y -= 13; }

  y -= 20;
  const cols = { desc: MARGIN, qty: 330, price: 400, vat: 430, sum: W };
  text(page, 'Beskrivning', cols.desc, y, bold, 9);
  right(page, 'Antal', cols.qty + 30, y, bold, 9);
  right(page, 'À-pris', 425, y, bold, 9);
  right(page, 'Moms', 472, y, bold, 9);
  right(page, 'Belopp', cols.sum, y, bold, 9);
  y -= 6; page.drawLine({ start: { x: MARGIN, y }, end: { x: W, y }, thickness: 0.5 }); y -= 14;

  for (const l of d.lines) {
    const descLines = wrap(l.description, font, 9, 260);
    text(page, descLines[0] ?? '', cols.desc, y, font, 9);
    right(page, `${fmtQty(l.qtyMilli)} ${l.unit}`, cols.qty + 30, y, font, 9);
    right(page, formatOre(l.unitPriceOre), 425, y, font, 9);
    right(page, `${l.vatRate} %`, 472, y, font, 9);
    right(page, formatOre(lineNet(l)), cols.sum, y, font, 9);
    y -= 12;
    for (const extra of descLines.slice(1)) { text(page, extra, cols.desc, y, font, 9); y -= 12; }
  }

  const t = totals(d.lines);
  y -= 6; page.drawLine({ start: { x: MARGIN, y }, end: { x: W, y }, thickness: 0.5 }); y -= 16;
  for (const g of t.groups) {
    text(page, `Underlag moms ${g.rate} %`, 330, y, font, 9); right(page, formatOre(g.netOre), W, y, font, 9); y -= 12;
    text(page, `Moms ${g.rate} %`, 330, y, font, 9); right(page, formatOre(g.vatOre), W, y, font, 9); y -= 12;
  }
  text(page, 'Summa exkl. moms', 330, y, font, 9); right(page, formatOre(t.netOre), W, y, font, 9); y -= 12;
  text(page, 'Moms totalt (SEK)', 330, y, font, 9); right(page, formatOre(t.vatOre), W, y, font, 9); y -= 16;
  text(page, credit ? 'Att återbetala/avräkna (SEK)' : 'Att betala (SEK)', 330, y, bold, 11);
  right(page, formatOre(t.grossOre), W, y, bold, 11); y -= 30;

  const foot: string[] = [];
  if (!credit) {
    if (d.issuer.bankgiro) foot.push(`Bankgiro: ${d.issuer.bankgiro}`);
    if (d.issuer.bankAccount) foot.push(`Bankkonto: ${d.issuer.bankAccount}`);
    foot.push(`Ange fakturanummer ${d.number} vid betalning.`);
  }
  if (d.issuer.cashMethodText) foot.push(d.issuer.cashMethodText);
  if (d.issuer.contactEmail) foot.push(`Kontakt: ${d.issuer.contactEmail}`);
  for (const f of foot) for (const l of wrap(f, font, 9, W - MARGIN)) { text(page, l, MARGIN, y, font, 9); y -= 12; }

  return doc.save({ useObjectStreams: false });
}

export async function renderReminderPdf(d: ReminderPdfData): Promise<Uint8Array> {
  const { doc, font, bold } = await newDoc(`Betalningspåminnelse faktura ${d.invoiceNumber}`);
  const page = doc.addPage([595.28, 841.89]);
  const W = 595.28 - MARGIN;
  let y = 790;
  text(page, 'Betalningspåminnelse', MARGIN, y, bold, 20); y -= 26;
  [d.issuer.name, ...d.issuer.addressLines].forEach((l, i) => { text(page, l, MARGIN, y, i === 0 ? bold : font); y -= 13; });
  text(page, `Momsreg.nr: ${d.issuer.vatNumber}`, MARGIN, y, font); y -= 26;
  text(page, 'Till', MARGIN, y, font, 8); y -= 12;
  [d.customer.name, ...d.customer.addressLines].forEach((l, i) => { text(page, l, MARGIN, y, i === 0 ? bold : font); y -= 13; });
  y -= 14;
  text(page, `Datum: ${d.reminderDate}`, MARGIN, y, font); y -= 20;
  const body = `Vi kan inte se att faktura ${d.invoiceNumber} (daterad ${d.invoiceDate}, förfallodatum ${d.originalDueDate}) är betald. ` +
    'Om du redan har betalat kan du bortse från denna påminnelse.';
  for (const l of wrap(body, font, 10, W - MARGIN)) { text(page, l, MARGIN, y, font); y -= 14; }
  y -= 10;
  text(page, 'Obetalt belopp', MARGIN, y, font); right(page, `${formatOre(d.outstandingOre)} kr`, W, y, font); y -= 14;
  if (d.feeOre > 0) { text(page, 'Påminnelseavgift', MARGIN, y, font); right(page, `${formatOre(d.feeOre)} kr`, W, y, font); y -= 14; }
  text(page, 'Att betala', MARGIN, y, bold); right(page, `${formatOre(d.outstandingOre + d.feeOre)} kr`, W, y, bold); y -= 14;
  text(page, 'Nytt förfallodatum', MARGIN, y, bold); right(page, d.newDueDate, W, y, bold); y -= 24;
  if (d.issuer.bankgiro) { text(page, `Bankgiro: ${d.issuer.bankgiro}`, MARGIN, y, font); y -= 13; }
  if (d.issuer.bankAccount) { text(page, `Bankkonto: ${d.issuer.bankAccount}`, MARGIN, y, font); y -= 13; }
  text(page, `Ange fakturanummer ${d.invoiceNumber} vid betalning.`, MARGIN, y, font);
  return doc.save({ useObjectStreams: false });
}
