import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { LedgerCore, PostVoucherInput, PostedVoucher, LedgerLine } from './api.js';

export class LedgerError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'LedgerError';
  }
}

export interface LedgerOptions {
  /** Injicerbar klocka, för tester. */
  now?: () => Date;
}

interface VoucherRow {
  id: number; fiscal_year_id: number; series: string; number: number;
  entry_date: string; registered_at: string; description: string;
  corrects_voucher_id: number | null; source_type: string | null; source_id: string | null;
  prev_hash: string; hash: string;
}
interface LineRow { line_no: number; account_number: number; debit: number; credit: number }

const GENESIS = '0';
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isOre(n: unknown): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n) && n > 0;
}

/** Normaliserade rader: exakt en av debet/kredit, heltal > 0 i öre. */
function normalizeLines(lines: LedgerLine[]): { account: number; debit: number; credit: number }[] {
  if (lines.length < 2) throw new LedgerError('TOO_FEW_LINES', 'Verifikation kräver minst två rader');
  return lines.map((l, i) => {
    const hasD = l.debit !== undefined && l.debit !== 0;
    const hasC = l.credit !== undefined && l.credit !== 0;
    if (hasD === hasC) throw new LedgerError('BAD_LINE', `Rad ${i + 1}: exakt en av debet/kredit krävs`);
    const amount = hasD ? l.debit : l.credit;
    if (!isOre(amount)) throw new LedgerError('BAD_AMOUNT', `Rad ${i + 1}: belopp måste vara heltal öre > 0`);
    if (!Number.isInteger(l.account)) throw new LedgerError('BAD_ACCOUNT', `Rad ${i + 1}: ogiltigt konto`);
    return { account: l.account, debit: hasD ? amount : 0, credit: hasC ? amount : 0 };
  });
}

export function computeHash(prevHash: string, v: {
  fiscalYearId: number; series: string; number: number; entryDate: string; registeredAt: string;
  description: string; correctsVoucherId: number | null; sourceType: string | null; sourceId: string | null;
}, lines: { account: number; debit: number; credit: number }[]): string {
  // JSON-array ger entydig serialisering (inga avgränsarkollisioner).
  const payload = JSON.stringify([
    prevHash, v.fiscalYearId, v.series, v.number, v.entryDate, v.registeredAt, v.description,
    v.correctsVoucherId, v.sourceType, v.sourceId,
    lines.map(l => [l.account, l.debit, l.credit]),
  ]);
  return createHash('sha256').update(payload).digest('hex');
}

export function createLedger(db: Database.Database, opts: LedgerOptions = {}): LedgerCore {
  const now = opts.now ?? (() => new Date());

  const insertVoucher = db.prepare(`INSERT INTO voucher
    (fiscal_year_id, series, number, entry_date, registered_at, description, corrects_voucher_id,
     source_type, source_id, prev_hash, hash)
    VALUES (@fy, @series, @number, @entryDate, @registeredAt, @description, @corrects, @sourceType, @sourceId, @prev, @hash)`);
  const insertLine = db.prepare(`INSERT INTO voucher_line (voucher_id, line_no, account_number, debit, credit)
    VALUES (?, ?, ?, ?, ?)`);
  const insertAttachment = db.prepare(`INSERT INTO attachment (voucher_id, sha256, filename, stored_at) VALUES (?, ?, ?, ?)`);
  const yearFor = db.prepare(`SELECT id, closed_at FROM fiscal_year WHERE start_date <= ? AND end_date >= ?`);
  const accountOk = db.prepare(`SELECT active FROM account WHERE number = ?`);
  const lastHash = db.prepare(`SELECT hash FROM voucher WHERE fiscal_year_id = ? ORDER BY id DESC LIMIT 1`);
  const nextNumber = db.prepare(`SELECT COALESCE(MAX(number), 0) + 1 AS n FROM voucher WHERE fiscal_year_id = ? AND series = ?`);
  const bySource = db.prepare(`SELECT * FROM voucher WHERE source_type = ? AND source_id = ?`);
  const voucherById = db.prepare(`SELECT * FROM voucher WHERE id = ?`);
  const linesOf = db.prepare(`SELECT line_no, account_number, debit, credit FROM voucher_line WHERE voucher_id = ? ORDER BY line_no`);
  const correctionOf = db.prepare(`SELECT id FROM voucher WHERE corrects_voucher_id = ?`);
  const yearById = db.prepare(`SELECT id, closed_at FROM fiscal_year WHERE id = ?`);
  const allVouchers = db.prepare(`SELECT * FROM voucher ORDER BY id`);

  function openYearFor(date: string): number {
    if (!ISO_DATE.test(date) || Number.isNaN(Date.parse(date))) throw new LedgerError('BAD_DATE', `Ogiltigt datum: ${date}`);
    const fy = yearFor.get(date, date) as { id: number; closed_at: string | null } | undefined;
    if (!fy) throw new LedgerError('NO_FISCAL_YEAR', `Inget räkenskapsår för ${date}`);
    if (fy.closed_at) throw new LedgerError('YEAR_CLOSED', `Räkenskapsåret för ${date} är stängt`);
    return fy.id;
  }

  /** Måste köras inuti en transaktion. */
  function write(args: {
    series: string; entryDate: string; description: string; lines: LedgerLine[];
    corrects?: number | null; source?: { type: string; id: string }; attachments?: { sha256: string; filename: string }[];
  }): PostedVoucher {
    if (!args.description.trim()) throw new LedgerError('NO_DESCRIPTION', 'Verifikation kräver text');
    const lines = normalizeLines(args.lines);
    const debit = lines.reduce((s, l) => s + l.debit, 0);
    const credit = lines.reduce((s, l) => s + l.credit, 0);
    if (debit !== credit) throw new LedgerError('UNBALANCED', `Debet ${debit} ≠ kredit ${credit}`);
    if (!Number.isSafeInteger(debit)) throw new LedgerError('BAD_AMOUNT', 'Summa för stor');
    for (const l of lines) {
      const a = accountOk.get(l.account) as { active: number } | undefined;
      if (!a) throw new LedgerError('UNKNOWN_ACCOUNT', `Konto ${l.account} finns inte`);
      if (!a.active) throw new LedgerError('INACTIVE_ACCOUNT', `Konto ${l.account} är inaktivt`);
    }
    const fy = openYearFor(args.entryDate);
    const number = (nextNumber.get(fy, args.series) as { n: number }).n;
    const prev = (lastHash.get(fy) as { hash: string } | undefined)?.hash ?? GENESIS;
    const registeredAt = now().toISOString();
    const meta = {
      fiscalYearId: fy, series: args.series, number, entryDate: args.entryDate, registeredAt,
      description: args.description, correctsVoucherId: args.corrects ?? null,
      sourceType: args.source?.type ?? null, sourceId: args.source?.id ?? null,
    };
    const hash = computeHash(prev, meta, lines);
    const info = insertVoucher.run({
      fy, series: args.series, number, entryDate: args.entryDate, registeredAt, description: args.description,
      corrects: meta.correctsVoucherId, sourceType: meta.sourceType, sourceId: meta.sourceId, prev, hash,
    });
    const id = Number(info.lastInsertRowid);
    lines.forEach((l, i) => insertLine.run(id, i + 1, l.account, l.debit, l.credit));
    for (const a of args.attachments ?? []) {
      if (!/^[0-9a-f]{64}$/.test(a.sha256)) throw new LedgerError('BAD_ATTACHMENT', 'sha256 måste vara 64 hex-tecken');
      insertAttachment.run(id, a.sha256, a.filename, registeredAt);
    }
    return { id, series: args.series, number, fiscalYearId: fy };
  }

  function sameLines(rows: LineRow[], input: LedgerLine[]): boolean {
    let norm;
    try { norm = normalizeLines(input); } catch { return false; }
    return rows.length === norm.length &&
      rows.every((r, i) => r.account_number === norm[i]!.account && r.debit === norm[i]!.debit && r.credit === norm[i]!.credit);
  }

  const post = db.transaction((input: PostVoucherInput): PostedVoucher => {
    if (input.series !== 'A' && input.series !== 'B') {
      throw new LedgerError('BAD_SERIES', `Serie ${String(input.series)} får inte användas direkt (K är reserverad för rättelser)`);
    }
    if (input.source) {
      const existing = bySource.get(input.source.type, input.source.id) as VoucherRow | undefined;
      if (existing) {
        const rows = linesOf.all(existing.id) as LineRow[];
        if (existing.entry_date !== input.entryDate || !sameLines(rows, input.lines)) {
          throw new LedgerError('IDEMPOTENCY_CONFLICT',
            `Källan ${input.source.type}/${input.source.id} är redan bokförd med annat innehåll. Använd correctVoucher.`);
        }
        return { id: existing.id, series: existing.series, number: existing.number, fiscalYearId: existing.fiscal_year_id };
      }
    }
    return write(input);
  });

  const correct = db.transaction((voucherId: number, reason: string, replacement?: PostVoucherInput): PostedVoucher => {
    if (!reason.trim()) throw new LedgerError('NO_REASON', 'Rättelse kräver orsak');
    const orig = voucherById.get(voucherId) as VoucherRow | undefined;
    if (!orig) throw new LedgerError('NOT_FOUND', `Verifikation ${voucherId} finns inte`);
    if (orig.series === 'K') throw new LedgerError('CANNOT_CORRECT_CORRECTION', 'En rättelse kan inte rättas. Bokför en ny verifikation i serie A.');
    if (correctionOf.get(voucherId)) throw new LedgerError('ALREADY_CORRECTED', `Verifikation ${voucherId} är redan rättad`);
    if (replacement?.source) throw new LedgerError('BAD_REPLACEMENT', 'Ersättningsposten får inte ha egen källa');

    const origLines = linesOf.all(voucherId) as LineRow[];
    const reversal: LedgerLine[] = origLines.map(l =>
      l.debit > 0 ? { account: l.account_number, credit: l.debit } : { account: l.account_number, debit: l.credit });
    const origYear = yearById.get(orig.fiscal_year_id) as { id: number; closed_at: string | null };
    const today = now().toISOString().slice(0, 10);
    const entryDate = replacement?.entryDate ?? (origYear.closed_at ? today : orig.entry_date);
    const lines = [...reversal, ...(replacement?.lines ?? [])];
    const description = `Rättelse av ${orig.series}${orig.number}: ${reason}` +
      (replacement ? ` | ${replacement.description}` : '');
    return write({
      series: 'K', entryDate, description, lines, corrects: voucherId, attachments: replacement?.attachments,
    });
  });

  function verify(): { ok: boolean; problems: string[] } {
    const problems: string[] = [];
    // Kedjan är per räkenskapsår (GDPR: ett år ska kunna raderas som enhet efter 7 år).
    const prevByYear = new Map<number, string>();
    const seen = new Map<string, number>();
    for (const v of allVouchers.all() as VoucherRow[]) {
      const tag = `${v.series}${v.number} (id ${v.id})`;
      const rows = linesOf.all(v.id) as LineRow[];
      const prev = prevByYear.get(v.fiscal_year_id) ?? GENESIS;
      if (v.prev_hash !== prev) problems.push(`${tag}: prev_hash bryter kedjan`);
      const calc = computeHash(v.prev_hash, {
        fiscalYearId: v.fiscal_year_id, series: v.series, number: v.number, entryDate: v.entry_date,
        registeredAt: v.registered_at, description: v.description, correctsVoucherId: v.corrects_voucher_id,
        sourceType: v.source_type, sourceId: v.source_id,
      }, rows.map(r => ({ account: r.account_number, debit: r.debit, credit: r.credit })));
      if (calc !== v.hash) problems.push(`${tag}: hash stämmer inte med innehållet`);
      const d = rows.reduce((s, r) => s + r.debit, 0), c = rows.reduce((s, r) => s + r.credit, 0);
      if (d !== c) problems.push(`${tag}: debet ${d} ≠ kredit ${c}`);
      if (rows.length < 2) problems.push(`${tag}: färre än två rader`);
      const key = `${v.fiscal_year_id}/${v.series}`;
      const expected = (seen.get(key) ?? 0) + 1;
      if (v.number !== expected) problems.push(`${tag}: nummerföljd bruten, väntade ${expected}`);
      seen.set(key, v.number);
      prevByYear.set(v.fiscal_year_id, v.hash);
    }
    return { ok: problems.length === 0, problems };
  }

  return { postVoucher: post, correctVoucher: correct, verifyIntegrity: verify };
}
