import { Router } from 'express';
import { q, tx, audit } from '../db.js';
import { authenticate, allow } from '../auth.js';
import { buildWorkbook, readWorkbook, XLSX_MIME } from '../excel.js';
import { upload } from '../files.js';
import {
  h, bad, notFound, isDate, isPeriod, periodDays, today, oneOf, diffDays, addDays,
} from '../util.js';

const router = Router();
router.use(authenticate);

export const CODES = ['T', 'TA', 'P', 'L', 'LE'];
export const CODE_LABEL = {
  T: 'Training',
  TA: 'In Transit',
  P: 'Driving / Present',
  L: 'Leave',
  LE: 'Resigned or Left',
};
/** Default selection for a deployed driver is P. */
export const DEFAULT_CODE = 'P';

/** Was this employment live on this day? */
function activeOn(emp, day) {
  if (day < emp.date_of_joining) return false;
  if (emp.date_of_leaving && day > emp.date_of_leaving) return false;
  return true;
}

/**
 * Why a day carries no attendance. `null` means it does.
 *
 * The default of P applies only to a day that has actually happened while the
 * driver was deployed. A day still in the future has no attendance to default
 * -- treating it as Present would inflate the register and the payable days for
 * the rest of the month. Every reader of the register goes through here so the
 * screen, the export, the upload template and payroll cannot drift apart.
 */
function blankBecause(emp, day, asOf = today()) {
  if (!activeOn(emp, day)) return 'outside_deployment';
  if (day > asOf) return 'future';
  return null;
}

router.get('/codes', (_req, res) => {
  res.json({ codes: CODES, labels: CODE_LABEL, default: DEFAULT_CODE });
});

/**
 * Monthly attendance sheet. Every deployed driver gets a full row of days;
 * days with no explicit mark come back as the default P so the supervisor only
 * has to touch the exceptions.
 */
router.get(
  '/sheet',
  h(async (req, res) => {
    const period = String(req.query.period || today().slice(0, 7));
    if (!isPeriod(period)) throw bad('period must be YYYY-MM');
    const location = req.query.location || '';
    const search = req.query.search || '';

    const days = periodDays(period);
    const first = days[0];
    const last = days[days.length - 1];

    const where = ['e.date_of_joining <= ?', "(e.date_of_leaving IS NULL OR e.date_of_leaving >= ?)"];
    const params = [last, first];
    if (location) {
      where.push('e.location = ?');
      params.push(location);
    }
    if (search) {
      where.push('(d.name LIKE ? OR e.client_id LIKE ? OR e.vehicle_number LIKE ?)');
      const like = `%${search}%`;
      params.push(like, like, like);
    }

    const emps = q.all(
      `SELECT e.*, d.name, d.registration_no, d.photo_id
       FROM employments e JOIN drivers d ON d.id = e.driver_id
       WHERE ${where.join(' AND ')}
       ORDER BY e.location, d.name`,
      ...params,
    );

    const marks = q.all(
      `SELECT a.employment_id, a.day, a.code, a.locked, a.remarks FROM attendance a
       WHERE a.day BETWEEN ? AND ?`,
      first, last,
    );
    const byEmp = new Map();
    marks.forEach((m) => {
      if (!byEmp.has(m.employment_id)) byEmp.set(m.employment_id, {});
      byEmp.get(m.employment_id)[m.day] = m;
    });

    const period_locked = Boolean(
      q.get("SELECT id FROM payroll_periods WHERE period = ? AND status IN ('paid','closed')", period),
    );

    const rows = emps.map((e) => {
      const marked = byEmp.get(e.id) || {};
      const cells = {};
      const summary = { T: 0, TA: 0, P: 0, L: 0, LE: 0, NA: 0, future: 0 };
      days.forEach((day) => {
        const blank = blankBecause(e, day);
        if (blank) {
          // A future day is shown as simply not there yet, rather than struck
          // out the way a day outside the deployment is.
          cells[day] = { code: null, applicable: false, future: blank === 'future', locked: false };
          if (blank === 'future') summary.future += 1;
          else summary.NA += 1;
          return;
        }
        const m = marked[day];
        const code = m?.code || DEFAULT_CODE;
        cells[day] = {
          code,
          applicable: true,
          explicit: Boolean(m),
          locked: Boolean(m?.locked) || period_locked,
          remarks: m?.remarks || null,
        };
        summary[code] += 1;
      });
      return {
        employment_id: e.id,
        driver_id: e.driver_id,
        name: e.name,
        registration_no: e.registration_no,
        client_id: e.client_id,
        vehicle_number: e.vehicle_number,
        location: e.location,
        date_of_joining: e.date_of_joining,
        date_of_leaving: e.date_of_leaving,
        cells,
        summary,
      };
    });

    res.json({ period, days, rows, locked: period_locked, default: DEFAULT_CODE, labels: CODE_LABEL });
  }),
);

/** Core marking routine, shared by /mark and /bulk-range. */
function applyMarks(marks, user) {
    if (!marks.length) throw bad('No attendance marks supplied');
    if (marks.length > 2000) throw bad('Too many marks in one request (max 2000)');

    const errors = [];
    let saved = 0;

    tx(() => {
      marks.forEach((m, idx) => {
        const empId = Number(m.employment_id);
        const emp = q.get('SELECT * FROM employments WHERE id = ?', empId);
        if (!emp) {
          errors.push({ idx, error: 'Unknown deployment' });
          return;
        }
        if (!isDate(m.day)) {
          errors.push({ idx, error: 'day must be YYYY-MM-DD' });
          return;
        }
        if (!CODES.includes(m.code)) {
          errors.push({ idx, error: `code must be one of ${CODES.join(', ')}` });
          return;
        }
        if (!activeOn(emp, m.day)) {
          errors.push({ idx, error: 'Date falls outside this deployment period' });
          return;
        }
        if (m.day > today()) {
          errors.push({ idx, error: 'Attendance cannot be marked for a future date' });
          return;
        }
        const period = m.day.slice(0, 7);
        const closed = q.get(
          "SELECT status FROM payroll_periods WHERE period = ? AND status IN ('paid','closed')", period,
        );
        if (closed) {
          errors.push({ idx, error: `Payroll for ${period} is ${closed.status}; attendance is locked` });
          return;
        }
        const existing = q.get('SELECT locked FROM attendance WHERE employment_id = ? AND day = ?', empId, m.day);
        if (existing?.locked) {
          errors.push({ idx, error: 'This day is locked by a finalised payroll' });
          return;
        }

        q.run(
          `INSERT INTO attendance(employment_id, day, code, remarks, marked_by)
           VALUES (?,?,?,?,?)
           ON CONFLICT(employment_id, day) DO UPDATE SET
             code = excluded.code, remarks = excluded.remarks,
             marked_by = excluded.marked_by, updated_at = datetime('now')`,
          empId, m.day, m.code, m.remarks || null, user.id,
        );
        saved += 1;

        // LE closes the stint automatically — a driver marked as left stops billing.
        if (m.code === 'LE' && emp.status === 'active') {
          q.run(
            "UPDATE employments SET status = 'ended', date_of_leaving = ?, exit_reason = ? WHERE id = ?",
            m.day, m.remarks || 'Marked LE in attendance', emp.id,
          );
          const others = q.scalar(
            "SELECT count(*) FROM employments WHERE driver_id = ? AND status = 'active'", emp.driver_id,
          );
          if (!Number(others)) q.run("UPDATE drivers SET status = 'left' WHERE id = ?", emp.driver_id);
        }
      });
    });

    audit(user.id, 'attendance', null, 'marked', { saved, failed: errors.length });
    return { saved, errors };
}

/** Mark one or many cells: { marks: [{ employment_id, day, code, remarks }] } */
router.post(
  '/mark',
  allow('supervisor'),
  h(async (req, res) => {
    const marks = Array.isArray(req.body.marks) ? req.body.marks : [req.body];
    res.json(applyMarks(marks, req.user));
  }),
);

/** Fill a whole date range for one deployment (bulk leave, training block, ...). */
router.post(
  '/bulk-range',
  allow('supervisor'),
  h(async (req, res) => {
    const { employment_id, from, to } = req.body;
    const code = oneOf(req.body.code, CODES, 'code');
    if (!isDate(from) || !isDate(to)) throw bad('from and to must be YYYY-MM-DD');
    if (diffDays(from, to) < 0) throw bad('"to" must not be before "from"');
    if (diffDays(from, to) > 92) throw bad('Range is limited to 92 days');
    const emp = q.get('SELECT * FROM employments WHERE id = ?', Number(employment_id));
    if (!emp) throw notFound('Deployment not found');

    const marks = [];
    for (let d = from; diffDays(d, to) >= 0; d = addDays(d, 1)) {
      if (activeOn(emp, d) && d <= today()) {
        marks.push({ employment_id: emp.id, day: d, code, remarks: req.body.remarks });
      }
    }
    if (!marks.length) throw bad('No markable days in that range for this deployment');
    res.json(applyMarks(marks, req.user));
  }),
);

// -------------------------------------------------- bulk attendance upload
/**
 * "Pls put provision to upload bulk attendance of drivers if required."
 *
 * Download a template for the month pre-filled with every deployed driver and
 * their current marks, edit it offline, upload it back. The upload runs as a
 * dry run first by default, so the supervisor sees exactly what would change
 * -- and what would be refused, and why -- before anything is written.
 */
const DAY_HEADER = /^(\d{1,2})$/;

router.get(
  '/template',
  h(async (req, res) => {
    const period = String(req.query.period || today().slice(0, 7));
    if (!isPeriod(period)) throw bad('period must be YYYY-MM');
    const days = periodDays(period);
    const first = days[0];
    const last = days[days.length - 1];

    const emps = q.all(
      `SELECT e.*, d.name, d.registration_no FROM employments e JOIN drivers d ON d.id = e.driver_id
       WHERE e.date_of_joining <= ? AND (e.date_of_leaving IS NULL OR e.date_of_leaving >= ?)
       ORDER BY e.location, d.name`,
      last, first,
    );
    const marks = q.all('SELECT employment_id, day, code FROM attendance WHERE day BETWEEN ? AND ?', first, last);
    const byEmp = new Map();
    marks.forEach((m) => {
      if (!byEmp.has(m.employment_id)) byEmp.set(m.employment_id, {});
      byEmp.get(m.employment_id)[m.day] = m.code;
    });

    const rows = emps.map((e) => {
      const marked = byEmp.get(e.id) || {};
      const row = {
        employment_id: e.id,
        client_id: e.client_id,
        registration_no: e.registration_no,
        name: e.name,
        location: e.location,
      };
      days.forEach((d) => {
        // Days outside the deployment stay blank and are ignored on the way back.
        row[String(Number(d.slice(-2)))] = blankBecause(e, d) ? '' : (marked[d] || DEFAULT_CODE);
      });
      return row;
    });

    const buf = await buildWorkbook({
      sheetName: `Attendance ${period}`,
      title: `Bulk Attendance Upload — ${period}`,
      columns: [
        { header: 'Deployment ID', key: 'employment_id', width: 14 },
        { header: 'Client ID', key: 'client_id', width: 12 },
        { header: 'Reg. No', key: 'registration_no', width: 16 },
        { header: 'Driver', key: 'name', width: 24 },
        { header: 'Location', key: 'location', width: 16 },
        ...days.map((d) => ({ header: String(Number(d.slice(-2))), key: String(Number(d.slice(-2))), width: 5 })),
      ],
      rows,
      notes: [
        `Codes: ${CODES.map((c) => `${c} = ${CODE_LABEL[c]}`).join('   |   ')}`,
        'Edit the day columns only. Leave a cell blank to leave that day as it is.',
        'Do not change the Deployment ID column — it is how each row is matched on upload.',
        'Blank cells outside a driver\'s deployment period are ignored.',
      ],
    });
    res.setHeader('Content-Type', XLSX_MIME);
    res.setHeader('Content-Disposition', `attachment; filename="attendance-upload-${period}.xlsx"`);
    res.send(buf);
  }),
);

router.post(
  '/upload',
  allow('supervisor'),
  upload.single('file'),
  h(async (req, res) => {
    if (!req.file) throw bad('No file uploaded');
    const period = String(req.body.period || today().slice(0, 7));
    if (!isPeriod(period)) throw bad('period must be YYYY-MM');
    // Nothing is written unless commit is explicitly asked for.
    const commit = req.body.commit === 'true' || req.body.commit === true;

    const { headers, rows } = await readWorkbook(req.file.path);
    if (!rows.length) throw bad('The sheet has no data rows');

    const idHeader = headers.find((x) => /deployment\s*id/i.test(x));
    if (!idHeader) {
      throw bad(
        'The sheet needs a "Deployment ID" column so each row can be matched. '
          + 'Download the template for the month and edit that.',
        { code: 'MISSING_ID_COLUMN', headers },
      );
    }
    const dayHeaders = headers.filter((x) => DAY_HEADER.test(String(x).trim()));
    if (!dayHeaders.length) throw bad('The sheet has no day columns (1, 2, 3, ...)');

    const marks = [];
    const rejected = [];
    const empCache = new Map();

    rows.forEach((row) => {
      const empId = Number(String(row[idHeader] ?? '').trim());
      const label = row.Driver || row.name || `row ${row.__row}`;
      if (!empId) {
        rejected.push({ row: row.__row, driver: label, reason: 'No Deployment ID on this row' });
        return;
      }
      if (!empCache.has(empId)) {
        empCache.set(empId, q.get('SELECT * FROM employments WHERE id = ?', empId));
      }
      const emp = empCache.get(empId);
      if (!emp) {
        rejected.push({ row: row.__row, driver: label, reason: `Deployment ${empId} does not exist` });
        return;
      }

      dayHeaders.forEach((hd) => {
        const raw = row[hd];
        if (raw === undefined || raw === null || String(raw).trim() === '') return;
        const code = String(raw).trim().toUpperCase();
        const day = `${period}-${String(Number(hd)).padStart(2, '0')}`;

        if (!CODES.includes(code)) {
          rejected.push({ row: row.__row, driver: label, day, reason: `"${raw}" is not one of ${CODES.join(', ')}` });
          return;
        }
        if (!isDate(day)) {
          rejected.push({ row: row.__row, driver: label, day, reason: 'Not a real date in this month' });
          return;
        }
        marks.push({ employment_id: empId, day, code, remarks: 'Bulk upload' });
      });
    });

    if (!marks.length) {
      return res.json({
        committed: false, period, saved: 0, marks: 0,
        rejected,
        message: 'Nothing in the sheet could be applied — see the rejected list.',
      });
    }
    if (marks.length > 2000) {
      throw bad(`The sheet carries ${marks.length} marks; upload one month at a time (limit 2000).`);
    }

    if (!commit) {
      // Dry run: report what would happen without touching anything.
      const changes = marks.filter((m) => {
        const existing = q.get(
          'SELECT code FROM attendance WHERE employment_id = ? AND day = ?', m.employment_id, m.day,
        );
        return (existing?.code || DEFAULT_CODE) !== m.code;
      });
      return res.json({
        committed: false,
        period,
        marks: marks.length,
        changes: changes.length,
        drivers: empCache.size,
        rejected,
        preview: changes.slice(0, 50),
        message: `${changes.length} day(s) would change across ${empCache.size} driver(s).`
          + (rejected.length ? ` ${rejected.length} cell(s) would be skipped.` : ''),
      });
    }

    const result = applyMarks(marks, req.user);
    audit(req.user.id, 'attendance', null, 'bulk_uploaded', {
      period, saved: result.saved, failed: result.errors.length,
    });

    res.json({
      committed: true,
      period,
      marks: marks.length,
      saved: result.saved,
      drivers: empCache.size,
      // applyMarks reports by index; map back to something a person can read.
      errors: result.errors.map((e) => ({
        driver: marks[e.idx] ? `Deployment ${marks[e.idx].employment_id}` : `entry ${e.idx}`,
        day: marks[e.idx]?.day,
        reason: e.error,
      })),
      rejected,
    });
  }),
);

/** Monthly attendance register download. */
router.get(
  '/export',
  h(async (req, res) => {
    const period = String(req.query.period || today().slice(0, 7));
    if (!isPeriod(period)) throw bad('period must be YYYY-MM');
    const days = periodDays(period);
    const first = days[0];
    const last = days[days.length - 1];

    const emps = q.all(
      `SELECT e.*, d.name, d.registration_no FROM employments e JOIN drivers d ON d.id = e.driver_id
       WHERE e.date_of_joining <= ? AND (e.date_of_leaving IS NULL OR e.date_of_leaving >= ?)
       ORDER BY e.location, d.name`,
      last, first,
    );
    const marks = q.all('SELECT employment_id, day, code FROM attendance WHERE day BETWEEN ? AND ?', first, last);
    const byEmp = new Map();
    marks.forEach((m) => {
      if (!byEmp.has(m.employment_id)) byEmp.set(m.employment_id, {});
      byEmp.get(m.employment_id)[m.day] = m.code;
    });

    const columns = [
      { header: 'Client ID', key: 'client_id', width: 12 },
      { header: 'Reg. No', key: 'registration_no', width: 16 },
      { header: 'Driver', key: 'name', width: 24 },
      { header: 'Vehicle', key: 'vehicle_number', width: 14 },
      { header: 'Location', key: 'location', width: 16 },
      ...days.map((d) => ({ header: d.slice(-2), key: d, width: 5 })),
      { header: 'P', key: 'sum_P', width: 6 },
      { header: 'T', key: 'sum_T', width: 6 },
      { header: 'TA', key: 'sum_TA', width: 6 },
      { header: 'L', key: 'sum_L', width: 6 },
      { header: 'LE', key: 'sum_LE', width: 6 },
    ];

    const rows = emps.map((e) => {
      const marked = byEmp.get(e.id) || {};
      const row = {
        client_id: e.client_id, registration_no: e.registration_no, name: e.name,
        vehicle_number: e.vehicle_number, location: e.location,
        sum_P: 0, sum_T: 0, sum_TA: 0, sum_L: 0, sum_LE: 0,
      };
      days.forEach((d) => {
        // Blank for a day outside the deployment, and for one that has not
        // happened yet — neither has attendance to report.
        if (blankBecause(e, d)) {
          row[d] = '';
          return;
        }
        const code = marked[d] || DEFAULT_CODE;
        row[d] = code;
        row[`sum_${code}`] += 1;
      });
      return row;
    });

    const buf = await buildWorkbook({
      sheetName: `Attendance ${period}`,
      title: `Attendance Register — ${period}`,
      columns,
      rows,
      // Client ID, Reg. No and Driver stay put while the day columns scroll.
      freezeColumns: 3,
      notes: [
        `Codes: ${CODES.map((c) => `${c} = ${CODE_LABEL[c]}`).join('   |   ')}`,
        'A blank cell is a day outside the driver\'s deployment period, or a day that has '
          + `not happened yet. Attendance is reported up to ${today()}.`,
        'An unmarked day that has passed counts as P — supervisors record only the exceptions.',
      ],
    });
    res.setHeader('Content-Type', XLSX_MIME);
    res.setHeader('Content-Disposition', `attachment; filename="attendance-${period}.xlsx"`);
    res.send(buf);
  }),
);

export default router;
