-- Quantum Driver Attendance & Management -- schema

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------- users / auth
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL,
  email         TEXT    NOT NULL UNIQUE,
  phone         TEXT,
  password_hash TEXT    NOT NULL,
  role          TEXT    NOT NULL CHECK (role IN
                  ('admin','supervisor','senior_manager','director','accounts')),
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- --------------------------------------------------------------- attachments
-- Every uploaded file (photo, Aadhar copy, DL copy, receipt, bank statement,
-- generated register...) is registered here and served through /api/files/:id
-- so that access is authenticated -- these are PII documents.
CREATE TABLE IF NOT EXISTS attachments (
  id          TEXT PRIMARY KEY,
  owner_type  TEXT NOT NULL,          -- driver | expense | advance_batch | payroll | campaign | system
  owner_id    TEXT,
  kind        TEXT NOT NULL,          -- photo | aadhar | dl | receipt | txn_proof | register | statement | scan
  filename    TEXT NOT NULL,
  mime        TEXT,
  size        INTEGER,
  stored_path TEXT NOT NULL,
  uploaded_by INTEGER REFERENCES users(id),
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_attach_owner ON attachments(owner_type, owner_id);

-- ------------------------------------------------------------------- drivers
-- The *person*. Survives resignation / rejoining. All client IDs the driver
-- has ever held hang off this row (see employments) so that total longevity
-- of service can be computed.
CREATE TABLE IF NOT EXISTS drivers (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  registration_no   TEXT    NOT NULL UNIQUE,
  name              TEXT    NOT NULL,
  phone             TEXT    NOT NULL,
  photo_id          TEXT REFERENCES attachments(id),
  aadhar_no         TEXT    NOT NULL,
  address           TEXT,
  dob_aadhar        TEXT,                    -- YYYY-MM-DD, as printed on Aadhar
  dl_no             TEXT,
  dl_dob            TEXT,                    -- DOB as printed on the DL
  dl_valid_from     TEXT,
  dl_valid_till     TEXT,
  aadhar_doc_id     TEXT REFERENCES attachments(id),
  dl_doc_id         TEXT REFERENCES attachments(id),
  bank_account_name TEXT,
  bank_account_no   TEXT,
  bank_ifsc         TEXT,
  bank_name         TEXT,
  uan_no            TEXT,
  status            TEXT    NOT NULL DEFAULT 'registered'
                    CHECK (status IN ('registered','in_screening','cleared','deployed','left','rejected')),
  remarks           TEXT,
  created_by        INTEGER REFERENCES users(id),
  created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_drivers_status ON drivers(status);
CREATE INDEX IF NOT EXISTS idx_drivers_aadhar ON drivers(aadhar_no);

-- Two reference contacts (relatives) per driver.
CREATE TABLE IF NOT EXISTS driver_references (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  driver_id INTEGER NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
  name      TEXT    NOT NULL,
  relation  TEXT,
  phone     TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_refs_driver ON driver_references(driver_id);

-- ---------------------------------------------------------------- screenings
-- Trial test -> safety orientation -> medical. All three must pass before the
-- client issues an ID and the driver can be deployed.
CREATE TABLE IF NOT EXISTS screenings (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  driver_id    INTEGER NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
  type         TEXT    NOT NULL CHECK (type IN ('trial','safety','medical')),
  status       TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','passed','failed')),
  conducted_on TEXT,
  remarks      TEXT,
  recorded_by  INTEGER REFERENCES users(id),
  updated_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (driver_id, type)
);

-- -------------------------------------------------------------- employments
-- One row per deployment stint. A driver who leaves and rejoins gets a NEW
-- six digit client ID -- but the same driver_id, which is how longevity is
-- kept intact and duplicate registrations are avoided.
CREATE TABLE IF NOT EXISTS employments (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  driver_id        INTEGER NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
  client_id        TEXT    NOT NULL UNIQUE,   -- six digit ID issued by the client
  date_of_joining  TEXT    NOT NULL,          -- billing starts from this date
  date_of_leaving  TEXT,
  vehicle_number   TEXT,
  location         TEXT,
  monthly_wage     REAL    NOT NULL DEFAULT 0,
  status           TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active','ended')),
  exit_reason      TEXT,
  created_by       INTEGER REFERENCES users(id),
  created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_emp_driver ON employments(driver_id);
CREATE INDEX IF NOT EXISTS idx_emp_status ON employments(status);

-- --------------------------------------------------------------- attendance
-- T = Training, TA = In Transit, P = Driving/Present, L = Leave, LE = Left.
-- Default for a deployed driver is P.
CREATE TABLE IF NOT EXISTS attendance (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  employment_id INTEGER NOT NULL REFERENCES employments(id) ON DELETE CASCADE,
  day           TEXT    NOT NULL,             -- YYYY-MM-DD
  code          TEXT    NOT NULL CHECK (code IN ('T','TA','P','L','LE')),
  remarks       TEXT,
  locked        INTEGER NOT NULL DEFAULT 0,   -- set once payroll is finalised
  marked_by     INTEGER REFERENCES users(id),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (employment_id, day)
);
CREATE INDEX IF NOT EXISTS idx_att_day ON attendance(day);

-- ---------------------------------------------------------------- insurance
CREATE TABLE IF NOT EXISTS insurance (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  driver_id  INTEGER NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
  type       TEXT    NOT NULL CHECK (type IN ('GMC','GPA','GTL','WC')),
  covered    INTEGER NOT NULL DEFAULT 0,
  policy_no  TEXT,
  valid_from TEXT,
  valid_to   TEXT,
  remarks    TEXT,
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (driver_id, type)
);

-- ----------------------------------------------------------------- advances
-- Supervisor raises -> Senior Manager -> Director -> Accounts pays.
-- If a Senior Manager raises it, it goes straight to the Director.
CREATE TABLE IF NOT EXISTS advances (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  driver_id         INTEGER NOT NULL REFERENCES drivers(id),
  employment_id     INTEGER REFERENCES employments(id),
  amount            REAL    NOT NULL CHECK (amount > 0),
  reason            TEXT    NOT NULL,
  request_date      TEXT    NOT NULL,
  status            TEXT    NOT NULL DEFAULT 'pending_sm'
                    CHECK (status IN ('pending_sm','pending_director','approved','rejected','paid')),
  requested_by      INTEGER NOT NULL REFERENCES users(id),
  requested_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  sm_by             INTEGER REFERENCES users(id),
  sm_at             TEXT,
  sm_remarks        TEXT,
  director_by       INTEGER REFERENCES users(id),
  director_at       TEXT,
  director_remarks  TEXT,
  cutoff            TEXT,                     -- NOON | EVENING (assigned at request time)
  batch_id          INTEGER REFERENCES payment_batches(id),
  paid_at           TEXT,
  utr               TEXT,
  recovered         REAL    NOT NULL DEFAULT 0,   -- deducted through salary
  tally_export_id   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_adv_status ON advances(status);
CREATE INDEX IF NOT EXISTS idx_adv_driver ON advances(driver_id);

-- ----------------------------------------------------------- payment batches
-- Requests are accumulated to the noon and the 18:30 cut-off, then paid either
-- through internet banking (<= 4 requests) or by uploading a bank sheet (> 4).
CREATE TABLE IF NOT EXISTS payment_batches (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  kind         TEXT    NOT NULL CHECK (kind IN ('advance','expense','salary')),
  batch_date   TEXT    NOT NULL,
  cutoff       TEXT    CHECK (cutoff IN ('NOON','EVENING')),
  method       TEXT    NOT NULL CHECK (method IN ('netbanking','sheet')),
  item_count   INTEGER NOT NULL DEFAULT 0,
  total_amount REAL    NOT NULL DEFAULT 0,
  status       TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open','paid')),
  sheet_id     TEXT REFERENCES attachments(id),
  created_by   INTEGER REFERENCES users(id),
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  paid_at      TEXT
);

-- ----------------------------------------------------------------- expenses
-- Petty cash / purchase requests raised by supervisors.
-- < Rs 3000  -> Senior Manager approves, supervisor pays from petty cash and
--               uploads the supporting documents.
-- >= Rs 3000 -> Senior Manager AND Director approve, accounts pays directly.
CREATE TABLE IF NOT EXISTS expenses (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  driver_id        INTEGER REFERENCES drivers(id),
  purpose          TEXT    NOT NULL,
  category         TEXT,                       -- safety_shoe | medical | fuel | other
  amount           REAL    NOT NULL CHECK (amount > 0),
  kind             TEXT    NOT NULL CHECK (kind IN ('reimbursement','expense')),
  route            TEXT    NOT NULL CHECK (route IN ('petty_cash','accounts')),
  request_date     TEXT    NOT NULL,
  status           TEXT    NOT NULL DEFAULT 'pending_sm'
                   CHECK (status IN ('pending_sm','pending_director','approved','rejected','settled')),
  requested_by     INTEGER NOT NULL REFERENCES users(id),
  requested_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  sm_by            INTEGER REFERENCES users(id),
  sm_at            TEXT,
  sm_remarks       TEXT,
  director_by      INTEGER REFERENCES users(id),
  director_at      TEXT,
  director_remarks TEXT,
  settled_at       TEXT,
  settled_by       INTEGER REFERENCES users(id),
  paid_amount      REAL,
  txn_ref          TEXT,
  batch_id         INTEGER REFERENCES payment_batches(id)
);
CREATE INDEX IF NOT EXISTS idx_exp_status ON expenses(status);

-- --------------------------------------------------------------- petty cash
CREATE TABLE IF NOT EXISTS petty_cash (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  supervisor_id INTEGER NOT NULL REFERENCES users(id),
  direction     TEXT    NOT NULL CHECK (direction IN ('issue','spend','return')),
  amount        REAL    NOT NULL CHECK (amount > 0),
  expense_id    INTEGER REFERENCES expenses(id),
  note          TEXT,
  entry_date    TEXT    NOT NULL,
  created_by    INTEGER REFERENCES users(id),
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ------------------------------------------------------------------ payroll
CREATE TABLE IF NOT EXISTS payroll_periods (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  period          TEXT    NOT NULL UNIQUE,   -- YYYY-MM
  status          TEXT    NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','attendance_finalized','reviewed','paid','closed')),
  client_confirmed INTEGER NOT NULL DEFAULT 0,
  client_remarks  TEXT,
  finalized_by    INTEGER REFERENCES users(id),
  finalized_at    TEXT,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS payroll_lines (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  period_id         INTEGER NOT NULL REFERENCES payroll_periods(id) ON DELETE CASCADE,
  employment_id     INTEGER NOT NULL REFERENCES employments(id),
  days_in_period    INTEGER NOT NULL DEFAULT 0,
  present_days      INTEGER NOT NULL DEFAULT 0,
  training_days     INTEGER NOT NULL DEFAULT 0,
  transit_days      INTEGER NOT NULL DEFAULT 0,
  leave_days        INTEGER NOT NULL DEFAULT 0,
  left_days         INTEGER NOT NULL DEFAULT 0,
  payable_days      REAL    NOT NULL DEFAULT 0,
  rate_per_day      REAL    NOT NULL DEFAULT 0,
  gross             REAL    NOT NULL DEFAULT 0,
  advance_deduction REAL    NOT NULL DEFAULT 0,
  other_deduction   REAL    NOT NULL DEFAULT 0,
  net_payable       REAL    NOT NULL DEFAULT 0,
  hold              INTEGER NOT NULL DEFAULT 0,
  hold_reason       TEXT,
  paid_amount       REAL,
  paid_on           TEXT,
  utr               TEXT,
  status            TEXT    NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','held','in_bank','paid')),
  UNIQUE (period_id, employment_id)
);

-- ------------------------------------------------------------ tally exports
CREATE TABLE IF NOT EXISTS tally_exports (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  kind         TEXT    NOT NULL CHECK (kind IN ('advance','expense','salary')),
  period_from  TEXT,
  period_to    TEXT,
  entry_count  INTEGER NOT NULL DEFAULT 0,
  total_amount REAL    NOT NULL DEFAULT 0,
  xml_id       TEXT REFERENCES attachments(id),
  xlsx_id      TEXT REFERENCES attachments(id),
  created_by   INTEGER REFERENCES users(id),
  created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- -------------------------------------------------- whatsapp mass messaging
CREATE TABLE IF NOT EXISTS campaigns (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  title         TEXT    NOT NULL,
  body          TEXT    NOT NULL,
  audience      TEXT    NOT NULL,             -- JSON filter description
  status        TEXT    NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sending','sent')),
  total         INTEGER NOT NULL DEFAULT 0,
  sent_count    INTEGER NOT NULL DEFAULT 0,
  failed_count  INTEGER NOT NULL DEFAULT 0,
  created_by    INTEGER REFERENCES users(id),
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  sent_at       TEXT
);

CREATE TABLE IF NOT EXISTS campaign_recipients (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  driver_id   INTEGER REFERENCES drivers(id),
  phone       TEXT    NOT NULL,
  status      TEXT    NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','failed')),
  provider_id TEXT,
  error       TEXT,
  sent_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_recip_campaign ON campaign_recipients(campaign_id);

-- --------------------------------------------------------------- audit trail
CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id   INTEGER REFERENCES users(id),
  entity     TEXT NOT NULL,
  entity_id  TEXT,
  action     TEXT NOT NULL,
  details    TEXT,
  at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity, entity_id);

-- ------------------------------------------------------------------ counters
CREATE TABLE IF NOT EXISTS counters (
  name  TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
