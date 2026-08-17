import { Router } from 'express';
import { q, tx, audit } from '../db.js';
import { authenticate, allow, is } from '../auth.js';
import { config } from '../config.js';
import { upload, saveAttachment } from '../files.js';
import { buildWorkbook, XLSX_MIME } from '../excel.js';
import {
  h, need, bad, notFound, forbidden, isDate, today, money, num, oneOf,
} from '../util.js';

const router = Router();
router.use(authenticate);

const THRESHOLD = config.rules.expenseDirectorThreshold;
const CATEGORIES = ['safety_shoe', 'medical', 'fuel', 'uniform', 'repair', 'travel', 'other'];

const SELECT = `
  SELECT x.*, d.name AS driver_name, d.registration_no,
         e.client_id, e.location,
         ru.name AS requested_by_name, su.name AS sm_by_name, du.name AS director_by_name
  FROM expenses x
  LEFT JOIN drivers d ON d.id = x.driver_id
  LEFT JOIN employments e ON e.driver_id = d.id AND e.status = 'active'
  LEFT JOIN users ru ON ru.id = x.requested_by
  LEFT JOIN users su ON su.id = x.sm_by
  LEFT JOIN users du ON du.id = x.director_by`;

const withExtras = (row, user) => ({
  ...row,
  attachments: q.all(
    "SELECT id, kind, filename, mime, uploaded_at FROM attachments WHERE owner_type = 'expense' AND owner_id = ?",
    String(row.id),
  ),
  actions: {
    canApproveSm: row.status === 'pending_sm' && is(user, 'senior_manager'),
    canApproveDirector: row.status === 'pending_director' && is(user, 'director'),
    // Under the threshold the supervisor pays out of petty cash and uploads the
    // supporting; at or above it accounts pays directly.
    canSettle:
      row.status === 'approved' &&
      (row.route === 'petty_cash'
        ? row.requested_by === user.id || is(user, 'supervisor', 'accounts')
        : is(user, 'accounts')),
  },
});

router.get('/meta', (_req, res) => {
  res.json({ categories: CATEGORIES, directorThreshold: THRESHOLD });
});

router.get(
  '/',
  h(async (req, res) => {
    const { status = '', driver_id = '', route = '', mine = '', from = '', to = '' } = req.query;
    const where = [];
    const params = [];
    if (status) {
      const list = String(status).split(',').map((s) => s.trim()).filter(Boolean);
      where.push(`x.status IN (${list.map(() => '?').join(',')})`);
      params.push(...list);
    }
    if (driver_id) {
      where.push('x.driver_id = ?');
      params.push(Number(driver_id));
    }
    if (route) {
      where.push('x.route = ?');
      params.push(route);
    }
    if (mine === 'true') {
      where.push('x.requested_by = ?');
      params.push(req.user.id);
    }
    if (from) {
      where.push('x.request_date >= ?');
      params.push(from);
    }
    if (to) {
      where.push('x.request_date <= ?');
      params.push(to);
    }

    const rows = q.all(
      `${SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY x.requested_at DESC LIMIT 500`,
      ...params,
    ).map((r) => withExtras(r, req.user));

    res.json({
      rows,
      totals: {
        count: rows.length,
        amount: money(rows.reduce((s, r) => s + r.amount, 0)),
        open: rows.filter((r) => r.status === 'approved').length,
      },
    });
  }),
);

router.get('/inbox', h(async (req, res) => {
  res.json({
    pending_sm: Number(q.scalar("SELECT count(*) FROM expenses WHERE status = 'pending_sm'")),
    pending_director: Number(q.scalar("SELECT count(*) FROM expenses WHERE status = 'pending_director'")),
    open_settlements: Number(q.scalar("SELECT count(*) FROM expenses WHERE status = 'approved'")),
  });
}));

router.get(
  '/:id',
  h(async (req, res) => {
    const row = q.get(`${SELECT} WHERE x.id = ?`, Number(req.params.id));
    if (!row) throw notFound('Expense request not found');
    res.json(withExtras(row, req.user));
  }),
);

/**
 * Supervisor raises a purchase requirement / expense payment request.
 * Routing follows the amount: below Rs 3000 the Senior Manager is the final
 * approver and the supervisor pays from petty cash; at or above it the Director
 * also approves and accounts pays directly.
 */
router.post(
  '/',
  allow('supervisor', 'senior_manager'),
  h(async (req, res) => {
    need(req.body, ['purpose', 'amount', 'kind']);
    const amount = money(num(req.body.amount, 'Amount', { min: 1, max: 1000000 }));
    const kind = oneOf(req.body.kind, ['reimbursement', 'expense'], 'kind');
    const category = req.body.category ? oneOf(req.body.category, CATEGORIES, 'category') : 'other';
    const requestDate = req.body.request_date || today();
    if (!isDate(requestDate)) throw bad('request_date must be YYYY-MM-DD');

    let driverId = null;
    if (req.body.driver_id) {
      const driver = q.get('SELECT id FROM drivers WHERE id = ?', Number(req.body.driver_id));
      if (!driver) throw notFound('Driver not found');
      driverId = driver.id;
    }

    const needsDirector = amount >= THRESHOLD;
    const route = needsDirector ? 'accounts' : 'petty_cash';
    // A Senior Manager's own request cannot stop at their own approval step, so
    // it goes straight to the Director whatever the amount.
    const status = req.user.role === 'senior_manager' ? 'pending_director' : 'pending_sm';

    const id = q.insert(
      `INSERT INTO expenses(driver_id, purpose, category, amount, kind, route, request_date,
                            status, requested_by)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      driverId, String(req.body.purpose).trim(), category, amount, kind, route, requestDate,
      status, req.user.id,
    );

    if (req.user.role === 'senior_manager') {
      q.run(
        "UPDATE expenses SET sm_by = ?, sm_at = datetime('now'), sm_remarks = ? WHERE id = ?",
        req.user.id, 'Raised by Senior Manager', id,
      );
    }
    audit(req.user.id, 'expense', id, 'raised', { amount, route });

    res.status(201).json({
      expense: withExtras(q.get(`${SELECT} WHERE x.id = ?`, id), req.user),
      route,
      nextApprover: status === 'pending_sm' ? 'Senior Manager' : 'Director',
      note: needsDirector
        ? `Above INR ${THRESHOLD}: Senior Manager and Director approval required, accounts will pay directly.`
        : `Below INR ${THRESHOLD}: Senior Manager approves, then pay from petty cash and upload the supporting.`,
    });
  }),
);

router.post(
  '/:id/decision',
  allow('senior_manager', 'director'),
  h(async (req, res) => {
    const x = q.get('SELECT * FROM expenses WHERE id = ?', Number(req.params.id));
    if (!x) throw notFound('Expense request not found');
    if (!['approve', 'reject'].includes(req.body.decision)) throw bad('decision must be approve or reject');
    const approve = req.body.decision === 'approve';
    const remarks = req.body.remarks || null;

    if (x.status === 'pending_sm') {
      if (!is(req.user, 'senior_manager')) throw forbidden('This request is awaiting Senior Manager approval');
      if (x.requested_by === req.user.id) throw forbidden('You cannot approve your own request');
      // Below the threshold the Senior Manager is the final approver.
      const next = !approve ? 'rejected' : x.amount >= THRESHOLD ? 'pending_director' : 'approved';
      q.run(
        "UPDATE expenses SET status = ?, sm_by = ?, sm_at = datetime('now'), sm_remarks = ? WHERE id = ?",
        next, req.user.id, remarks, x.id,
      );
    } else if (x.status === 'pending_director') {
      if (!is(req.user, 'director')) throw forbidden('This request is awaiting Director approval');
      q.run(
        `UPDATE expenses SET status = ?, director_by = ?, director_at = datetime('now'),
                             director_remarks = ? WHERE id = ?`,
        approve ? 'approved' : 'rejected', req.user.id, remarks, x.id,
      );
    } else {
      throw bad(`This request is ${x.status} and cannot be actioned`);
    }

    audit(req.user.id, 'expense', x.id, approve ? 'approved' : 'rejected', { remarks });
    res.json(withExtras(q.get(`${SELECT} WHERE x.id = ?`, x.id), req.user));
  }),
);

/** Upload the receipt / payment transaction proof against an open expense. */
router.post(
  '/:id/attachments',
  upload.array('files', 5),
  h(async (req, res) => {
    const x = q.get('SELECT * FROM expenses WHERE id = ?', Number(req.params.id));
    if (!x) throw notFound('Expense request not found');
    if (!req.files?.length) throw bad('No file uploaded');
    const kind = oneOf(req.body.kind || 'receipt', ['receipt', 'txn_proof'], 'kind');

    const ids = req.files.map((f) =>
      saveAttachment(f, { ownerType: 'expense', ownerId: x.id, kind, userId: req.user.id }),
    );
    audit(req.user.id, 'expense', x.id, 'supporting_uploaded', { count: ids.length, kind });
    res.status(201).json({
      attachments: q.all(
        "SELECT id, kind, filename, mime, uploaded_at FROM attachments WHERE owner_type = 'expense' AND owner_id = ?",
        String(x.id),
      ),
    });
  }),
);

/**
 * Close out an approved expense. Supporting documents are mandatory — an open
 * expense stays open until the receipt and the payment proof are on record.
 */
router.post(
  '/:id/settle',
  h(async (req, res) => {
    const x = q.get('SELECT * FROM expenses WHERE id = ?', Number(req.params.id));
    if (!x) throw notFound('Expense request not found');
    if (x.status !== 'approved') throw bad(`Only an approved expense can be settled (this one is ${x.status})`);

    const allowed = x.route === 'petty_cash'
      ? x.requested_by === req.user.id || is(req.user, 'supervisor', 'accounts')
      : is(req.user, 'accounts');
    if (!allowed) {
      throw forbidden(
        x.route === 'petty_cash'
          ? 'Petty cash expenses are settled by the raising supervisor'
          : 'Expenses above the threshold are paid by the accounts team',
      );
    }

    const attachments = q.all(
      "SELECT kind FROM attachments WHERE owner_type = 'expense' AND owner_id = ?", String(x.id),
    );
    if (!attachments.length) {
      throw bad('Upload the supporting documents (receipt and payment transaction details) before settling');
    }

    const paidAmount = money(num(req.body.paid_amount ?? x.amount, 'Paid amount', { min: 0 }));
    const settledOn = req.body.settled_at || today();
    if (!isDate(settledOn)) throw bad('settled_at must be YYYY-MM-DD');

    tx(() => {
      q.run(
        `UPDATE expenses SET status = 'settled', settled_at = ?, settled_by = ?,
                             paid_amount = ?, txn_ref = ? WHERE id = ?`,
        settledOn, req.user.id, paidAmount, req.body.txn_ref || null, x.id,
      );
      if (x.route === 'petty_cash') {
        q.run(
          `INSERT INTO petty_cash(supervisor_id, direction, amount, expense_id, note, entry_date, created_by)
           VALUES (?, 'spend', ?, ?, ?, ?, ?)`,
          x.requested_by, paidAmount, x.id, x.purpose, settledOn, req.user.id,
        );
      }
      audit(req.user.id, 'expense', x.id, 'settled', { paidAmount, route: x.route });
    });

    res.json(withExtras(q.get(`${SELECT} WHERE x.id = ?`, x.id), req.user));
  }),
);

// ---------------------------------------------------------------- petty cash
router.get(
  '/petty-cash/ledger',
  h(async (req, res) => {
    const supervisorId = req.query.supervisor_id
      ? Number(req.query.supervisor_id)
      : is(req.user, 'accounts', 'senior_manager', 'director') ? null : req.user.id;

    const where = supervisorId ? 'WHERE p.supervisor_id = ?' : '';
    const params = supervisorId ? [supervisorId] : [];
    const entries = q.all(
      `SELECT p.*, u.name AS supervisor_name, x.purpose FROM petty_cash p
       LEFT JOIN users u ON u.id = p.supervisor_id
       LEFT JOIN expenses x ON x.id = p.expense_id
       ${where} ORDER BY p.entry_date DESC, p.id DESC LIMIT 500`,
      ...params,
    );

    const balances = q.all(
      `SELECT u.id, u.name,
              COALESCE(sum(CASE WHEN p.direction = 'issue' THEN p.amount ELSE 0 END), 0) AS issued,
              COALESCE(sum(CASE WHEN p.direction = 'spend' THEN p.amount ELSE 0 END), 0) AS spent,
              COALESCE(sum(CASE WHEN p.direction = 'return' THEN p.amount ELSE 0 END), 0) AS returned
       FROM users u LEFT JOIN petty_cash p ON p.supervisor_id = u.id
       WHERE u.role = 'supervisor' GROUP BY u.id ORDER BY u.name`,
    ).map((b) => ({ ...b, balance: money(b.issued - b.spent - b.returned) }));

    res.json({ entries, balances });
  }),
);

/** Accounts issues petty cash to a supervisor (or takes the balance back). */
router.post(
  '/petty-cash',
  allow('accounts'),
  h(async (req, res) => {
    need(req.body, ['supervisor_id', 'amount']);
    const direction = oneOf(req.body.direction || 'issue', ['issue', 'return'], 'direction');
    const supervisor = q.get("SELECT * FROM users WHERE id = ? AND role = 'supervisor'", Number(req.body.supervisor_id));
    if (!supervisor) throw notFound('Supervisor not found');
    const amount = money(num(req.body.amount, 'Amount', { min: 1, max: 1000000 }));
    const entryDate = req.body.entry_date || today();
    if (!isDate(entryDate)) throw bad('entry_date must be YYYY-MM-DD');

    const id = q.insert(
      `INSERT INTO petty_cash(supervisor_id, direction, amount, note, entry_date, created_by)
       VALUES (?,?,?,?,?,?)`,
      supervisor.id, direction, amount, req.body.note || null, entryDate, req.user.id,
    );
    audit(req.user.id, 'petty_cash', id, direction, { amount, supervisor: supervisor.name });
    res.status(201).json(q.get('SELECT * FROM petty_cash WHERE id = ?', id));
  }),
);

// ------------------------------------------------------------------ export
router.get(
  '/export/register',
  h(async (req, res) => {
    const from = req.query.from || `${today().slice(0, 7)}-01`;
    const to = req.query.to || today();
    if (!isDate(from) || !isDate(to)) throw bad('from and to must be YYYY-MM-DD');

    const rows = q.all(
      `${SELECT} WHERE x.request_date BETWEEN ? AND ? ORDER BY x.request_date, x.id`, from, to,
    );

    const buf = await buildWorkbook({
      sheetName: 'Expense Register',
      title: `Expense & Petty Cash Register — ${from} to ${to}`,
      columns: [
        { header: 'Req #', key: 'id', width: 8 },
        { header: 'Date', key: 'request_date', width: 13 },
        { header: 'Driver', key: 'driver_name', width: 24 },
        { header: 'Client ID', key: 'client_id', width: 12 },
        { header: 'Purpose', key: 'purpose', width: 34 },
        { header: 'Category', key: 'category', width: 14 },
        { header: 'Type', key: 'kind', width: 14 },
        { header: 'Amount (INR)', key: 'amount', width: 14, numFmt: '#,##0.00' },
        { header: 'Route', key: 'route', width: 13 },
        { header: 'Raised By', key: 'requested_by_name', width: 20 },
        { header: 'SM', key: 'sm_by_name', width: 18 },
        { header: 'Director', key: 'director_by_name', width: 18 },
        { header: 'Status', key: 'status', width: 12 },
        { header: 'Paid', key: 'paid_amount', width: 12, numFmt: '#,##0.00' },
        { header: 'Settled On', key: 'settled_at', width: 13 },
        { header: 'Txn Ref', key: 'txn_ref', width: 20 },
        { header: 'Supportings', key: 'supportings', width: 12 },
      ],
      rows: rows.map((r) => ({
        ...r,
        supportings: Number(q.scalar(
          "SELECT count(*) FROM attachments WHERE owner_type = 'expense' AND owner_id = ?", String(r.id),
        )),
      })),
      notes: [`Total: INR ${money(rows.reduce((s, r) => s + r.amount, 0)).toLocaleString('en-IN')} over ${rows.length} requests.`],
    });
    res.setHeader('Content-Type', XLSX_MIME);
    res.setHeader('Content-Disposition', `attachment; filename="expense-register-${from}_to_${to}.xlsx"`);
    res.send(buf);
  }),
);

export default router;
