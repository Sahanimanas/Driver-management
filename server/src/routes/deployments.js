import { Router } from 'express';
import { q, tx, audit } from '../db.js';
import { authenticate, allow } from '../auth.js';
import { h, need, bad, notFound, isDate, today, diffDays, humanDuration } from '../util.js';

const router = Router();
router.use(authenticate);

const SCREENING_TYPES = ['trial', 'safety', 'medical'];

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
    res.json(
      q.all(
        `SELECT e.*, d.name, d.registration_no, d.phone, d.photo_id, d.status AS driver_status
         FROM employments e JOIN drivers d ON d.id = e.driver_id
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
  allow('supervisor', 'senior_manager'),
  h(async (req, res) => {
    need(req.body, ['driver_id', 'client_id', 'date_of_joining']);
    const driverId = Number(req.body.driver_id);
    const driver = q.get('SELECT * FROM drivers WHERE id = ?', driverId);
    if (!driver) throw notFound('Driver not found');

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

    const id = tx(() => {
      const empId = q.insert(
        `INSERT INTO employments
           (driver_id, client_id, date_of_joining, vehicle_number, location, monthly_wage, created_by)
         VALUES (?,?,?,?,?,?,?)`,
        driverId,
        clientId,
        doj,
        req.body.vehicle_number ? String(req.body.vehicle_number).toUpperCase().replace(/\s/g, '') : null,
        req.body.location || null,
        Number(req.body.monthly_wage) || 0,
        req.user.id,
      );
      q.run("UPDATE drivers SET status = 'deployed', updated_at = datetime('now') WHERE id = ?", driverId);
      audit(req.user.id, 'employment', empId, 'deployed', { clientId, doj, driverId });
      return empId;
    });

    const priorStints = q.scalar('SELECT count(*) FROM employments WHERE driver_id = ?', driverId);
    res.status(201).json({
      employment: q.get('SELECT * FROM employments WHERE id = ?', id),
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
  allow('supervisor', 'senior_manager', 'accounts'),
  h(async (req, res) => {
    const emp = q.get('SELECT * FROM employments WHERE id = ?', Number(req.params.id));
    if (!emp) throw notFound('Deployment not found');

    const patch = {};
    ['vehicle_number', 'location', 'monthly_wage', 'date_of_joining'].forEach((k) => {
      if (req.body[k] !== undefined) patch[k] = req.body[k];
    });
    if (patch.date_of_joining && !isDate(patch.date_of_joining)) throw bad('Date of joining must be YYYY-MM-DD');
    if (patch.vehicle_number) patch.vehicle_number = String(patch.vehicle_number).toUpperCase().replace(/\s/g, '');
    if (patch.monthly_wage !== undefined) patch.monthly_wage = Number(patch.monthly_wage) || 0;
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
  allow('supervisor', 'senior_manager'),
  h(async (req, res) => {
    const emp = q.get('SELECT * FROM employments WHERE id = ?', Number(req.params.id));
    if (!emp) throw notFound('Deployment not found');
    if (emp.status === 'ended') throw bad('This deployment has already been closed');

    const lastDay = req.body.date_of_leaving || today();
    if (!isDate(lastDay)) throw bad('date_of_leaving must be YYYY-MM-DD');
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

/** Full ID history for a person — every client ID they have ever held. */
router.get(
  '/history/:driverId',
  h(async (req, res) => {
    const driverId = Number(req.params.driverId);
    const driver = q.get('SELECT * FROM drivers WHERE id = ?', driverId);
    if (!driver) throw notFound('Driver not found');
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
