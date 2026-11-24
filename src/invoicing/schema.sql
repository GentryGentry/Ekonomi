-- Faktureringsmodulens schema. Belopp i öre (heltal). Refererar aldrig voucher-tabellerna,
-- bara via payment.voucher_id (id som kärnan returnerat) och source_type/source_id i kärnan.

-- Utfärdare är data: enskild firma nu, AB senare med egen serie.
CREATE TABLE issuer (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  address_lines TEXT NOT NULL,        -- radbruten adress
  vat_number TEXT NOT NULL,           -- momsregistreringsnummer
  org_number TEXT,
  f_skatt INTEGER NOT NULL DEFAULT 0, -- "Godkänd för F-skatt"
  cash_method INTEGER NOT NULL DEFAULT 0,
  cash_method_text TEXT,              -- text enligt Skatteverket. Ingen standardtext (öppen punkt).
  payment_days INTEGER NOT NULL,      -- betalningsvillkor i dagar (värdet kommer från Notion Grund)
  first_number INTEGER NOT NULL,      -- första fakturanummer i serien
  bankgiro TEXT,
  bank_account TEXT,                  -- fritext, t.ex. clearing+kontonr
  contact_email TEXT,
  active INTEGER NOT NULL DEFAULT 1
);

-- Gapfri nummerserie per utfärdare. Nästa nummer ändras i samma transaktion som fakturan utfärdas.
CREATE TABLE number_series (
  issuer_id INTEGER PRIMARY KEY REFERENCES issuer(id),
  next_number INTEGER NOT NULL
);

CREATE TABLE customer (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  org_number TEXT,
  address_lines TEXT NOT NULL,
  reference TEXT,                     -- "Er referens"
  email TEXT
);

CREATE TABLE article (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL,
  unit TEXT NOT NULL DEFAULT 'st',
  unit_price_ore INTEGER NOT NULL CHECK (unit_price_ore >= 0),
  vat_rate INTEGER NOT NULL,          -- procent
  revenue_account INTEGER NOT NULL,   -- BAS-konto, bekräftas av konsult
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE invoice (
  id INTEGER PRIMARY KEY,
  issuer_id INTEGER NOT NULL REFERENCES issuer(id),
  customer_id INTEGER NOT NULL REFERENCES customer(id),
  kind TEXT NOT NULL CHECK (kind IN ('invoice','credit')),
  credits_invoice_id INTEGER REFERENCES invoice(id),
  status TEXT NOT NULL CHECK (status IN ('draft','issued')),
  number INTEGER,                     -- NULL tills utfärdad
  invoice_date TEXT,
  delivery_date TEXT,                 -- leveransdatum eller period (fritext, ISO eller "2026-01-01 – 2026-01-31")
  due_date TEXT,
  customer_reference TEXT,
  issued_at TEXT,
  pdf_sha256 TEXT,
  pdf BLOB,
  UNIQUE (issuer_id, number),
  CHECK (status = 'draft' OR (number IS NOT NULL AND invoice_date IS NOT NULL AND delivery_date IS NOT NULL
                              AND due_date IS NOT NULL AND pdf_sha256 IS NOT NULL)),
  CHECK (kind = 'invoice' OR credits_invoice_id IS NOT NULL)
);

CREATE TABLE invoice_line (
  id INTEGER PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES invoice(id),
  line_no INTEGER NOT NULL,
  article_code TEXT,
  description TEXT NOT NULL,
  unit TEXT NOT NULL,
  qty_milli INTEGER NOT NULL CHECK (qty_milli <> 0),  -- antal i tusendelar (1 st = 1000). Negativt på kreditfaktura.
  unit_price_ore INTEGER NOT NULL CHECK (unit_price_ore >= 0),
  vat_rate INTEGER NOT NULL,
  revenue_account INTEGER NOT NULL,
  UNIQUE (invoice_id, line_no)
);

CREATE TABLE payment (
  id TEXT PRIMARY KEY,                -- betalnings-id, används som idempotensnyckel mot kärnan
  invoice_id INTEGER NOT NULL REFERENCES invoice(id),
  paid_date TEXT NOT NULL,
  amount_ore INTEGER NOT NULL CHECK (amount_ore > 0),
  net_ore INTEGER NOT NULL,
  vat_ore INTEGER NOT NULL,
  voucher_id INTEGER,                 -- sätts när kärnan bokfört
  voucher_number TEXT
);

CREATE TABLE reminder (
  id INTEGER PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES invoice(id),
  reminder_date TEXT NOT NULL,
  fee_ore INTEGER NOT NULL DEFAULT 0 CHECK (fee_ore >= 0),
  new_due_date TEXT NOT NULL,
  pdf_sha256 TEXT NOT NULL,
  pdf BLOB NOT NULL
);

-- Oföränderlighet: en utfärdad faktura och dess rader kan aldrig ändras eller tas bort.
-- Fel rättas med kreditfaktura (egen nummer) plus ny faktura.
CREATE TRIGGER invoice_no_update BEFORE UPDATE ON invoice WHEN OLD.status <> 'draft'
BEGIN SELECT RAISE(ABORT, 'invoice is immutable once issued: issue a credit note'); END;
CREATE TRIGGER invoice_no_delete BEFORE DELETE ON invoice WHEN OLD.status <> 'draft'
BEGIN SELECT RAISE(ABORT, 'invoice is immutable once issued'); END;
CREATE TRIGGER invoice_line_no_update BEFORE UPDATE ON invoice_line
WHEN (SELECT status FROM invoice WHERE id = OLD.invoice_id) <> 'draft'
BEGIN SELECT RAISE(ABORT, 'invoice_line is immutable once issued'); END;
CREATE TRIGGER invoice_line_no_delete BEFORE DELETE ON invoice_line
WHEN (SELECT status FROM invoice WHERE id = OLD.invoice_id) <> 'draft'
BEGIN SELECT RAISE(ABORT, 'invoice_line is immutable once issued'); END;
CREATE TRIGGER invoice_line_no_insert BEFORE INSERT ON invoice_line
WHEN (SELECT status FROM invoice WHERE id = NEW.invoice_id) <> 'draft'
BEGIN SELECT RAISE(ABORT, 'cannot add lines to an issued invoice'); END;

-- Betalningar och påminnelser är historik: bara voucher_id får sättas, en gång.
CREATE TRIGGER payment_no_delete BEFORE DELETE ON payment
BEGIN SELECT RAISE(ABORT, 'payment is immutable'); END;
CREATE TRIGGER payment_limited_update BEFORE UPDATE ON payment
WHEN OLD.voucher_id IS NOT NULL OR NEW.id <> OLD.id OR NEW.invoice_id <> OLD.invoice_id
  OR NEW.paid_date <> OLD.paid_date OR NEW.amount_ore <> OLD.amount_ore
  OR NEW.net_ore <> OLD.net_ore OR NEW.vat_ore <> OLD.vat_ore
BEGIN SELECT RAISE(ABORT, 'payment is immutable'); END;
CREATE TRIGGER reminder_no_update BEFORE UPDATE ON reminder
BEGIN SELECT RAISE(ABORT, 'reminder is immutable'); END;
CREATE TRIGGER reminder_no_delete BEFORE DELETE ON reminder
BEGIN SELECT RAISE(ABORT, 'reminder is immutable'); END;
CREATE TRIGGER number_series_forward_only BEFORE UPDATE ON number_series
WHEN NEW.next_number <> OLD.next_number + 1
BEGIN SELECT RAISE(ABORT, 'number series only moves forward by one'); END;
