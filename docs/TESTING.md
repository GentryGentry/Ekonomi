# Testupplägg

- Vitest. `npm test` körs i CI och före varje merge.
- Tre nivåer: (1) databasinvarianter (triggers, unika nummer, balans), (2) kärnlogik (post, rätta, integritet), (3) flöde faktura till betalning till verifikation.
- Egenskapstester för pengar: summa debet = summa kredit, ingen verifikation utan balans, nummer gapfria efter slumpade sekvenser.
- Golden files: genererad faktura-PDF och SIE-export jämförs mot förväntad utdata.
- Fixtures är påhittade. Aldrig riktig kund- eller medlemsdata.
- Regel: varje buggfix får ett test som faller först.
