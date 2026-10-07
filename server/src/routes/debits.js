import { Router } from 'express';
import { q, audit } from '../db.js';
import { authenticate, allow, can } from '../auth.js';
import { assertDriver } from '../scope.js';
import { buildWorkbook, XLSX_MIME } from '../excel.js';
import { h, need, bad, notFound, forbidden, isDate, today, money, num, oneOf } from '../util.js';

/**
 * Challans and debits raised against drivers.
 *
 * A traffic challan paid on the driver's behalf, damage to a vehicle, a lost
 * uniform -- anything the driver owes back. A supervisor or Finance raises it,
 * Admin / Director approves it, and only then is it recovered through
 * salary: collating the month deducts what is open (after advances), and the
 * recovery is applied to the debits oldest first once the salary is paid.
 * Whatever one month's pay cannot cover is carried to the next.
 */
const router = Router();
router.use(authenticate);

const SELECT = `
  SELECT x.*, d.name AS driver_name, d.registration_no, e.client_id, e.location,
         u.name AS created_by_name, au.name AS approved_by_name,
         round(x.amount - x.recovered, 2) AS outstanding
    FROM driver_debits x
    JOIN drivers d ON d.id = x.driver_id
    LEFT JOIN employments e ON e.id = x.employment_id
    LEFT JOIN users u ON u.id = x.created_by
    LEFT JOIN users au ON au.id = x.approved_by`;

/**
 * A supervisor sees the challans of the drivers deployed under them, and any
 * they raised themselves.
 */
function filtered(query, user) {
  const { driver_id = '', status = '', from = '', to = '', kind = '' } = query;
  const where = [];
  const params = [];
  if (user.field) {
    where.push('(x.created_by = ? OR e.supervisor_id IS NULL OR e.supervisor_id = ?)');
    params.push(user.id, user.id);
  }
  if (driver_id) {
    where.push('x.driver_id = ?');
    params.push(Number(driver_id));
  }
  if (status) {
    const list = String(status).split(',').filter(Boolean);
    where.push(`x.status IN (${list.map(() => '?').join(',')})`);
    params.push(...list);
  }
  if (kind) {
    where.push('x.kind = ?');
    params.push(kind);
  }
  if (from) {
    where.push('x.debit_date >= ?');
    params.push(from);
  }
  if (to) {
    where.push('x.debit_date <= ?');
    params.push(to);
  }
  return q.all(
    `${SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY x.debit_date DESC, x.id DESC LIMIT 1000`,
    ...params,
  );
}

router.get(
  '/',
  h(async (req, res) => {
    const rows = filtered(req.query, req.user).map((r) => ({
      ...r,
      canCancel: ['pending_approval', 'open'].includes(r.status) && r.recovered === 0
        && (r.created_by === req.user.id || can(req.user, 'debits.approve')),
      // The approver may approve one they raised themselves.
      canDecide: r.status === 'pending_approval' && can(req.user, 'debits.approve'),
    }));
    res.json({
      rows,
      totals: {
        count: rows.length,
        amount: money(rows.filter((r) => r.status !== 'cancelled').reduce((s, r) => s + r.amount, 0)),
        outstanding: money(rows.filter((r) => r.status === 'open').reduce((s, r) => s + r.outstanding, 0)),
        pending: rows.filter((r) => r.status === 'pending_approval').length,
      },
    });
  }),
);

router.post(
  '/',
  allow('debits.raise'),
  h(async (req, res) => {
    need(req.body, ['driver_id', 'kind', 'details', 'debit_date', 'reason', 'amount']);
    const driver = q.get('SELECT * FROM drivers WHERE id = ?', Number(req.body.driver_id));
    if (!driver) throw notFound('Driver not found');
    assertDriver(req.user, driver.id);
    const kind = oneOf(req.body.kind, ['challan', 'debit'], 'kind');
    const debitDate = String(req.body.debit_date);
    if (!isDate(debitDate)) throw bad('Date of challan / debit must be YYYY-MM-DD');
    if (debitDate > today()) throw bad('The date of the challan / debit cannot be in the future');
    const amount = money(num(req.body.amount, 'Amount', { min: 1, max: 500000 }));

    // Against the stint it happened in, so the register shows the right client ID.
    const emp = q.get(
      `SELECT id FROM employments WHERE driver_id = ? AND date_of_joining <= ?
        ORDER BY (status = 'active') DESC, date_of_joining DESC LIMIT 1`,
      driver.id, debitDate,
    );

    const id = q.insert(
      `INSERT INTO driver_debits(driver_id, employment_id, kind, details, debit_date, reason, amount, created_by)
       VALUES (?,?,?,?,?,?,?,?)`,
      driver.id, emp?.id || null, kind, String(req.body.details).trim(), debitDate,
      String(req.body.reason).trim(), amount, req.user.id,
    );
    audit(req.user.id, 'debit', id, 'raised', { driver: driver.name, kind, amount });
    res.status(201).json(q.get(`${SELECT} WHERE x.id = ?`, id));
  }),
);

/**
 * Approve / reject -- whoever holds the approval permission, including on one
 * they raised. Approved, it is open and recovered from the next salary.
 */
router.post(
  '/:id/decision',
  allow('debits.approve'),
  h(async (req, res) => {
    const row = q.get('SELECT * FROM driver_debits WHERE id = ?', Number(req.params.id));
    if (!row) throw notFound('Challan / debit not found');
    if (!['approve', 'reject'].includes(req.body.decision)) throw bad('decision must be approve or reject');
    if (row.status !== 'pending_approval') throw bad(`This challan / debit is already ${row.status}`);
    const approve = req.body.decision === 'approve';
    const remarks = String(req.body.remarks || '').trim() || null;
    if (!approve && !remarks) throw bad('Record why it is being rejected');
    q.run(
      `UPDATE driver_debits SET status = ?, approved_by = ?, approved_at = datetime('now'),
                                approval_remarks = ? WHERE id = ?`,
      approve ? 'open' : 'rejected', req.user.id, remarks, row.id,
    );
    audit(req.user.id, 'debit', row.id, approve ? 'approved' : 'rejected', { remarks });
    res.json(q.get(`${SELECT} WHERE x.id = ?`, row.id));
  }),
);

/** Withdraw one raised in error. Nothing may have been recovered against it yet. */
router.post(
  '/:id/cancel',
  h(async (req, res) => {
    const row = q.get('SELECT * FROM driver_debits WHERE id = ?', Number(req.params.id));
    if (!row) throw notFound('Challan / debit not found');
    if (!['pending_approval', 'open'].includes(row.status)) {
      throw bad(`This challan / debit is already ${row.status}`);
    }
    if (row.recovered > 0) {
      throw bad('Part of this has already been recovered through salary, so it cannot be cancelled');
    }
    if (row.created_by !== req.user.id && !can(req.user, 'debits.approve')) {
      throw forbidden('Only the person who raised it or an approver can cancel it');
    }
    const reason = String(req.body.reason || '').trim();
    if (reason.length < 3) throw bad('Record why it is being cancelled');
    q.run("UPDATE driver_debits SET status = 'cancelled', cancel_reason = ? WHERE id = ?", reason, row.id);
    audit(req.user.id, 'debit', row.id, 'cancelled', { reason });
    res.json(q.get(`${SELECT} WHERE x.id = ?`, row.id));
  }),
);

router.get(
  '/register',
  h(async (req, res) => {
    const rows = filtered(req.query, req.user);
    const buf = await buildWorkbook({
      sheetName: 'Challans & Debits',
      title: 'Challans & Debits Register',
      columns: [
        { header: '#', key: 'id', width: 7 },
        { header: 'Date', key: 'debit_date', width: 12 },
        { header: 'Type', key: 'kind_label', width: 10 },
        { header: 'Reg. No', key: 'registration_no', width: 16 },
        { header: 'Client ID', key: 'client_id', width: 11 },
        { header: 'Driver', key: 'driver_name', width: 24 },
        { header: 'Location', key: 'location', width: 16 },
        { header: 'Challan / Debit Details', key: 'details', width: 30 },
        { header: 'Reason', key: 'reason', width: 30 },
        { header: 'Amount', key: 'amount', width: 12, numFmt: '#,##0.00' },
        { header: 'Recovered', key: 'recovered', width: 12, numFmt: '#,##0.00' },
        { header: 'Outstanding', key: 'outstanding_amt', width: 12, numFmt: '#,##0.00' },
        { header: 'Status', key: 'status', width: 11 },
        { header: 'Raised By', key: 'created_by_name', width: 18 },
        { header: 'Approved By', key: 'approved_by_name', width: 18 },
      ],
      rows: rows.map((r) => ({
        ...r,
        kind_label: r.kind === 'challan' ? 'Challan' : 'Debit',
        outstanding_amt: r.status === 'open' ? r.outstanding : 0,
      })),
    });
    res.setHeader('Content-Type', XLSX_MIME);
    res.setHeader('Content-Disposition', 'attachment; filename="challans-debits.xlsx"');
    res.send(buf);
  }),
);

export default router;
