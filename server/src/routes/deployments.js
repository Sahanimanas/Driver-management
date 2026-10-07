import { Router } from 'express';
import { q, tx, audit } from '../db.js';
import { authenticate, allow, fieldRoles } from '../auth.js';
import { employmentScope, assertDriver, assertEmployment } from '../scope.js';
import { loadStructure } from './salary-master.js';
import { blacklist } from './drivers.js';
import { checkLocation } from './settings.js';
import { h, need, bad, notFound, isDate, today, diffDays, humanDuration, digits, money } from '../util.js';

const router = Router();
router.use(authenticate);

const SCREENING_TYPES = ['trial', 'safety', 'medical'];

/**
 * The loyalty service allowance a driver is entitled to each month. It is set
 * per driver -- in the client's register most carry none and a few 1,500 or
 * 3,000 -- and the pay engine prorates it by attendance like any allowance.
 */
function lsaMonthly(v) {
  if (v === undefined || v === null || v === '') return 0;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 100000) {
    throw bad('LSA must be an amount between 0 and 1,00,000 a month');
  }
  return money(n);
}

/**
 * The supervisor a driver is deployed under. Must be an active user in a field
 * role (Supervisor, or a custom role marked as one). Left blank, it is the
 * person deploying, if they are a supervisor themselves.
 */
function checkSupervisor(value, user) {
  const roles = fieldRoles();
  if (value === undefined || value === null || value === '') {
    if (user.field) return user.id;
    const anyone = roles.length && q.get(
      `SELECT 1 FROM users WHERE active = 1 AND role IN (${roles.map(() => '?').join(',')})`, ...roles,
    );
    if (anyone) throw bad('Choose the supervisor this driver is deployed under.', { code: 'NO_SUPERVISOR' });
    return null;
  }
  const sup = q.get('SELECT id, role, active FROM users WHERE id = ?', Number(value));
  if (!sup || !sup.active || !roles.includes(sup.role)) {
    throw bad('The supervisor must be an active user in a supervisor role.');
  }
  return sup.id;
}

/** Everyone a driver can be deployed under, for the deployment screen. */
router.get(
  '/supervisors',
  h(async (_req, res) => {
    const roles = fieldRoles();
    if (!roles.length) return res.json([]);
    res.json(q.all(
      `SELECT u.id, u.name, u.role, r.label AS role_label,
              (SELECT count(*) FROM employments e WHERE e.supervisor_id = u.id AND e.status = 'active') AS deployed
         FROM users u LEFT JOIN roles r ON r.key = u.role
        WHERE u.active = 1 AND u.role IN (${roles.map(() => '?').join(',')})
        ORDER BY u.name`,
      ...roles,
    ));
  }),
);

/**
 * Registered but not deployed: the drivers a supervisor can put forward.
 * Blacklisted and client-rejected drivers are left out; a driver who left and
 * may rejoin is in, with the date they last left.
 */
router.get(
  '/undeployed',
  h(async (req, res) => {
    const search = String(req.query.search || '').trim();
    const params = [];
    let filter = '';
    if (search) {
      filter = 'AND (d.name LIKE ? OR d.registration_no LIKE ? OR d.phone LIKE ?)';
      const like = `%${search}%`;
      params.push(like, like, like);
    }
    const rows = q.all(
      `SELECT d.id, d.registration_no, d.name, d.phone, d.photo_id, d.status, d.created_at,
              d.bank_account_no, d.bank_ifsc,
              (SELECT count(*) FROM screenings s WHERE s.driver_id = d.id AND s.status = 'passed') AS screenings_passed,
              (SELECT count(*) FROM screenings s WHERE s.driver_id = d.id AND s.status = 'failed') AS screenings_failed,
              (SELECT e.date_of_leaving FROM employments e WHERE e.driver_id = d.id
                ORDER BY e.date_of_joining DESC LIMIT 1) AS last_left_on,
              (SELECT e.client_id FROM employments e WHERE e.driver_id = d.id
                ORDER BY e.date_of_joining DESC LIMIT 1) AS last_client_id
         FROM drivers d
        WHERE d.blacklisted = 0 AND d.status <> 'rejected'
          AND NOT EXISTS (SELECT 1 FROM employments e WHERE e.driver_id = d.id AND e.status = 'active')
          ${filter}
        ORDER BY d.created_at DESC`,
      ...params,
    );
    res.json(rows.map((r) => ({
      ...r,
      screenings_total: SCREENING_TYPES.length,
      ready: Number(r.screenings_passed) === SCREENING_TYPES.length,
    })));
  }),
);

/**
 * Blacklisted drivers, with the date they left -- which is the date recorded
 * in the attendance sheet (marking LE there, or ending the deployment, writes
 * it onto the deployment).
 */
router.get(
  '/blacklisted',
  h(async (_req, res) => {
    res.json(q.all(
      `SELECT d.id, d.registration_no, d.name, d.phone, d.photo_id, d.status,
              d.blacklisted_on, d.blacklist_reason, u.name AS blacklisted_by_name,
              e.client_id AS last_client_id, e.location AS last_location,
              e.date_of_joining AS last_joined_on, e.date_of_leaving, e.exit_reason
         FROM drivers d
         LEFT JOIN users u ON u.id = d.blacklisted_by
         LEFT JOIN employments e ON e.id = (
           SELECT id FROM employments WHERE driver_id = d.id ORDER BY date_of_joining DESC LIMIT 1)
        WHERE d.blacklisted = 1
        ORDER BY d.blacklisted_on DESC`,
    ));
  }),
);

router.get(
  '/',
  h(async (req, res) => {
    const { status = 'active', location = '', search = '' } = req.query;
    const where = [];
    const params = [];
    if (status) {
      where.push('e.status = ?');
      params.push(status);
    }
    if (location) {
      where.push('e.location = ?');
      params.push(location);
    }
    if (search) {
      where.push('(d.name LIKE ? OR e.client_id LIKE ? OR e.vehicle_number LIKE ? OR d.registration_no LIKE ?)');
      const like = `%${search}%`;
      params.push(like, like, like, like);
    }
    if (req.query.supervisor_id) {
      where.push('e.supervisor_id = ?');
      params.push(Number(req.query.supervisor_id));
    }
    const scope = employmentScope(req.user);
    where.push(scope.sql);
    params.push(...scope.params);
    res.json(
      q.all(
        `SELECT e.*, d.name, d.registration_no, d.phone, d.photo_id, d.status AS driver_status,
                d.blacklisted, s.name AS salary_class, s.code AS salary_class_code,
                su.name AS supervisor_name
         FROM employments e JOIN drivers d ON d.id = e.driver_id
         LEFT JOIN salary_structures s ON s.id = e.salary_structure_id
         LEFT JOIN users su ON su.id = e.supervisor_id
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY e.date_of_joining DESC`,
        ...params,
      ),
    );
  }),
);

/**
 * Deploy a driver: the client has issued a six digit ID and a date of joining,
 * which is the date billing starts. A rejoining driver gets a brand new ID but
 * stays attached to the same driver record so longevity survives.
 */
router.post(
  '/',
  allow('deployments.manage'),
  h(async (req, res) => {
    need(req.body, ['driver_id', 'client_id', 'date_of_joining']);
    const driverId = Number(req.body.driver_id);
    const driver = q.get('SELECT * FROM drivers WHERE id = ?', driverId);
    if (!driver) throw notFound('Driver not found');
    assertDriver(req.user, driverId);
    if (driver.blacklisted) {
      throw bad(
        `${driver.name} is blacklisted (${driver.blacklist_reason || 'no reason recorded'}). `
          + 'The blacklist has to be lifted by Admin / Director before they can be deployed.',
        { code: 'BLACKLISTED' },
      );
    }

    const clientId = String(req.body.client_id).trim();
    if (!/^\d{6}$/.test(clientId)) throw bad('Client ID must be exactly six digits');

    const doj = String(req.body.date_of_joining);
    if (!isDate(doj)) throw bad('Date of joining must be YYYY-MM-DD');

    const taken = q.get(
      `SELECT e.client_id, d.name, d.registration_no FROM employments e
       JOIN drivers d ON d.id = e.driver_id WHERE e.client_id = ?`,
      clientId,
    );
    if (taken) throw bad(`Client ID ${clientId} is already allotted to ${taken.name} (${taken.registration_no})`);

    const screenings = q.all('SELECT type, status FROM screenings WHERE driver_id = ?', driverId);
    const pending = SCREENING_TYPES.filter(
      (t) => screenings.find((s) => s.type === t)?.status !== 'passed',
    );
    if (pending.length && !req.body.override_screening) {
      throw bad(
        `Driver has not cleared: ${pending.join(', ')}. A driver can only be deployed after the ` +
          'trial test, safety orientation and medical are all passed.',
        { code: 'SCREENING_INCOMPLETE', pending },
      );
    }

    const open = q.get("SELECT * FROM employments WHERE driver_id = ? AND status = 'active'", driverId);
    if (open) {
      throw bad(
        `Driver is already deployed under client ID ${open.client_id}. End that deployment first.`,
        { code: 'ALREADY_DEPLOYED', employmentId: open.id },
      );
    }

    // "Once driver is deployed, it is linked to a salary structure." The salary
    // class is mandatory on the deployment screen; the wage comes from it.
    const structure = loadStructure(req.body.salary_structure_id);
    if (req.body.salary_structure_id && !structure) throw notFound('Salary structure not found');
    if (!structure) {
      throw bad('Pick the salary class for this deployment.', { code: 'NO_SALARY_STRUCTURE' });
    }
    const location = checkLocation(req.body.location);
    const supervisorId = checkSupervisor(req.body.supervisor_id, req.user);
    if (structure && !structure.active) {
      throw bad(`Salary structure ${structure.code} is no longer active — pick a current one.`);
    }

    // "Point 10 and 11 can be populated in deployment step" — the bank details
    // and the UAN. This is the last point at which they can be supplied, so
    // they are taken here and written back onto the driver.
    const bankPatch = {};
    if (req.body.bank_account_no) bankPatch.bank_account_no = digits(req.body.bank_account_no);
    if (req.body.bank_ifsc) bankPatch.bank_ifsc = String(req.body.bank_ifsc).toUpperCase().trim();
    if (req.body.bank_name) bankPatch.bank_name = String(req.body.bank_name).trim();
    if (req.body.bank_branch) bankPatch.bank_branch = String(req.body.bank_branch).trim();
    if (req.body.bank_account_name) bankPatch.bank_account_name = String(req.body.bank_account_name).trim();
    if (req.body.uan_no) bankPatch.uan_no = digits(req.body.uan_no);

    if (bankPatch.bank_ifsc && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(bankPatch.bank_ifsc)) {
      throw bad('IFSC code must be 11 characters, e.g. SBIN0004521');
    }

    const merged = { ...driver, ...bankPatch };
    if ((!merged.bank_account_no || !merged.bank_ifsc) && !req.body.allow_missing_bank) {
      throw bad(
        'Bank account number and IFSC are needed before a driver can be paid. Supply them here, '
          + 'or deploy with allow_missing_bank and add them before the first payment run.',
        { code: 'MISSING_BANK_DETAILS' },
      );
    }

    const id = tx(() => {
      const empId = q.insert(
        `INSERT INTO employments
           (driver_id, client_id, date_of_joining, vehicle_number, location, monthly_wage,
            salary_structure_id, lsa_monthly, supervisor_id, created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        driverId,
        clientId,
        doj,
        req.body.vehicle_number ? String(req.body.vehicle_number).toUpperCase().replace(/\s/g, '') : null,
        location,
        // The structure sets the wage unless one is entered explicitly.
        money(req.body.monthly_wage || structure?.monthly_gross || 0),
        structure?.id || null,
        lsaMonthly(req.body.lsa_monthly),
        supervisorId,
        req.user.id,
      );
      if (Object.keys(bankPatch).length) {
        q.run(
          `UPDATE drivers SET ${Object.keys(bankPatch).map((k) => `${k} = ?`).join(', ')},
                  updated_at = datetime('now') WHERE id = ?`,
          ...Object.values(bankPatch), driverId,
        );
      }
      q.run(
        `UPDATE drivers SET status = 'deployed', rejection_reason = NULL, rejected_on = NULL,
                updated_at = datetime('now') WHERE id = ?`,
        driverId,
      );
      audit(req.user.id, 'employment', empId, 'deployed', {
        clientId, doj, driverId, salaryStructure: structure?.code || null, supervisorId,
      });
      return empId;
    });

    const priorStints = q.scalar('SELECT count(*) FROM employments WHERE driver_id = ?', driverId);
    res.status(201).json({
      employment: q.get('SELECT * FROM employments WHERE id = ?', id),
      salaryStructure: structure ? { code: structure.code, name: structure.name } : null,
      rejoin: Number(priorStints) > 1,
      message:
        Number(priorStints) > 1
          ? `New ID ${clientId} linked to ${driver.name} (${driver.registration_no}) — this is stint #${priorStints}, earlier service is retained.`
          : `${driver.name} deployed with client ID ${clientId}. Billing starts ${doj}.`,
    });
  }),
);

router.patch(
  '/:id',
  allow('deployments.edit'),
  h(async (req, res) => {
    const emp = q.get('SELECT * FROM employments WHERE id = ?', Number(req.params.id));
    assertEmployment(req.user, emp);

    const patch = {};
    ['vehicle_number', 'location', 'monthly_wage', 'date_of_joining', 'salary_structure_id',
      'lsa_monthly', 'supervisor_id'].forEach((k) => {
      if (req.body[k] !== undefined) patch[k] = req.body[k];
    });
    if (patch.salary_structure_id) {
      // "Driver's deployed vehicle and location are changed" is the common
      // edit, but a structure change has to point at a real structure.
      const structure = loadStructure(patch.salary_structure_id);
      if (!structure) throw notFound('Salary structure not found');
      patch.salary_structure_id = structure.id;
      if (req.body.monthly_wage === undefined) patch.monthly_wage = structure.monthly_gross;
    }
    if (patch.date_of_joining && !isDate(patch.date_of_joining)) throw bad('Date of joining must be YYYY-MM-DD');
    if (patch.location !== undefined) patch.location = checkLocation(patch.location);
    if (patch.vehicle_number) patch.vehicle_number = String(patch.vehicle_number).toUpperCase().replace(/\s/g, '');
    if (patch.monthly_wage !== undefined) patch.monthly_wage = Number(patch.monthly_wage) || 0;
    if (patch.lsa_monthly !== undefined) patch.lsa_monthly = lsaMonthly(patch.lsa_monthly);
    if (patch.supervisor_id !== undefined) patch.supervisor_id = checkSupervisor(patch.supervisor_id, req.user);
    if (!Object.keys(patch).length) throw bad('Nothing to update');

    q.run(
      `UPDATE employments SET ${Object.keys(patch).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
      ...Object.values(patch), emp.id,
    );
    audit(req.user.id, 'employment', emp.id, 'updated', patch);
    res.json(q.get('SELECT * FROM employments WHERE id = ?', emp.id));
  }),
);

/** End a stint — resignation or removal. Attendance is closed off with LE. */
router.post(
  '/:id/end',
  allow('deployments.manage'),
  h(async (req, res) => {
    const emp = q.get('SELECT * FROM employments WHERE id = ?', Number(req.params.id));
    assertEmployment(req.user, emp);
    if (emp.status === 'ended') throw bad('This deployment has already been closed');

    const lastDay = req.body.date_of_leaving || today();
    if (!isDate(lastDay)) throw bad('date_of_leaving must be YYYY-MM-DD');
    const blacklistReason = req.body.blacklist ? String(req.body.blacklist_reason || '').trim() : '';
    if (req.body.blacklist && blacklistReason.length < 3) {
      throw bad('Record the reason for blacklisting the driver');
    }
    if (diffDays(emp.date_of_joining, lastDay) < 0) {
      throw bad('Date of leaving cannot be before the date of joining');
    }

    tx(() => {
      q.run(
        "UPDATE employments SET status = 'ended', date_of_leaving = ?, exit_reason = ? WHERE id = ?",
        lastDay, req.body.exit_reason || null, emp.id,
      );
      q.run(
        `INSERT INTO attendance(employment_id, day, code, remarks, marked_by)
         VALUES (?,?, 'LE', ?, ?)
         ON CONFLICT(employment_id, day) DO UPDATE SET
           code = 'LE', remarks = excluded.remarks, updated_at = datetime('now')
         WHERE locked = 0`,
        emp.id, lastDay, req.body.exit_reason || 'Resigned / left', req.user.id,
      );
      const others = q.scalar(
        "SELECT count(*) FROM employments WHERE driver_id = ? AND status = 'active' AND id <> ?",
        emp.driver_id, emp.id,
      );
      if (!Number(others)) {
        q.run("UPDATE drivers SET status = 'left', updated_at = datetime('now') WHERE id = ?", emp.driver_id);
      }
      audit(req.user.id, 'employment', emp.id, 'ended', { lastDay, reason: req.body.exit_reason });
      if (req.body.blacklist) blacklist(emp.driver_id, blacklistReason, req.user.id);
    });

    const stints = q.all('SELECT date_of_joining, date_of_leaving FROM employments WHERE driver_id = ?', emp.driver_id);
    const days = stints.reduce(
      (s, e) => s + Math.max(0, diffDays(e.date_of_joining, e.date_of_leaving || today())), 0,
    );
    res.json({
      employment: q.get('SELECT * FROM employments WHERE id = ?', emp.id),
      totalService: { days, label: humanDuration(days), stints: stints.length },
    });
  }),
);

/**
 * "Or its rejected... and capture reason of rejection."
 *
 * The client declines to issue an ID. No employment is created; the driver is
 * marked rejected with the reason on record, and stays in the system so the
 * decision is auditable and the person can be put forward again later.
 */
router.post(
  '/reject',
  allow('drivers.blacklist'),
  h(async (req, res) => {
    need(req.body, ['driver_id', 'reason']);
    const driverId = Number(req.body.driver_id);
    const driver = q.get('SELECT * FROM drivers WHERE id = ?', driverId);
    if (!driver) throw notFound('Driver not found');
    assertDriver(req.user, driverId);
    if (driver.status === 'deployed') {
      throw bad('This driver is currently deployed — end the deployment instead of rejecting them.');
    }

    const on = req.body.rejected_on || today();
    if (!isDate(on)) throw bad('rejected_on must be YYYY-MM-DD');
    const reason = String(req.body.reason).trim();
    if (reason.length < 3) throw bad('Record the reason the client gave for the rejection');

    q.run(
      `UPDATE drivers SET status = 'rejected', rejection_reason = ?, rejected_on = ?,
              updated_at = datetime('now') WHERE id = ?`,
      reason, on, driverId,
    );
    audit(req.user.id, 'driver', driverId, 'rejected', { reason, on });
    res.json(q.get('SELECT * FROM drivers WHERE id = ?', driverId));
  }),
);

/** Put a rejected driver back in the pipeline. */
router.post(
  '/reject/:driverId/withdraw',
  allow('drivers.blacklist'),
  h(async (req, res) => {
    const driverId = Number(req.params.driverId);
    const driver = q.get('SELECT * FROM drivers WHERE id = ?', driverId);
    if (!driver) throw notFound('Driver not found');
    if (driver.status !== 'rejected') throw bad('This driver is not marked rejected');

    const screenings = q.all('SELECT type, status FROM screenings WHERE driver_id = ?', driverId);
    const passedAll = SCREENING_TYPES.every((t) => screenings.find((x) => x.type === t)?.status === 'passed');

    q.run(
      `UPDATE drivers SET status = ?, rejection_reason = NULL, rejected_on = NULL,
              updated_at = datetime('now') WHERE id = ?`,
      passedAll ? 'cleared' : 'in_screening', driverId,
    );
    audit(req.user.id, 'driver', driverId, 'rejection_withdrawn');
    res.json(q.get('SELECT * FROM drivers WHERE id = ?', driverId));
  }),
);

/** Full ID history for a person — every client ID they have ever held. */
router.get(
  '/history/:driverId',
  h(async (req, res) => {
    const driverId = Number(req.params.driverId);
    const driver = q.get('SELECT * FROM drivers WHERE id = ?', driverId);
    if (!driver) throw notFound('Driver not found');
    assertDriver(req.user, driverId);
    const stints = q.all(
      'SELECT * FROM employments WHERE driver_id = ? ORDER BY date_of_joining',
      driverId,
    ).map((e) => {
      const days = Math.max(0, diffDays(e.date_of_joining, e.date_of_leaving || today()));
      return { ...e, days, duration: humanDuration(days) };
    });
    const days = stints.reduce((s, e) => s + e.days, 0);
    res.json({
      driver: { id: driver.id, name: driver.name, registration_no: driver.registration_no },
      stints,
      totalService: { days, label: humanDuration(days), stints: stints.length },
    });
  }),
);

export default router;
