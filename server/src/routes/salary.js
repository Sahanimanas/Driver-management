import fs from 'node:fs';
import { Router } from 'express';
import { q, tx, audit } from '../db.js';
import { authenticate, allow } from '../auth.js';
import { config } from '../config.js';
import { upload, saveBuffer } from '../files.js';
import { buildWorkbook, readWorkbook, XLSX_MIME } from '../excel.js';
import {
  h, bad, notFound, isPeriod, periodDays, daysInPeriod, today, money, num, bool, digits,
} from '../util.js';

const router = Router();
router.use(authenticate);

const PAYABLE = config.rules.payableCodes; // P, T, TA are payable; L and LE are not.

function getPeriod(period, { create = false, userId } = {}) {
  if (!isPeriod(period)) throw bad('period must be YYYY-MM');
  let row = q.get('SELECT * FROM payroll_periods WHERE period = ?', period);
  if (!row && create) {
    q.insert('INSERT INTO payroll_periods(period) VALUES (?)', period);
    audit(userId, 'payroll', period, 'period_created');
    row = q.get('SELECT * FROM payroll_periods WHERE period = ?', period);
  }
  return row;
}

/** Count attendance for one deployment over a period, defaulting unmarked days to P. */
function tally(emp, period) {
  const days = periodDays(period);
  const marks = Object.fromEntries(
    q.all(
      'SELECT day, code FROM attendance WHERE employment_id = ? AND day BETWEEN ? AND ?',
      emp.id, days[0], days[days.length - 1],
    ).map((m) => [m.day, m.code]),
  );

  const counts = { P: 0, T: 0, TA: 0, L: 0, LE: 0 };
  let applicable = 0;
  days.forEach((d) => {
    if (d < emp.date_of_joining) return;
    if (emp.date_of_leaving && d > emp.date_of_leaving) return;
    if (d > today()) return;
    applicable += 1;
    counts[marks[d] || 'P'] += 1;
  });

  const payableDays = Object.entries(counts).reduce((s, [code, n]) => s + n * (PAYABLE[code] ?? 0), 0);
  return { counts, applicable, payableDays };
}

// ------------------------------------------------------------------ periods
router.get(
  '/periods',
  h(async (_req, res) => {
    res.json(
      q.all(
        `SELECT p.*, u.name AS finalized_by_name,
                (SELECT count(*) FROM payroll_lines l WHERE l.period_id = p.id) AS line_count,
                (SELECT COALESCE(sum(net_payable),0) FROM payroll_lines l WHERE l.period_id = p.id) AS net_total
         FROM payroll_periods p LEFT JOIN users u ON u.id = p.finalized_by
         ORDER BY p.period DESC`,
      ),
    );
  }),
);

/**
 * Collate the month: build (or rebuild) a payroll line per deployment from the
 * attendance on record. Outstanding paid advances are pulled in as deductions.
 */
router.post(
  '/periods/:period/collate',
  allow('accounts', 'senior_manager'),
  h(async (req, res) => {
    const period = req.params.period;
    const row = getPeriod(period, { create: true, userId: req.user.id });
    if (['paid', 'closed'].includes(row.status)) throw bad(`Payroll for ${period} is ${row.status}`);

    const days = periodDays(period);
    const emps = q.all(
      `SELECT e.*, d.name, d.registration_no FROM employments e JOIN drivers d ON d.id = e.driver_id
       WHERE e.date_of_joining <= ? AND (e.date_of_leaving IS NULL OR e.date_of_leaving >= ?)
       ORDER BY d.name`,
      days[days.length - 1], days[0],
    );

    const monthDays = daysInPeriod(period);
    const summary = tx(() => {
      let gross = 0;
      let net = 0;
      emps.forEach((emp) => {
        const t = tally(emp, period);
        const rate = money((emp.monthly_wage || 0) / monthDays);
        const g = money(t.payableDays * rate);

        // Recover advances that have been paid but not yet recovered.
        const outstanding = Number(q.scalar(
          `SELECT COALESCE(sum(amount - recovered), 0) FROM advances
           WHERE driver_id = ? AND status = 'paid' AND recovered < amount`,
          emp.driver_id,
        ));
        const existing = q.get(
          'SELECT * FROM payroll_lines WHERE period_id = ? AND employment_id = ?', row.id, emp.id,
        );
        // Never silently wipe a manual override that has already been reviewed.
        const otherDeduction = existing?.other_deduction ?? 0;
        const advanceDeduction = existing && row.status !== 'draft'
          ? existing.advance_deduction
          : money(Math.min(outstanding, g));
        const netPayable = money(g - advanceDeduction - otherDeduction);

        q.run(
          `INSERT INTO payroll_lines
             (period_id, employment_id, days_in_period, present_days, training_days, transit_days,
              leave_days, left_days, payable_days, rate_per_day, gross, advance_deduction,
              other_deduction, net_payable)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(period_id, employment_id) DO UPDATE SET
             days_in_period = excluded.days_in_period, present_days = excluded.present_days,
             training_days = excluded.training_days, transit_days = excluded.transit_days,
             leave_days = excluded.leave_days, left_days = excluded.left_days,
             payable_days = excluded.payable_days, rate_per_day = excluded.rate_per_day,
             gross = excluded.gross, advance_deduction = excluded.advance_deduction,
             net_payable = excluded.gross - excluded.advance_deduction - payroll_lines.other_deduction
           WHERE payroll_lines.status IN ('pending','held')`,
          row.id, emp.id, t.applicable, t.counts.P, t.counts.T, t.counts.TA, t.counts.L, t.counts.LE,
          t.payableDays, rate, g, advanceDeduction, otherDeduction, netPayable,
        );
        gross += g;
        net += netPayable;
      });
      audit(req.user.id, 'payroll', period, 'collated', { lines: emps.length });
      return { lines: emps.length, gross: money(gross), net: money(net) };
    });

    res.json({ period: q.get('SELECT * FROM payroll_periods WHERE period = ?', period), ...summary });
  }),
);

/** The driver payment sheet: review, edit attendance counts, hold or pay. */
router.get(
  '/periods/:period',
  h(async (req, res) => {
    const period = req.params.period;
    if (!isPeriod(period)) throw bad('period must be YYYY-MM');
    const row = getPeriod(period);
    if (!row) return res.json({ period: null, rows: [], totals: null });

    const rows = q.all(
      `SELECT l.*, d.id AS driver_id, d.name, d.registration_no, d.bank_account_no, d.bank_ifsc,
              d.bank_name, d.bank_account_name, e.client_id, e.location, e.vehicle_number,
              e.date_of_joining, e.date_of_leaving, e.monthly_wage
       FROM payroll_lines l
       JOIN employments e ON e.id = l.employment_id
       JOIN drivers d ON d.id = e.driver_id
       WHERE l.period_id = ? ORDER BY e.location, d.name`,
      row.id,
    );

    const totals = rows.reduce(
      (t, r) => ({
        count: t.count + 1,
        gross: money(t.gross + r.gross),
        advance: money(t.advance + r.advance_deduction),
        other: money(t.other + r.other_deduction),
        net: money(t.net + (r.hold ? 0 : r.net_payable)),
        held: t.held + (r.hold ? 1 : 0),
        heldAmount: money(t.heldAmount + (r.hold ? r.net_payable : 0)),
        paid: t.paid + (r.status === 'paid' ? 1 : 0),
      }),
      { count: 0, gross: 0, advance: 0, other: 0, net: 0, held: 0, heldAmount: 0, paid: 0 },
    );

    return res.json({ period: row, rows, totals });
  }),
);

/** Confirm the collated attendance with the client. */
router.post(
  '/periods/:period/finalize-attendance',
  allow('accounts', 'senior_manager'),
  h(async (req, res) => {
    const row = getPeriod(req.params.period);
    if (!row) throw notFound('Payroll period not found — collate it first');
    if (['paid', 'closed'].includes(row.status)) throw bad(`Payroll for ${row.period} is already ${row.status}`);
    q.run(
      `UPDATE payroll_periods SET status = 'attendance_finalized', client_confirmed = ?,
                                  client_remarks = ?, finalized_by = ?, finalized_at = datetime('now')
       WHERE id = ?`,
      bool(req.body.client_confirmed ?? true), req.body.client_remarks || null, req.user.id, row.id,
    );
    audit(req.user.id, 'payroll', row.period, 'attendance_finalized');
    res.json(q.get('SELECT * FROM payroll_periods WHERE id = ?', row.id));
  }),
);

/** Edit a single payment line: correct attendance, hold, or adjust deductions. */
router.patch(
  '/lines/:id',
  allow('accounts', 'senior_manager'),
  h(async (req, res) => {
    const line = q.get('SELECT * FROM payroll_lines WHERE id = ?', Number(req.params.id));
    if (!line) throw notFound('Payment line not found');
    const period = q.get('SELECT * FROM payroll_periods WHERE id = ?', line.period_id);
    if (['paid', 'closed'].includes(period.status)) throw bad(`Payroll for ${period.period} is ${period.status}`);
    if (line.status === 'paid') throw bad('This line has already been paid');

    const patch = {};
    ['present_days', 'training_days', 'transit_days', 'leave_days'].forEach((k) => {
      if (req.body[k] !== undefined) {
        patch[k] = num(req.body[k], k, { min: 0, max: 31 });
      }
    });
    if (req.body.rate_per_day !== undefined) patch.rate_per_day = money(num(req.body.rate_per_day, 'rate_per_day', { min: 0 }));
    if (req.body.advance_deduction !== undefined) {
      patch.advance_deduction = money(num(req.body.advance_deduction, 'advance_deduction', { min: 0 }));
    }
    if (req.body.other_deduction !== undefined) {
      patch.other_deduction = money(num(req.body.other_deduction, 'other_deduction', { min: 0 }));
    }
    if (req.body.hold !== undefined) {
      patch.hold = bool(req.body.hold);
      patch.hold_reason = patch.hold ? (req.body.hold_reason || 'Held on review') : null;
      patch.status = patch.hold ? 'held' : 'pending';
    }

    if (!Object.keys(patch).length) throw bad('Nothing to update');

    const merged = { ...line, ...patch };
    const payableDays =
      Number(merged.present_days) + Number(merged.training_days) + Number(merged.transit_days);
    patch.payable_days = payableDays;
    patch.gross = money(payableDays * merged.rate_per_day);
    patch.net_payable = money(patch.gross - merged.advance_deduction - merged.other_deduction);
    if (patch.net_payable < 0) throw bad('Deductions exceed the gross amount for this driver');

    q.run(
      `UPDATE payroll_lines SET ${Object.keys(patch).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
      ...Object.values(patch), line.id,
    );
    audit(req.user.id, 'payroll_line', line.id, 'edited', patch);
    res.json(q.get('SELECT * FROM payroll_lines WHERE id = ?', line.id));
  }),
);

/** Wage register download — the invoicing document. */
router.get(
  '/periods/:period/wage-register',
  h(async (req, res) => {
    const period = req.params.period;
    const row = getPeriod(period);
    if (!row) throw notFound('Payroll period not found — collate it first');

    const rows = q.all(
      `SELECT l.*, d.name, d.registration_no, d.uan_no, d.bank_account_no, d.bank_ifsc,
              e.client_id, e.location, e.vehicle_number, e.date_of_joining, e.monthly_wage
       FROM payroll_lines l JOIN employments e ON e.id = l.employment_id
       JOIN drivers d ON d.id = e.driver_id WHERE l.period_id = ? ORDER BY e.location, d.name`,
      row.id,
    );

    const buf = await buildWorkbook({
      sheetName: `Wage Register ${period}`,
      title: `Wage Register — ${period}${row.client_confirmed ? ' (attendance confirmed with client)' : ''}`,
      columns: [
        { header: 'S.No', key: 'sno', width: 7 },
        { header: 'Client ID', key: 'client_id', width: 12 },
        { header: 'Reg. No', key: 'registration_no', width: 16 },
        { header: 'Driver Name', key: 'name', width: 26 },
        { header: 'UAN', key: 'uan_no', width: 15 },
        { header: 'Location', key: 'location', width: 16 },
        { header: 'Vehicle', key: 'vehicle_number', width: 13 },
        { header: 'DOJ', key: 'date_of_joining', width: 12 },
        { header: 'Monthly Wage', key: 'monthly_wage', width: 14, numFmt: '#,##0.00' },
        { header: 'Rate / Day', key: 'rate_per_day', width: 12, numFmt: '#,##0.00' },
        { header: 'Present (P)', key: 'present_days', width: 11 },
        { header: 'Training (T)', key: 'training_days', width: 11 },
        { header: 'Transit (TA)', key: 'transit_days', width: 11 },
        { header: 'Leave (L)', key: 'leave_days', width: 10 },
        { header: 'Payable Days', key: 'payable_days', width: 13 },
        { header: 'Gross (INR)', key: 'gross', width: 14, numFmt: '#,##0.00' },
        { header: 'Advance Recovery', key: 'advance_deduction', width: 16, numFmt: '#,##0.00' },
        { header: 'Other Deduction', key: 'other_deduction', width: 15, numFmt: '#,##0.00' },
        { header: 'Net Payable', key: 'net_payable', width: 14, numFmt: '#,##0.00' },
        { header: 'Hold', key: 'hold_label', width: 8 },
        { header: 'Status', key: 'status', width: 10 },
      ],
      rows: rows.map((r, i) => ({ ...r, sno: i + 1, hold_label: r.hold ? 'HOLD' : '' })),
      notes: [
        `Drivers: ${rows.length}   |   Gross: INR ${money(rows.reduce((s, r) => s + r.gross, 0)).toLocaleString('en-IN')}   |   Net: INR ${money(rows.reduce((s, r) => s + (r.hold ? 0 : r.net_payable), 0)).toLocaleString('en-IN')}`,
        'Payable days = Present + Training + In Transit. Leave and Left days are not billed.',
      ],
    });

    saveBuffer(buf, {
      filename: `wage-register-${period}.xlsx`, mime: XLSX_MIME,
      ownerType: 'payroll', ownerId: row.id, kind: 'register', userId: req.user.id,
    });
    res.setHeader('Content-Type', XLSX_MIME);
    res.setHeader('Content-Disposition', `attachment; filename="wage-register-${period}.xlsx"`);
    res.send(buf);
  }),
);

/**
 * HDFC e-Net bulk payment sheet. Held lines and lines with no bank details are
 * excluded, and the excluded list is returned in the response header count.
 */
router.get(
  '/periods/:period/enet-sheet',
  allow('accounts'),
  h(async (req, res) => {
    const period = req.params.period;
    const row = getPeriod(period);
    if (!row) throw notFound('Payroll period not found');

    const rows = q.all(
      `SELECT l.*, d.name, d.bank_account_no, d.bank_ifsc, d.bank_account_name, d.registration_no,
              e.client_id FROM payroll_lines l
       JOIN employments e ON e.id = l.employment_id JOIN drivers d ON d.id = e.driver_id
       WHERE l.period_id = ? AND l.hold = 0 AND l.status <> 'paid' AND l.net_payable > 0
       ORDER BY d.name`,
      row.id,
    );
    const payable = rows.filter((r) => r.bank_account_no && r.bank_ifsc);
    const missing = rows.filter((r) => !r.bank_account_no || !r.bank_ifsc);

    const buf = await buildWorkbook({
      sheetName: 'ENET',
      columns: [
        { header: 'Payment Type', key: 'ptype', width: 14 },
        { header: 'Beneficiary Name', key: 'beneficiary', width: 28 },
        { header: 'Beneficiary Account Number', key: 'account', width: 24 },
        { header: 'IFSC', key: 'ifsc', width: 14 },
        { header: 'Amount', key: 'amount', width: 13, numFmt: '#,##0.00' },
        { header: 'Debit Account No', key: 'debit', width: 20 },
        { header: 'Payment Date', key: 'pdate', width: 14 },
        { header: 'Narration', key: 'narration', width: 30 },
        { header: 'Email', key: 'email', width: 20 },
        { header: 'Reference', key: 'reference', width: 18 },
      ],
      rows: payable.map((r) => ({
        ptype: r.net_payable >= 200000 ? 'RTGS' : 'NEFT',
        beneficiary: r.bank_account_name || r.name,
        account: r.bank_account_no,
        ifsc: r.bank_ifsc,
        amount: r.net_payable,
        debit: req.query.debit_account || 'DEBIT_ACCOUNT',
        pdate: req.query.payment_date || today(),
        narration: `SALARY ${period} ${r.client_id || r.registration_no}`.slice(0, 30),
        email: '',
        reference: `SAL-${period}-${r.employment_id}`,
      })),
      notes: missing.length
        ? [`Excluded ${missing.length} driver(s) with incomplete bank details: ${missing.map((m) => m.name).join(', ')}`]
        : [],
    });

    saveBuffer(buf, {
      filename: `hdfc-enet-${period}.xlsx`, mime: XLSX_MIME,
      ownerType: 'payroll', ownerId: row.id, kind: 'register', userId: req.user.id,
    });
    if (payable.length) {
      tx(() => {
        payable.forEach((r) => q.run("UPDATE payroll_lines SET status = 'in_bank' WHERE id = ?", r.id));
        q.run("UPDATE payroll_periods SET status = 'reviewed' WHERE id = ? AND status = 'attendance_finalized'", row.id);
      });
      audit(req.user.id, 'payroll', period, 'enet_sheet_generated', { count: payable.length });
    }

    res.setHeader('Content-Type', XLSX_MIME);
    res.setHeader('X-Excluded-Count', String(missing.length));
    res.setHeader('Content-Disposition', `attachment; filename="hdfc-enet-${period}.xlsx"`);
    res.send(buf);
  }),
);

/** Record payment against individual drivers. */
router.post(
  '/periods/:period/record-payments',
  allow('accounts'),
  h(async (req, res) => {
    const row = getPeriod(req.params.period);
    if (!row) throw notFound('Payroll period not found');
    const payments = Array.isArray(req.body.payments) ? req.body.payments : [];
    if (!payments.length) throw bad('No payments supplied');

    const applied = [];
    const errors = [];
    tx(() => {
      payments.forEach((p) => {
        const line = q.get(
          'SELECT * FROM payroll_lines WHERE id = ? AND period_id = ?', Number(p.line_id), row.id,
        );
        if (!line) {
          errors.push({ line_id: p.line_id, error: 'Line not found in this period' });
          return;
        }
        if (line.hold) {
          errors.push({ line_id: p.line_id, error: 'Line is on hold' });
          return;
        }
        const amount = money(p.amount ?? line.net_payable);
        q.run(
          `UPDATE payroll_lines SET status = 'paid', paid_amount = ?, paid_on = ?, utr = ? WHERE id = ?`,
          amount, p.paid_on || today(), p.utr || null, line.id,
        );
        applied.push({ line_id: line.id, amount });
      });
      settleAdvancesFor(row.id);
      const remaining = Number(q.scalar(
        "SELECT count(*) FROM payroll_lines WHERE period_id = ? AND hold = 0 AND status <> 'paid'", row.id,
      ));
      if (!remaining) q.run("UPDATE payroll_periods SET status = 'paid' WHERE id = ?", row.id);
      audit(req.user.id, 'payroll', row.period, 'payments_recorded', { count: applied.length });
    });

    res.json({ applied: applied.length, errors, period: q.get('SELECT * FROM payroll_periods WHERE id = ?', row.id) });
  }),
);

/** Once salary is paid, mark the recovered portion against the driver's advances. */
function settleAdvancesFor(periodId) {
  const lines = q.all(
    `SELECT l.*, e.driver_id FROM payroll_lines l JOIN employments e ON e.id = l.employment_id
     WHERE l.period_id = ? AND l.status = 'paid' AND l.advance_deduction > 0`,
    periodId,
  );
  lines.forEach((line) => {
    let left = line.advance_deduction;
    const open = q.all(
      `SELECT * FROM advances WHERE driver_id = ? AND status = 'paid' AND recovered < amount
       ORDER BY request_date`,
      line.driver_id,
    );
    open.forEach((adv) => {
      if (left <= 0) return;
      const take = Math.min(left, adv.amount - adv.recovered);
      q.run('UPDATE advances SET recovered = recovered + ? WHERE id = ?', money(take), adv.id);
      left = money(left - take);
    });
  });
}

/**
 * Reconcile against the bank statement: upload the statement and payments are
 * matched to drivers by account number / reference and marked paid.
 */
router.post(
  '/periods/:period/bank-statement',
  allow('accounts'),
  upload.single('file'),
  h(async (req, res) => {
    const row = getPeriod(req.params.period);
    if (!row) throw notFound('Payroll period not found');
    if (!req.file) throw bad('No file uploaded');

    let parsed;
    try {
      parsed = await readWorkbook(req.file.path);
    } finally {
      fs.unlink(req.file.path, () => {});
    }
    if (!parsed.rows.length) throw bad('The statement has no data rows');

    const lines = q.all(
      `SELECT l.*, d.name, d.bank_account_no FROM payroll_lines l
       JOIN employments e ON e.id = l.employment_id JOIN drivers d ON d.id = e.driver_id
       WHERE l.period_id = ?`,
      row.id,
    );

    const pick = (obj, ...names) => {
      for (const n of names) {
        const k = Object.keys(obj).find((key) => key.trim().toLowerCase().includes(n.toLowerCase()));
        if (k) return obj[k];
      }
      return undefined;
    };

    const matched = [];
    const unmatched = [];
    tx(() => {
      parsed.rows.forEach((r) => {
        const ref = String(pick(r, 'reference', 'narration', 'description', 'remark') ?? '');
        const acct = digits(pick(r, 'account', 'beneficiary account', 'credit account') ?? '');
        const amount = money(Number(String(pick(r, 'amount', 'credit', 'withdrawal') ?? '0').replace(/[^\d.-]/g, '')));
        const utr = String(pick(r, 'utr', 'transaction id', 'cheque', 'txn') ?? '').trim() || null;
        const paidOn = String(pick(r, 'date', 'value date', 'txn date') ?? today()).slice(0, 10);

        const refMatch = ref.match(/SAL-\d{4}-\d{2}-(\d+)/i);
        let line = refMatch ? lines.find((l) => String(l.employment_id) === refMatch[1]) : null;
        if (!line && acct) line = lines.find((l) => digits(l.bank_account_no || '') === acct);
        if (!line && amount) {
          const candidates = lines.filter((l) => l.status !== 'paid' && money(l.net_payable) === amount);
          if (candidates.length === 1) [line] = candidates;
        }

        if (!line) {
          unmatched.push({ row: r.__row, ref: ref.slice(0, 60), account: acct, amount });
          return;
        }
        q.run(
          "UPDATE payroll_lines SET status = 'paid', paid_amount = ?, paid_on = ?, utr = ? WHERE id = ?",
          amount || line.net_payable, /^\d{4}-\d{2}-\d{2}$/.test(paidOn) ? paidOn : today(), utr, line.id,
        );
        matched.push({ line_id: line.id, driver: line.name, amount: amount || line.net_payable, utr });
      });
      settleAdvancesFor(row.id);
      const remaining = Number(q.scalar(
        "SELECT count(*) FROM payroll_lines WHERE period_id = ? AND hold = 0 AND status <> 'paid'", row.id,
      ));
      if (!remaining) q.run("UPDATE payroll_periods SET status = 'paid' WHERE id = ?", row.id);
      audit(req.user.id, 'payroll', row.period, 'bank_statement_reconciled', {
        matched: matched.length, unmatched: unmatched.length,
      });
    });

    res.json({
      matched: matched.length, unmatched: unmatched.length,
      details: { matched: matched.slice(0, 100), unmatched: unmatched.slice(0, 100) },
      period: q.get('SELECT * FROM payroll_periods WHERE id = ?', row.id),
    });
  }),
);

router.post(
  '/periods/:period/close',
  allow('accounts'),
  h(async (req, res) => {
    const row = getPeriod(req.params.period);
    if (!row) throw notFound('Payroll period not found');
    const open = Number(q.scalar(
      "SELECT count(*) FROM payroll_lines WHERE period_id = ? AND hold = 0 AND status <> 'paid'", row.id,
    ));
    if (open && !req.body.force) {
      throw bad(`${open} driver(s) are still unpaid. Put them on hold or record payment first.`);
    }
    tx(() => {
      q.run("UPDATE payroll_periods SET status = 'closed' WHERE id = ?", row.id);
      // Lock the month's attendance so the register cannot drift after invoicing.
      const days = periodDays(row.period);
      q.run(
        `UPDATE attendance SET locked = 1 WHERE day BETWEEN ? AND ?`,
        days[0], days[days.length - 1],
      );
      audit(req.user.id, 'payroll', row.period, 'closed');
    });
    res.json(q.get('SELECT * FROM payroll_periods WHERE id = ?', row.id));
  }),
);

export default router;
