import type { Ore } from '../core/api.js';

export interface MoneyLine {
  qtyMilli: number;      // 1 st = 1000
  unitPriceOre: Ore;
  vatRate: number;       // procent
}

export interface VatGroup { rate: number; netOre: Ore; vatOre: Ore }
export interface Totals { netOre: Ore; vatOre: Ore; grossOre: Ore; groups: VatGroup[] }

/** Heltalsdivision med avrundning "halv upp" (bort från noll för negativa tal, så kredit speglar faktura). */
export function divRound(num: number, den: number): number {
  if (!Number.isInteger(num) || !Number.isInteger(den) || den <= 0) throw new Error('divRound: heltal krävs');
  const sign = num < 0 ? -1 : 1;
  const abs = Math.abs(num);
  return sign * Math.floor((2 * abs + den) / (2 * den));
}

/** Radens netto i öre. Avrundas till hel öre per rad. */
export function lineNet(l: MoneyLine): Ore {
  return divRound(l.qtyMilli * l.unitPriceOre, 1000);
}

/**
 * Moms räknas på nettosumman per momssats och avrundas en gång (docs/ARCHITECTURE.md, Momsavrundning).
 */
export function totals(lines: MoneyLine[]): Totals {
  const byRate = new Map<number, Ore>();
  for (const l of lines) byRate.set(l.vatRate, (byRate.get(l.vatRate) ?? 0) + lineNet(l));
  const groups: VatGroup[] = [...byRate.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([rate, netOre]) => ({ rate, netOre, vatOre: divRound(netOre * rate, 100) }));
  const netOre = groups.reduce((s, g) => s + g.netOre, 0);
  const vatOre = groups.reduce((s, g) => s + g.vatOre, 0);
  return { netOre, vatOre, grossOre: netOre + vatOre, groups };
}

/**
 * Fördelar en betalning på netto och moms. Moms proportionellt mot fakturans moms,
 * och när betalningen stänger fakturan tar den resten, så att summan över alla
 * betalningar blir exakt fakturans belopp. Konsulten ska bekräfta regeln.
 */
export function splitPayment(args: {
  amountOre: Ore; invoiceGrossOre: Ore; invoiceVatOre: Ore; paidSoFarOre: Ore; paidVatSoFarOre: Ore;
}): { netOre: Ore; vatOre: Ore } {
  const { amountOre, invoiceGrossOre, invoiceVatOre, paidSoFarOre, paidVatSoFarOre } = args;
  if (amountOre <= 0) throw new Error('Betalning måste vara > 0');
  const remaining = invoiceGrossOre - paidSoFarOre;
  if (amountOre > remaining) throw new Error(`Betalning ${amountOre} överstiger återstående ${remaining}`);
  const vatOre = amountOre === remaining
    ? invoiceVatOre - paidVatSoFarOre
    : divRound(invoiceVatOre * amountOre, invoiceGrossOre);
  return { vatOre, netOre: amountOre - vatOre };
}

export const formatOre = (o: Ore): string => {
  const sign = o < 0 ? '-' : '';
  const a = Math.abs(o);
  const kr = String(Math.floor(a / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${sign}${kr},${String(a % 100).padStart(2, '0')}`;
};
