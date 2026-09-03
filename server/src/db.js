import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db_file } from './config.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export const db = new DatabaseSync(db_file);

const SCHEMA = fs.readFileSync(path.join(here, 'schema.sql'), 'utf8');

/**
 * Databases created before the role consolidation (supervisor / admin-director /
 * finance) and the single approval stage are brought forward here, before the
 * schema is applied. Every step is idempotent, so this is safe on every boot.
 */
function migrateLegacy() {
  const tableSql = (name) =>
    db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)?.sql || '';
  const columns = (name) => {
    try {
      return db.prepare(`PRAGMA table_info(${name})`).all().map((c) => c.name);
    } catch {
      return [];
    }
  };
  const addColumn = (table, decl, col) => {
    if (columns(table).length && !columns(table).includes(col)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${decl}`);
    }
  };

  // --- new columns on existing tables --------------------------------------
  addColumn('drivers', 'referred_by TEXT', 'referred_by');
  addColumn('drivers', 'scan_id TEXT', 'scan_id');
  addColumn('drivers', 'rejection_reason TEXT', 'rejection_reason');
  addColumn('drivers', 'rejected_on TEXT', 'rejected_on');
  addColumn('employments', 'salary_structure_id INTEGER', 'salary_structure_id');
  addColumn('payroll_lines', 'salary_structure_id INTEGER', 'salary_structure_id');
  addColumn('payroll_lines', 'structure_code TEXT', 'structure_code');
  addColumn('payroll_lines', 'earnings_json TEXT', 'earnings_json');
  addColumn('payroll_lines', 'deductions_json TEXT', 'deductions_json');
  addColumn('payroll_lines', 'statutory_deduction REAL NOT NULL DEFAULT 0', 'statutory_deduction');

  // --- users: five roles collapse to three ---------------------------------
  if (columns('users').length && tableSql('users').includes('senior_manager')) {
    db.exec(`
      ALTER TABLE users RENAME TO users_legacy;
      CREATE TABLE users (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        name          TEXT    NOT NULL,
        email         TEXT    NOT NULL UNIQUE,
        phone         TEXT,
        password_hash TEXT    NOT NULL,
        role          TEXT    NOT NULL CHECK (role IN ('supervisor','admin','finance')),
        active        INTEGER NOT NULL DEFAULT 1,
        created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO users (id, name, email, phone, password_hash, role, active, created_at)
        SELECT id, name, email, phone, password_hash,
               CASE role
                 WHEN 'senior_manager' THEN 'admin'
                 WHEN 'director'       THEN 'admin'
                 WHEN 'accounts'       THEN 'finance'
                 ELSE role
               END,
               active, created_at
        FROM users_legacy;
      DROP TABLE users_legacy;
    `);
  }

  // --- advances / expenses: two approval steps collapse to one -------------
  for (const [table, extra] of [['advances', 'paid'], ['expenses', 'settled']]) {
    const cols = columns(table);
    if (!cols.length || !cols.includes('sm_by')) continue;
    addColumn(table, 'approved_by INTEGER', 'approved_by');
    addColumn(table, 'approved_at TEXT', 'approved_at');
    addColumn(table, 'approval_remarks TEXT', 'approval_remarks');
    // The last decision on record becomes the single approval.
    db.exec(`
      UPDATE ${table} SET
        approved_by      = COALESCE(director_by, sm_by),
        approved_at      = COALESCE(director_at, sm_at),
        approval_remarks = COALESCE(director_remarks, sm_remarks)
      WHERE approved_by IS NULL;
      UPDATE ${table} SET status = 'pending_approval'
       WHERE status IN ('pending_sm', 'pending_director');
    `);
    for (const c of ['sm_by', 'sm_at', 'sm_remarks', 'director_by', 'director_at', 'director_remarks']) {
      if (columns(table).includes(c)) db.exec(`ALTER TABLE ${table} DROP COLUMN ${c}`);
    }
    void extra;
  }
}

// Rebuilding a table with foreign keys pointing at it needs the constraint
// enforcement suspended; schema.sql turns it straight back on.
db.exec('PRAGMA foreign_keys = OFF');
try {
  migrateLegacy();
} catch (err) {
  console.error('[db] legacy migration failed:', err.message);
}
db.exec('PRAGMA foreign_keys = ON');

db.exec(SCHEMA);

/** node:sqlite returns null-prototype rows; normalise so they behave like POJOs. */
const plain = (row) => (row ? { ...row } : row);

export const q = {
  all(sql, ...params) {
    return db.prepare(sql).all(...params).map(plain);
  },
  get(sql, ...params) {
    return plain(db.prepare(sql).get(...params));
  },
  run(sql, ...params) {
    return db.prepare(sql).run(...params);
  },
  /** INSERT returning the new row id. */
  insert(sql, ...params) {
    return Number(db.prepare(sql).run(...params).lastInsertRowid);
  },
  /** Scalar helper: SELECT count(*) ... */
  scalar(sql, ...params) {
    const row = db.prepare(sql).get(...params);
    return row ? Object.values(row)[0] : undefined;
  },
};

/** Run fn inside a transaction (node:sqlite has no wrapper of its own). */
export function tx(fn) {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* already rolled back */
    }
    throw err;
  }
}

/** Atomically bump a named counter and return the new value. */
export function nextCounter(name) {
  q.run(
    `INSERT INTO counters(name, value) VALUES(?, 0)
     ON CONFLICT(name) DO NOTHING`,
    name,
  );
  q.run('UPDATE counters SET value = value + 1 WHERE name = ?', name);
  return Number(q.scalar('SELECT value FROM counters WHERE name = ?', name));
}

export function audit(actorId, entity, entityId, action, details) {
  q.run(
    'INSERT INTO audit_log(actor_id, entity, entity_id, action, details) VALUES (?,?,?,?,?)',
    actorId ?? null,
    entity,
    entityId == null ? null : String(entityId),
    action,
    details ? (typeof details === 'string' ? details : JSON.stringify(details)) : null,
  );
}
