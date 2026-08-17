import { Router } from 'express';
import { q, audit } from '../db.js';
import { authenticate, allow } from '../auth.js';
import { saveBuffer } from '../files.js';
import { buildTallyXml, driverLedger } from '../tally.js';
import { buildWorkbook, XLSX_MIME } from '../excel.js';
import { h, bad, isDate, today, money, addDays, oneOf } from '../util.js';

const router = Router();
router.use(authenticate);
router.use(allow('accounts', 'senior_manager', 'director'));

/** Monday-to-Sunday window containing `date` — the weekly Tally update cycle. */
function weekOf(date) {
  const d = new Date(`${date}T00:00:00Z`);
  const shift = (d.getUTCDay() + 6) % 7; // Monday = 0
  const from = addDays(date, -shift);
  return { from, to: addDays(from, 6) };
}

router.get('/current-week', (_req, res) => res.json(weekOf(today())));

router.get(
  '/history',
  h(async (_req, res) => {
    res.json(
      q.all(
        `SELECT t.*, u.name AS created_by_name FROM tally_exports t
         LEFT JOIN users u ON u.id = t.created_by ORDER BY t.created_at DESC LIMIT 100`,
      ),
    );
  }),
);

/** Rows that would go into Tally for a window — previewed before export. */
function collect(kind, from, to) {
  if (kind === 'advance') {
    return q.all(
      `SELECT a.id, a.paid_at AS date, a.amount, a.reason, a.utr, d.name, d.registration_no,
              e.client_id
       FROM advances a JOIN drivers d ON d.id = a.driver_id
       LEFT JOIN employments e ON e.id = a.employment_id
       WHERE a.status = 'paid' AND a.paid_at BETWEEN ? AND ? AND a.tally_export_id IS NULL
       ORDER BY a.paid_at, a.id`,
      from, to,
    ).map((r) => ({
      ...r,
      ledger: driverLedger(r),
      voucherType: 'Payment',
      counterLedger: 'HDFC Bank',
      narration: `Salary advance — ${r.reason}`.slice(0, 180),
      reference: `ADV-${r.id}`,
    }));
  }

  if (kind === 'expense') {
    return q.all(
      `SELECT x.id, x.settled_at AS date, COALESCE(x.paid_amount, x.amount) AS amount, x.purpose,
              x.category, x.route, x.txn_ref AS utr, d.name, d.registration_no, e.client_id
       FROM expenses x LEFT JOIN drivers d ON d.id = x.driver_id
       LEFT JOIN employments e ON e.driver_id = d.id AND e.status = 'active'
       WHERE x.status = 'settled' AND x.settled_at BETWEEN ? AND ?
       ORDER BY x.settled_at, x.id`,
      from, to,
    ).map((r) => ({
      ...r,
      ledger: r.name ? driverLedger(r) : `${(r.category || 'Other').replace(/_/g, ' ')} Expenses`,
      voucherType: 'Payment',
      counterLedger: r.route === 'petty_cash' ? 'Petty Cash' : 'HDFC Bank',
      narration: r.purpose.slice(0, 180),
      reference: `EXP-${r.id}`,
    }));
  }

  // salary
  return q.all(
    `SELECT l.id, l.paid_on AS date, l.paid_amount AS amount, l.utr, p.period,
            d.name, d.registration_no, e.client_id
     FROM payroll_lines l JOIN payroll_periods p ON p.id = l.period_id
     JOIN employments e ON e.id = l.employment_id JOIN drivers d ON d.id = e.driver_id
     WHERE l.status = 'paid' AND l.paid_on BETWEEN ? AND ? ORDER BY l.paid_on, l.id`,
    from, to,
  ).map((r) => ({
    ...r,
    ledger: driverLedger(r),
    voucherType: 'Payment',
    counterLedger: 'HDFC Bank',
    narration: `Salary ${r.period}`,
    reference: `SAL-${r.period}-${r.id}`,
  }));
}

router.get(
  '/preview',
  h(async (req, res) => {
    const kind = oneOf(req.query.kind || 'advance', ['advance', 'expense', 'salary'], 'kind');
    const week = weekOf(today());
    const from = req.query.from || week.from;
    const to = req.query.to || week.to;
    if (!isDate(from) || !isDate(to)) throw bad('from and to must be YYYY-MM-DD');
    const rows = collect(kind, from, to);
    res.json({
      kind, from, to, rows,
      count: rows.length,
      total: money(rows.reduce((s, r) => s + (r.amount || 0), 0)),
    });
  }),
);

/**
 * Generate the Tally linkage files for a window. Produces a Tally-importable
 * XML voucher file plus a matching XLSX for manual checking, and records the
 * export so advances are not posted to Tally twice.
 */
router.post(
  '/export',
  h(async (req, res) => {
    const kind = oneOf(req.body.kind || 'advance', ['advance', 'expense', 'salary'], 'kind');
    const week = weekOf(today());
    const from = req.body.from || week.from;
    const to = req.body.to || week.to;
    if (!isDate(from) || !isDate(to)) throw bad('from and to must be YYYY-MM-DD');

    const rows = collect(kind, from, to);
    if (!rows.length) throw bad(`No ${kind} entries to post to Tally between ${from} and ${to}`);

    const xml = buildTallyXml({
      company: req.body.company || 'Quantum',
      entries: rows.map((r) => ({
        date: r.date, voucherType: r.voucherType, narration: r.narration,
        ledger: r.ledger, amount: r.amount, counterLedger: r.counterLedger, reference: r.reference,
      })),
    });

    const xlsx = await buildWorkbook({
      sheetName: 'Tally Entries',
      title: `Tally ${kind} vouchers — ${from} to ${to}`,
      columns: [
        { header: 'Date', key: 'date', width: 13 },
        { header: 'Voucher Type', key: 'voucherType', width: 14 },
        { header: 'Voucher No', key: 'reference', width: 18 },
        { header: 'Dr Ledger', key: 'ledger', width: 34 },
        { header: 'Cr Ledger', key: 'counterLedger', width: 18 },
        { header: 'Amount (INR)', key: 'amount', width: 14, numFmt: '#,##0.00' },
        { header: 'Client ID', key: 'client_id', width: 12 },
        { header: 'Narration', key: 'narration', width: 40 },
        { header: 'UTR / Ref', key: 'utr', width: 20 },
      ],
      rows,
      notes: [`${rows.length} vouchers, total INR ${money(rows.reduce((s, r) => s + r.amount, 0)).toLocaleString('en-IN')}`],
    });

    const total = money(rows.reduce((s, r) => s + r.amount, 0));
    const xmlId = saveBuffer(Buffer.from(xml, 'utf8'), {
      filename: `tally-${kind}-${from}_to_${to}.xml`, mime: 'application/xml',
      ownerType: 'system', ownerId: null, kind: 'register', userId: req.user.id,
    });
    const xlsxId = saveBuffer(xlsx, {
      filename: `tally-${kind}-${from}_to_${to}.xlsx`, mime: XLSX_MIME,
      ownerType: 'system', ownerId: null, kind: 'register', userId: req.user.id,
    });

    const exportId = q.insert(
      `INSERT INTO tally_exports(kind, period_from, period_to, entry_count, total_amount,
                                 xml_id, xlsx_id, created_by)
       VALUES (?,?,?,?,?,?,?,?)`,
      kind, from, to, rows.length, total, xmlId, xlsxId, req.user.id,
    );

    // Advances carry a marker so a weekly run never double-posts them.
    if (kind === 'advance') {
      rows.forEach((r) => q.run('UPDATE advances SET tally_export_id = ? WHERE id = ?', exportId, r.id));
    }
    audit(req.user.id, 'tally_export', exportId, 'created', { kind, from, to, count: rows.length });

    res.status(201).json({
      export: q.get('SELECT * FROM tally_exports WHERE id = ?', exportId),
      xmlId, xlsxId, count: rows.length, total,
    });
  }),
);

export default router;
