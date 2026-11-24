# Beslut (teknik). Företagsbeslut ligger i Notion: D&G – Beslutslogg

| ID | Beslut | Varför | Alternativ som valdes bort |
|---|---|---|---|
| D-001 | TypeScript på Node 22, ESM, strikt läge. | Ett språk för kärna, fakturering och senare UI. Typer ger skydd mot att blanda öre och kronor. Claude Code är stark här. | Python: lika bra för kärnan, men sämre delad typning mot ett framtida webb-UI. |
| D-002 | SQLite via better-sqlite3, en fil. | En användare, noll drift, atomiska transaktioner, triggers för oföränderlighet. Gratis, vilket var hela poängen med projektet. | Postgres: onödig drift för en enskild firma. Flatfiler: ingen transaktionssäkerhet. |
| D-003 | Belopp som heltal i öre. | Flyttal ger avrundningsfel som en revisor hittar. | Decimal-bibliotek: mer kod utan vinst i SEK. |
| D-004 | Oföränderlighet i databasen (triggers) plus hash-kedja på verifikationer. | Lagkravet gäller även om koden har en bugg. Hash-kedjan gör manipulation synlig. Ärligt: den **hindrar inte** den som äger filen, den visar bara. Därför även D-007. | Bara appnivå: en bugg eller manuell SQL kringgår den. |
| D-005 | Rättelse = verifikation i serie K som vänder och ersätter. Originalet rörs aldrig. | Rättelsepost enligt BFL, ursprunglig uppgift ska framgå. | Redigera med historiktabell: svårare att försvara. |
| D-006 | Kontantmetoden: utfärdad faktura skapar ingen verifikation. Betalning skapar en (D 1930, K 3xxx, K 2611). Obetalda fakturor spåras i fakturamodulen, utanför huvudboken. | Kontantmetoden redovisar intäkt och moms vid betalning. | Bokföra vid fakturering (bokslutsmetoden): fel metod för firman. |
| D-007 | Backup: daglig krypterad kopia av databasfilen och underlag utanför maskinen, plus årlig SIE4-export och PDF-arkiv. Hanteras i milstolpe för arkiv. | 7 års arkiv. En fil på en laptop är inte ett arkiv. | Enbart lokal fil. |
| D-008 | Först CLI och PDF, inget webb-UI. | 30-timmarstaket. Första fakturan kräver nummer, PDF och betalning, inte ett gränssnitt. | Webb-UI först: äter budgeten. |
| D-009 | Kontoplan BAS, importeras som seed. Exakta konton för moms och intäkt bekräftas av redovisningskonsult. | Standard, krävs av SIE och konsult. | Egen kontoplan. |
| D-010 | PDF-bibliotek väljs av fakturatråden. Krav: deterministisk utdata, svenska tecken, lagras med sha256 som underlag. | PDF är fakturans domän. | n/a |
| D-011 | Rättelse (K) är en enda verifikation med vändrader plus ev. ersättningsrader. Datum: ersättningens datum, annars originalets om året är öppet, annars dagens. Ett original rättas högst en gång, en rättelse rättas inte (bokför ny A-verifikation). | Enkel att granska, originalet orört. | Två verifikationer (vändning + ny): fler nummer, svårare att läsa ihop. ⚖️ konsult bekräftar datumregel. |
| D-012 | postVoucher är idempotent per (source_type, source_id): samma innehåll ger samma verifikation, annat innehåll ger IDEMPOTENCY_CONFLICT. | Dubbelbokning av en betalning ska vara omöjlig, men ett omförsök ska vara ofarligt. | Alltid fel vid dubblett: sämre för omförsök. |
| D-013 | Hash-kedjan är global (över alla serier och år, i id-ordning) och täcker rader, datum, text, källa och rättelsepekare. | Enklast att verifiera, ordningen blir bevisbar. | Kedja per serie. |

## Öppna juridiska punkter (verifieras, inte antas)
- Exakt fakturatext vid kontantmetoden mot Skatteverket (finns redan som "att verifiera" i Grund).
- Obligatoriska fakturauppgifter enligt mervärdesskattelagen kontrolleras mot fakturamallen innan första faktura.
- Konton och momskoder bekräftas av redovisningskonsult.
