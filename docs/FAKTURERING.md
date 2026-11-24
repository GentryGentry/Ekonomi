# Fakturering (src/invoicing)

Status: v0 byggd mot `src/core/api.ts`. Allt testat med påhittad data (`test/invoicing.test.ts`).

## Vad som finns
- **Utfärdare, kunder, artiklar som data** (`schema.sql`). Ny utfärdare (t.ex. AB) får egen gapfri serie (`number_series`).
- **Artiklar** seedas från `config/articles.seed.json` (priser hämtade ur Notion Grund 2026-11-24, ändra i Notion först).
- **Utfärda**: nummer, förfallodatum (utfärdarens betalningsvillkor), PDF och sha256 fryses i en transaktion. Fel ger inget förbrukat nummer. Ingen verifikation (D-006).
- **PDF** (pdf-lib, standardfont, fasta metadata: deterministisk, svenska tecken fungerar).
- **Betalning** (del eller hel): `paymentVoucher()` + `postVoucher()`, idempotent på `paymentId`. Moms fördelas proportionellt, sista betalningen tar resten.
- **Kreditfaktura**: full kredit, eget nummer i samma serie, negativa rader. Obetald faktura ger inget verifikat.
- **Påminnelse**: PDF och logg. Avgift och ny förfallodag anges av anroparen.
- Utfärdad faktura, rader, betalningar och påminnelser är oföränderliga (triggers).

## Innehåll på fakturan (ML 17 kap. 24 §, ⚖️ kontrollera mot lagtext innan första faktura)
Fakturadatum, löpnummer, utfärdarens namn/adress/momsregistreringsnummer, köparens namn/adress, art och omfattning,
leveransdatum/period, underlag per momssats, momssats, momsbelopp i SEK. Dessutom: F-skatt, betalningsvillkor, bankgiro/konto, referens.

## Öppna punkter (ej avgjorda, inget antas i koden)
1. **Kontantmetodens fakturatext.** Ingen standardtext finns i koden. `issuer.cash_method_text` måste sättas av Thomas efter kontroll mot Skatteverket, annars vägrar `issue()` att utfärda (`CASH_METHOD_TEXT_MISSING`).
2. **Utfärdarens adress och bankuppgifter** finns inte i Notion. Läggs in vid skapande av utfärdare. Nordea/bankgiro-status oklar.
3. **Återbetalning vid kredit av betald faktura.** `listOpen()` visar negativt belopp. Bokning kräver att kärnan bokar en återbetalning (postVoucher serie B med egen source) och ett konsultsvar på kontantmetodens behandling.
4. **Påminnelseavgift och dröjsmålsränta**: lagstadgade tak/regler och vad Standardavtalet säger är inte verifierat. Hårdkodas inte.
5. **Momssatser**: bara 25 % tillåts eftersom `paymentVoucher()` bara bokar 25 %. 0 % kräver fakturatext om skälet.
6. **En faktura har ett intäktskonto** (betalningsverifikatet tar ett).
7. **Sen betalning i låst period**: kärnan har inte perioder än. `recordPayment` kastar kärnans fel, betalningen ligger kvar som `unbookedPayments()` och kan omförsökas.
8. Månads- eller kvartalsfakturering för Sågenvägen: påverkar schema, inte byggt.
9. Partiell kredit och CLI saknas (D-008: CLI först).
