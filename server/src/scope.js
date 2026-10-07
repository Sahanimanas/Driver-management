import { q } from './db.js';
import { notFound } from './util.js';

/**
 * What a field user (a supervisor) may see.
 *
 * A driver is deployed under one supervisor (employments.supervisor_id). A
 * field user sees the drivers deployed under them, and the pool of drivers who
 * are not deployed at all -- they register, screen and deploy from that pool.
 * A driver deployed under another supervisor is invisible to them, along with
 * that driver's attendance, advances, challans and expenses.
 *
 * A live deployment with no supervisor recorded is visible to every field
 * user, so nothing goes missing until Admin assigns one.
 *
 * Everyone else (Admin / Director, Finance, non-field custom roles) sees all.
 */
const ALL = { sql: '1 = 1', params: [] };

/** SQL condition on a drivers row aliased `alias`. */
export function driverScope(user, alias = 'd') {
  if (!user?.field) return ALL;
  return {
    sql: `NOT EXISTS (SELECT 1 FROM employments sx WHERE sx.driver_id = ${alias}.id AND sx.status = 'active'
            AND sx.supervisor_id IS NOT NULL AND sx.supervisor_id <> ?)`,
    params: [user.id],
  };
}

/** SQL condition on an employments row aliased `alias`. */
export function employmentScope(user, alias = 'e') {
  if (!user?.field) return ALL;
  return { sql: `(${alias}.supervisor_id IS NULL OR ${alias}.supervisor_id = ?)`, params: [user.id] };
}

export function canSeeDriver(user, driverId) {
  if (!user?.field) return true;
  const s = driverScope(user, 'd');
  return Boolean(q.get(`SELECT 1 FROM drivers d WHERE d.id = ? AND ${s.sql}`, Number(driverId), ...s.params));
}

/** A driver outside the user's scope is reported as not found, not forbidden. */
export function assertDriver(user, driverId) {
  if (!canSeeDriver(user, driverId)) throw notFound('Driver not found');
}

export function canSeeEmployment(user, emp) {
  return !user?.field || !emp?.supervisor_id || emp.supervisor_id === user.id;
}

export function assertEmployment(user, emp) {
  if (!emp || !canSeeEmployment(user, emp)) throw notFound('Deployment not found');
}
