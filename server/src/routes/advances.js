import { Router } from 'express';
import { q, tx, audit } from '../db.js';
import { authenticate, allow, is } from '../auth.js';
import { config } from '../config.js';
import { saveBuffer } from '../files.js';
import { buildWorkbook, XLSX_MIME } from '../excel.js';
import {
  h, need, bad, notFound, forbidden, isDate, today, money, num, cutoffFor,
} from '../util.js';

const router = Router();
router.use(authenticate);

const SELECT = `
  SELECT a.*, d.name AS driver_name, d.registration_no, d.phone AS driver_phone,
         d.bank_account_no, d.bank_ifsc, d.bank_name, d.bank_account_name,
         e.client_id, e.location, e.vehicle_number,
         ru.name AS requested_by_name, ru.role AS requested_by_role,
         su.name AS sm_by_name, du.name AS director_by_name,
         b.method AS batch_method, b.batch_date AS batch_date, b.status AS batch_status
  FROM advances a
  JOIN drivers d ON d.id = a.driver_id
  LEFT JOIN employments e ON e.id = a.employment_id
  LEFT JOIN users ru ON ru.id = a.requested_by
  LEFT JOIN users su ON su.id = a.sm_by
  LEFT JOIN users du ON du.id = a.director_by
  LEFT JOIN payment_batches b ON b.id = a.batch_id`;

/** What this user can act on right now. */
function actionsFor(user, adv) {
  return {
    canApproveSm: adv.status === 'pending_sm' && is(user, 'senior_manager'),
    canApproveDirector: adv.status === 'pending_director' && is(user, 'director'),
    canPay: adv.status === 'approved' && is(user, 'accounts'),
    canCancel:
      ['pending_sm', 'pending_director'].includes(adv.status) &&
      (adv.requested_by === user.id || is(user, 'senior_manager', 'director')),
  };
}

router.get(
  '/',
  h(async (req, res) => {
    const { status = '', driver_id = '', from = '', to = '', mine = '', unbatched = '' } = req.query;
    const where = [];
    const params = [];
    if (status) {
      const list = String(status).split(',').map((s) => s.trim()).filter(Boolean);
      where.push(`a.status IN (${list.map(() => '?').join(',')})`);
      params.push(...list);
    }
    if (driver_id) {
      where.push('a.driver_id = ?');
      params.push(Number(driver_id));
    }
    if (from) {
      where.push('a.request_date >= ?');
      params.push(from);
    }
    if (to) {
      where.push('a.request_date <= ?');
      params.push(to);
    }
    if (mine === 'true') {
      where.push('a.requested_by = ?');
      params.push(req.user.id);
    }
    if (unbatched === 'true') where.push('a.batch_id IS NULL');

    const rows = q.all(
      `${SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY a.requested_at DESC LIMIT 500`,
      ...params,
    ).map((r) => ({ ...r, actions: actionsFor(req.user, r) }));

    res.json({
      rows,
      totals: {
        count: rows.length,
        amount: money(rows.reduce((s, r) => s + r.amount, 0)),
      },
    });
  }),
);

/** Counts for the approval inbox badges. */
router.get('/inbox', h(async (req, res) => {
  res.json({
    pending_sm: Number(q.scalar("SELECT count(*) FROM advances WHERE status = 'pending_sm'")),
    pending_director: Number(q.scalar("SELECT count(*) FROM advances WHERE status = 'pending_director'")),
    approved_unpaid: Number(q.scalar("SELECT count(*) FROM advances WHERE status = 'approved'")),
    my_requests: Number(q.scalar(
      "SELECT count(*) FROM advances WHERE requested_by = ? AND status IN ('pending_sm','pending_director')",
      req.user.id,
    )),
  });
}));

/**
 * Supervisor raises the request on the driver's behalf.
 * A request raised by a Senior Manager skips straight to the Director.
 */
router.post(
  '/',
  allow('supervisor', 'senior_manager'),
  h(async (req, res) => {
    need(req.body, ['driver_id', 'amount', 'reason']);
    const driver = q.get('SELECT * FROM drivers WHERE id = ?', Number(req.body.driver_id));
    if (!driver) throw notFound('Driver not found');

    const amount = money(num(req.body.amount, 'Amount', { min: 1, max: 500000 }));
    const requestDate = req.body.request_date || today();
    if (!isDate(requestDate)) throw bad('request_date must be YYYY-MM-DD');

    const emp = q.get("SELECT * FROM employments WHERE driver_id = ? AND status = 'active'", driver.id);
    if (!emp) throw bad('Advances can only be raised for a currently deployed driver');

    const outstanding = Number(q.scalar(
      `SELECT COALESCE(sum(amount - recovered), 0) FROM advances
       WHERE driver_id = ? AND status IN ('approved','paid')`, driver.id,
    ));

    // A Senior Manager's own request cannot be self-approved at the SM step.
    const status = req.user.role === 'senior_manager' ? 'pending_director' : 'pending_sm';

    const id = q.insert(
      `INSERT INTO advances(driver_id, employment_id, amount, reason, request_date, status,
                            requested_by, cutoff)
       VALUES (?,?,?,?,?,?,?,?)`,
      driver.id, emp.id, amount, String(req.body.reason).trim(), requestDate, status,
      req.user.id, cutoffFor(),
    );
    if (status === 'pending_director') {
      q.run(
        "UPDATE advances SET sm_by = ?, sm_at = datetime('now'), sm_remarks = ? WHERE id = ?",
        req.user.id, 'Raised by Senior Manager — routed to Director', id,
      );
    }
    audit(req.user.id, 'advance', id, 'raised', { amount, driver: driver.name });

    res.status(201).json({
      advance: q.get(`${SELECT} WHERE a.id = ?`, id),
      outstandingBefore: money(outstanding),
      nextApprover: status === 'pending_sm' ? 'Senior Manager' : 'Director',
    });
  }),
);

/** Approve / reject at whichever step the request is currently sitting. */
router.post(
  '/:id/decision',
  allow('senior_manager', 'director'),
  h(async (req, res) => {
    const adv = q.get('SELECT * FROM advances WHERE id = ?', Number(req.params.id));
    if (!adv) throw notFound('Advance request not found');
    const approve = req.body.decision === 'approve';
    if (!['approve', 'reject'].includes(req.body.decision)) throw bad('decision must be approve or reject');
    const remarks = req.body.remarks || null;

    if (adv.status === 'pending_sm') {
      if (!is(req.user, 'senior_manager')) throw forbidden('This request is awaiting Senior Manager approval');
      if (adv.requested_by === req.user.id) throw forbidden('You cannot approve your own request');
      q.run(
        `UPDATE advances SET status = ?, sm_by = ?, sm_at = datetime('now'), sm_remarks = ? WHERE id = ?`,
        approve ? 'pending_director' : 'rejected', req.user.id, remarks, adv.id,
      );
    } else if (adv.status === 'pending_director') {
      if (!is(req.user, 'director')) throw forbidden('This request is awaiting Director approval');
      q.run(
        `UPDATE advances SET status = ?, director_by = ?, director_at = datetime('now'),
                             director_remarks = ? WHERE id = ?`,
        approve ? 'approved' : 'rejected', req.user.id, remarks, adv.id,
      );
    } else {
      throw bad(`This request is ${adv.status} and cannot be actioned`);
    }

    audit(req.user.id, 'advance', adv.id, approve ? 'approved' : 'rejected', { remarks });
    res.json(q.get(`${SELECT} WHERE a.id = ?`, adv.id));
  }),
);

router.post(
  '/:id/cancel',
  h(async (req, res) => {
    const adv = q.get('SELECT * FROM advances WHERE id = ?', Number(req.params.id));
    if (!adv) throw notFound('Advance request not found');
    if (!['pending_sm', 'pending_director'].includes(adv.status)) {
      throw bad('Only a pending request can be withdrawn');
    }
    if (adv.requested_by !== req.user.id && !is(req.user, 'senior_manager', 'director')) {
      throw forbidden('Only the requester or a manager can withdraw this request');
    }
    q.run("UPDATE advances SET status = 'rejected', director_remarks = ? WHERE id = ?",
      req.body.remarks || 'Withdrawn by requester', adv.id);
    audit(req.user.id, 'advance', adv.id, 'withdrawn');
    res.json(q.get(`${SELECT} WHERE a.id = ?`, adv.id));
  }),
);

// ------------------------------------------------------------------ payment
/**
 * Approved requests waiting to be paid, grouped by cut-off window.
 * Everything up to noon forms one run; everything up to 18:30 the next.
 */
router.get(
  '/payable',
  allow('accounts'),
  h(async (req, res) => {
    const rows = q.all(
      `${SELECT} WHERE a.status = 'approved' AND a.batch_id IS NULL
       ORDER BY a.request_date, a.director_at`,
    );
    const groups = {};
    rows.forEach((r) => {
      const key = `${r.request_date}|${r.cutoff || 'EVENING'}`;
      groups[key] = groups[key] || {
        date: r.request_date,
        cutoff: r.cutoff || 'EVENING',
        cutoffTime: config.rules.cutoffs[r.cutoff || 'EVENING'],
        items: [],
        total: 0,
      };
      groups[key].items.push(r);
      groups[key].total = money(groups[key].total + r.amount);
    });

    const list = Object.values(groups).map((g) => ({
      ...g,
      count: g.items.length,
      // <= 4 requests: pay through internet banking. More than that: bank sheet.
      suggestedMethod: g.items.length <= config.rules.netbankingMaxRequests ? 'netbanking' : 'sheet',
    }));
    res.json({
      groups: list,
      total: money(rows.reduce((s, r) => s + r.amount, 0)),
      count: rows.length,
      netbankingMaxRequests: config.rules.netbankingMaxRequests,
    });
  }),
);

/** Create a payment run from a set of approved requests. */
router.post(
  '/batches',
  allow('accounts'),
  h(async (req, res) => {
    const ids = Array.isArray(req.body.advance_ids) ? req.body.advance_ids.map(Number) : [];
    if (!ids.length) throw bad('Select at least one approved request');

    const rows = q.all(
      `${SELECT} WHERE a.id IN (${ids.map(() => '?').join(',')})`, ...ids,
    );
    if (rows.length !== ids.length) throw bad('One or more requests could not be found');
    const notReady = rows.filter((r) => r.status !== 'approved' || r.batch_id);
    if (notReady.length) {
      throw bad(`These requests are not ready for payment: ${notReady.map((r) => r.id).join(', ')}`);
    }

    const method =
      req.body.method ||
      (rows.length <= config.rules.netbankingMaxRequests ? 'netbanking' : 'sheet');
    if (!['netbanking', 'sheet'].includes(method)) throw bad('method must be netbanking or sheet');

    const missingBank = rows.filter((r) => !r.bank_account_no || !r.bank_ifsc);
    if (method === 'sheet' && missingBank.length) {
      throw bad(
        `Bank details are missing for: ${missingBank.map((r) => r.driver_name).join(', ')}`,
        { code: 'MISSING_BANK_DETAILS' },
      );
    }

    const total = money(rows.reduce((s, r) => s + r.amount, 0));
    const batchId = tx(() => {
      const id = q.insert(
        `INSERT INTO payment_batches(kind, batch_date, cutoff, method, item_count, total_amount, created_by)
         VALUES ('advance', ?, ?, ?, ?, ?, ?)`,
        req.body.batch_date || today(),
        rows[0].cutoff || 'EVENING',
        method, rows.length, total, req.user.id,
      );
      ids.forEach((advId) => q.run('UPDATE advances SET batch_id = ? WHERE id = ?', id, advId));
      audit(req.user.id, 'payment_batch', id, 'created', { kind: 'advance', method, total });
      return id;
    });

    res.status(201).json({
      batch: q.get('SELECT * FROM payment_batches WHERE id = ?', batchId),
      method,
      note:
        method === 'netbanking'
          ? `${rows.length} request(s) — pay individually through internet banking, then record the UTRs.`
          : `${rows.length} request(s) — download the bank upload sheet and process it in bulk.`,
    });
  }),
);

router.get(
  '/batches',
  allow('accounts', 'senior_manager', 'director'),
  h(async (req, res) => {
    res.json(
      q.all(
        `SELECT b.*, u.name AS created_by_name FROM payment_batches b
         LEFT JOIN users u ON u.id = b.created_by
         WHERE b.kind = 'advance' ORDER BY b.created_at DESC LIMIT 200`,
      ),
    );
  }),
);

router.get(
  '/batches/:id',
  allow('accounts', 'senior_manager', 'director'),
  h(async (req, res) => {
    const batch = q.get('SELECT * FROM payment_batches WHERE id = ?', Number(req.params.id));
    if (!batch) throw notFound('Payment run not found');
    res.json({ batch, items: q.all(`${SELECT} WHERE a.batch_id = ?`, batch.id) });
  }),
);

/** Bank upload sheet for a "sheet" batch (>4 requests). */
router.get(
  '/batches/:id/sheet',
  allow('accounts'),
  h(async (req, res) => {
    const batch = q.get('SELECT * FROM payment_batches WHERE id = ?', Number(req.params.id));
    if (!batch) throw notFound('Payment run not found');
    const items = q.all(`${SELECT} WHERE a.batch_id = ?`, batch.id);

    const buf = await buildWorkbook({
      sheetName: 'Bank Upload',
      title: `Advance Payment Upload — ${batch.batch_date} (${batch.cutoff})`,
      columns: [
        { header: 'Beneficiary Name', key: 'beneficiary', width: 28 },
        { header: 'Account Number', key: 'account', width: 22 },
        { header: 'IFSC', key: 'ifsc', width: 14 },
        { header: 'Amount', key: 'amount', width: 12, numFmt: '#,##0.00' },
        { header: 'Payment Mode', key: 'mode', width: 14 },
        { header: 'Remarks', key: 'remarks', width: 30 },
        { header: 'Client ID', key: 'client_id', width: 12 },
        { header: 'Request ID', key: 'request_id', width: 12 },
      ],
      rows: items.map((i) => ({
        beneficiary: i.bank_account_name || i.driver_name,
        account: i.bank_account_no || '',
        ifsc: i.bank_ifsc || '',
        amount: i.amount,
        mode: i.amount >= 200000 ? 'RTGS' : 'NEFT',
        remarks: `Advance ${i.registration_no} ${i.reason}`.slice(0, 40),
        client_id: i.client_id || '',
        request_id: `ADV-${i.id}`,
      })),
      notes: [`Total: INR ${batch.total_amount.toLocaleString('en-IN')} across ${items.length} beneficiaries.`],
    });

    saveBuffer(buf, {
      filename: `advance-batch-${batch.id}.xlsx`, mime: XLSX_MIME,
      ownerType: 'advance_batch', ownerId: batch.id, kind: 'register', userId: req.user.id,
    });
    res.setHeader('Content-Type', XLSX_MIME);
    res.setHeader('Content-Disposition', `attachment; filename="advance-batch-${batch.id}.xlsx"`);
    res.send(buf);
  }),
);

/** Record payment: whole batch, or individual UTRs for netbanking. */
router.post(
  '/batches/:id/pay',
  allow('accounts'),
  h(async (req, res) => {
    const batch = q.get('SELECT * FROM payment_batches WHERE id = ?', Number(req.params.id));
    if (!batch) throw notFound('Payment run not found');
    if (batch.status === 'paid') throw bad('This run has already been marked paid');

    const paidOn = req.body.paid_at || today();
    if (!isDate(paidOn)) throw bad('paid_at must be YYYY-MM-DD');
    const utrs = req.body.utrs || {}; // { advanceId: utr }

    tx(() => {
      const items = q.all("SELECT id FROM advances WHERE batch_id = ?", batch.id);
      items.forEach((i) => {
        q.run(
          "UPDATE advances SET status = 'paid', paid_at = ?, utr = ? WHERE id = ?",
          paidOn, utrs[i.id] || utrs[String(i.id)] || req.body.utr || null, i.id,
        );
      });
      q.run("UPDATE payment_batches SET status = 'paid', paid_at = ? WHERE id = ?", paidOn, batch.id);
      audit(req.user.id, 'payment_batch', batch.id, 'paid', { items: items.length });
    });

    res.json({
      batch: q.get('SELECT * FROM payment_batches WHERE id = ?', batch.id),
      items: q.all(`${SELECT} WHERE a.batch_id = ?`, batch.id),
    });
  }),
);

/** The advance register download. */
router.get(
  '/register',
  h(async (req, res) => {
    const from = req.query.from || `${today().slice(0, 7)}-01`;
    const to = req.query.to || today();
    if (!isDate(from) || !isDate(to)) throw bad('from and to must be YYYY-MM-DD');

    const rows = q.all(
      `${SELECT} WHERE a.request_date BETWEEN ? AND ? ORDER BY a.request_date, a.id`,
      from, to,
    );

    const buf = await buildWorkbook({
      sheetName: 'Advance Register',
      title: `Advance Register — ${from} to ${to}`,
      columns: [
        { header: 'Req #', key: 'id', width: 8 },
        { header: 'Request Date', key: 'request_date', width: 14 },
        { header: 'Client ID', key: 'client_id', width: 12 },
        { header: 'Reg. No', key: 'registration_no', width: 16 },
        { header: 'Driver', key: 'driver_name', width: 24 },
        { header: 'Location', key: 'location', width: 16 },
        { header: 'Amount (INR)', key: 'amount', width: 14, numFmt: '#,##0.00' },
        { header: 'Reason', key: 'reason', width: 34 },
        { header: 'Raised By', key: 'requested_by_name', width: 20 },
        { header: 'SM Approval', key: 'sm_by_name', width: 18 },
        { header: 'Director Approval', key: 'director_by_name', width: 18 },
        { header: 'Status', key: 'status', width: 14 },
        { header: 'Paid On', key: 'paid_at', width: 13 },
        { header: 'UTR', key: 'utr', width: 22 },
        { header: 'Recovered', key: 'recovered', width: 12, numFmt: '#,##0.00' },
        { header: 'Outstanding', key: 'outstanding', width: 13, numFmt: '#,##0.00' },
      ],
      rows: rows.map((r) => ({
        ...r,
        outstanding: ['approved', 'paid'].includes(r.status) ? money(r.amount - r.recovered) : 0,
      })),
      notes: [
        `Requests: ${rows.length}   |   Total value: INR ${money(rows.reduce((s, r) => s + r.amount, 0)).toLocaleString('en-IN')}`,
        `Paid: INR ${money(rows.filter((r) => r.status === 'paid').reduce((s, r) => s + r.amount, 0)).toLocaleString('en-IN')}`,
      ],
    });
    res.setHeader('Content-Type', XLSX_MIME);
    res.setHeader('Content-Disposition', `attachment; filename="advance-register-${from}_to_${to}.xlsx"`);
    res.send(buf);
  }),
);

export default router;
