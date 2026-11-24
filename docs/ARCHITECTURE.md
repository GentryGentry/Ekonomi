# Arkitektur och datamodell (skiss)

```
src/core/       schema.sql, ledger (post, correct, verify), SIE-export   <- bokföringstråden
src/invoicing/  customer, invoice, numbering, pdf, payments               <- fakturatråden
src/core/api.ts det enda gränssnittet mellan dem
test/           vitest, påhittad data
docs/           DECISIONS.md, ARCHITECTURE.md, TESTING.md
```

## Huvudbok (core)
`fiscal_year` 1-N `voucher` 1-N `voucher_line` N-1 `account`. `voucher` har serie, gapfritt nummer, datum,
`corrects_voucher_id`, `source_type/source_id` (idempotens) och `prev_hash/hash`. `attachment` pekar på underlag via sha256.
Exakt schema: `src/core/schema.sql`.

## Fakturering (invoicing, ej byggt)
`customer`, `invoice` (nummer från 1001, status draft/issued, utfärdad är oföränderlig), `invoice_line`, `payment`,
`credit_of_invoice_id` för kreditfaktura (rättelse av utfärdad faktura). Utfärdande allokerar nummer och fryser PDF + sha256 i en transaktion.

## Flöde
1. Fakturatråden utfärdar faktura 1001. Ingen verifikation (D-006).
2. Betalning registreras: `payment` sparas, `paymentVoucher()` bygger posten, `core.postVoucher()` bokför den idempotent.
3. Fel i bokförd betalning: `core.correctVoucher()`. Fel i utfärdad faktura: kreditfaktura plus ny faktura.
4. Årsslut: SIE4-export, stäng året.

## Momsavrundning
Moms räknas på fakturans nettosumma per momssats, avrundas en gång till hel öre (halv upp). Samma regel i PDF och bokföring.
Delbetalning: moms fördelas proportionellt, sista delbetalningen tar resten. Detta ska konsulten bekräfta.
