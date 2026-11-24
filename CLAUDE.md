# D&G Ekonomi: egen bokföring och fakturering

Danielsson & Gentry, enskild firma, F-skatt, momsregistrerad, **kontantmetoden**, kalenderår.
Stabila fakta (priser, momsnr, fakturanummer) bor i Notion: *D&G – Grund*. Beslut i *D&G – Beslutslogg*.
Status i *Projekt – Ekonomi (dg-ekonomi)*. **Hårdkoda aldrig priser eller villkor här. Läs Notion.**

> OBS: den ursprungliga projektbriefen (dg-ekonomi-projektbrief.md) fanns inte när detta skrevs.
> Ersätt eller komplettera denna fil med den. Milstolpenumren i briefen är inte verifierade här.

## Hårda regler
1. **Bokföringen är laglig hela vägen** (BFL). Oföränderlig: verifikationer och rader får aldrig UPDATE/DELETE (databasen stoppar det via triggers). Fel rättas med ny verifikation (serie K) som pekar på originalet.
2. **Belopp är heltal i öre.** Aldrig float. Moms avrundas en gång per fakturarad-summa, regel i docs/ARCHITECTURE.md.
3. **Gapfria nummerserier**: verifikationer per (år, serie), fakturor från 1001. Nummer allokeras i samma transaktion som posten.
4. **Kontantmetoden**: utfärdad faktura ger ingen verifikation. Betalning ger verifikation (D-006).
5. **Ingen riktig kund- eller medlemsdata i repot, i tester eller i AI-chattar.** Fixtures är påhittade. `data/` och `*.db` är gitignorerade.
6. 7 års arkiv av räkenskapsinformation. Inget raderas, inget skrivs över.
7. Tills redovisningskonsult granskat och parallellkörning är klar räknas systemet inte som den enda bokföringen.

## Moduler och ägarskap
- `src/core/` bokföringskärna (schema, verifikation, rättelse, integritet, SIE-export). Äger tabellerna i `src/core/schema.sql`.
- `src/invoicing/` fakturering (kunder, fakturor, nummer, PDF, betalningar). Får bara importera `src/core/api.ts`.
- Gränssnittet är `src/core/api.ts`. Ändring där kräver en rad i docs/DECISIONS.md.

## Kommandon
`npm install`, `npm test`, `npm run typecheck`. Node 22+.

## Arbetssätt
- Test först för allt som rör pengar, nummer och oföränderlighet. Se docs/TESTING.md.
- Små PR:er. Inget mergas med röda tester.
- Beslut: skriv i docs/DECISIONS.md och föreslå rad i Notion-beslutsloggen.
