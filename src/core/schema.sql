-- D&G Ekonomi, schema v0. Belopp alltid heltal i öre (SEK). Aldrig float.
PRAGMA foreign_keys = ON;

CREATE TABLE fiscal_year (
  id INTEGER PRIMARY KEY,
  start_date TEXT NOT NULL,          -- ISO, kalenderår
  end_date   TEXT NOT NULL,
  closed_at  TEXT                    -- satt vid årsstängning, därefter inga nya verifikationer
);

CREATE TABLE account (                -- BAS-kontoplan, importeras en gång
  number INTEGER PRIMARY KEY,
  name   TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);

-- Verifikation. Oföränderlig. Rättelse = ny verifikation som pekar på originalet.
CREATE TABLE voucher (
  id INTEGER PRIMARY KEY,
  fiscal_year_id INTEGER NOT NULL REFERENCES fiscal_year(id),
  series TEXT NOT NULL,              -- 'A' manuell, 'B' bank/betalning, 'K' rättelse
  number INTEGER NOT NULL,           -- löpande utan luckor per (år, serie)
  entry_date TEXT NOT NULL,          -- ISO, bokföringsdag (betaldatum vid kontantmetoden)
  registered_at TEXT NOT NULL,       -- tidsstämpel då posten skapades
  description TEXT NOT NULL,
  corrects_voucher_id INTEGER REFERENCES voucher(id),
  source_type TEXT,                  -- 'invoice_payment' | 'manual' | ...
  source_id   TEXT,                  -- id i fakturamodulen, t.ex. betalnings-id
  prev_hash TEXT NOT NULL,           -- hash-kedja: manipulation syns, hindras ej
  hash TEXT NOT NULL,
  UNIQUE (fiscal_year_id, series, number),
  UNIQUE (source_type, source_id)    -- samma betalning kan inte bokföras två gånger
);

CREATE TABLE voucher_line (
  id INTEGER PRIMARY KEY,
  voucher_id INTEGER NOT NULL REFERENCES voucher(id),
  line_no INTEGER NOT NULL,
  account_number INTEGER NOT NULL REFERENCES account(number),
  debit  INTEGER NOT NULL DEFAULT 0 CHECK (debit  >= 0),
  credit INTEGER NOT NULL DEFAULT 0 CHECK (credit >= 0),
  CHECK ((debit = 0) <> (credit = 0)),
  UNIQUE (voucher_id, line_no)
);

-- Underlag (PDF av faktura, kvitto). Arkiveras 7 år, referens via sha256.
CREATE TABLE attachment (
  id INTEGER PRIMARY KEY,
  voucher_id INTEGER REFERENCES voucher(id),
  sha256 TEXT NOT NULL,
  filename TEXT NOT NULL,
  stored_at TEXT NOT NULL
);

-- Oföränderlighet: UPDATE och DELETE stoppas i databasen, inte bara i koden.
CREATE TRIGGER voucher_no_update BEFORE UPDATE ON voucher
BEGIN SELECT RAISE(ABORT, 'voucher is immutable: post a correction voucher'); END;
CREATE TRIGGER voucher_no_delete BEFORE DELETE ON voucher
BEGIN SELECT RAISE(ABORT, 'voucher is immutable'); END;
CREATE TRIGGER line_no_update BEFORE UPDATE ON voucher_line
BEGIN SELECT RAISE(ABORT, 'voucher_line is immutable'); END;
CREATE TRIGGER line_no_delete BEFORE DELETE ON voucher_line
BEGIN SELECT RAISE(ABORT, 'voucher_line is immutable'); END;
CREATE TRIGGER attachment_no_update BEFORE UPDATE ON attachment
BEGIN SELECT RAISE(ABORT, 'attachment is immutable'); END;
CREATE TRIGGER attachment_no_delete BEFORE DELETE ON attachment
BEGIN SELECT RAISE(ABORT, 'attachment is immutable'); END;

-- Fakturamodulens tabeller (customer, invoice, invoice_line, payment) hör till
-- fakturatråden och ligger i src/invoicing/schema.sql. De refererar aldrig
-- voucher-tabellerna direkt, bara via source_type/source_id.
