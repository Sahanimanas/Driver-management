import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db_file } from './config.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export const db = new DatabaseSync(db_file);
db.exec(fs.readFileSync(path.join(here, 'schema.sql'), 'utf8'));

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
