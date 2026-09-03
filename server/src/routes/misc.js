import fs from 'node:fs';
import { Router } from 'express';
import { q } from '../db.js';
import { authenticate } from '../auth.js';
import { attachmentPath } from '../files.js';
import { config } from '../config.js';
import { h, notFound, today, money, addDays } from '../util.js';

const router = Router();

// ------------------------------------------------------------------- files
// Documents are PII, so they are served through an authenticated route rather
// than a static mount. Browsers cannot set headers on <img>/<a>, so the token
// may also arrive as ?t=<jwt> (handled in auth.js).
router.get(
  '/files/:id',
  authenticate,
  h(async (req, res) => {
    const row = q.get('SELECT * FROM attachments WHERE id = ?', req.params.id);
    if (!row) throw notFound('File not found');
    const abs = attachmentPath(row);
    if (!fs.existsSync(abs)) throw notFound('File is missing from storage');

    res.setHeader('Content-Type', row.mime || 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader(
      'Content-Disposition',
      `${req.query.download === '1' ? 'attachment' : 'inline'}; filename="${row.filename.replace(/"/g, '')}"`,
    );
    fs.createReadStream(abs).pipe(res);
  }),
);

// --------------------------------------------------------------- dashboard
router.get(
  '/dashboard',
  authenticate,
  h(async (req, res) => {
    const now = today();
    const monthStart = `${now.slice(0, 7)}-01`;
    const in60 = addDays(now, 60);

    const drivers = {
      total: Number(q.scalar('SELECT count(*) FROM drivers')),
      deployed: Number(q.scalar("SELECT count(*) FROM employments WHERE status = 'active'")),
      inScreening: Number(q.scalar("SELECT count(*) FROM drivers WHERE status IN ('registered','in_screening')")),
      cleared: Number(q.scalar("SELECT count(*) FROM drivers WHERE status = 'cleared'")),
      left: Number(q.scalar("SELECT count(*) FROM drivers WHERE status = 'left'")),
    };

    const attendanceToday = q.all(
      `SELECT COALESCE(a.code, 'P') AS code, count(*) AS n
       FROM employments e LEFT JOIN attendance a ON a.employment_id = e.id AND a.day = ?
       WHERE e.status = 'active' AND e.date_of_joining <= ?
       GROUP BY COALESCE(a.code, 'P')`,
      now, now,
    );

    const approvals = {
      advances_pending_approval: Number(q.scalar(
        "SELECT count(*) FROM advances WHERE status = 'pending_approval'",
      )),
      advances_to_pay: Number(q.scalar("SELECT count(*) FROM advances WHERE status = 'approved'")),
      advances_to_pay_amount: money(Number(q.scalar(
        "SELECT COALESCE(sum(amount),0) FROM advances WHERE status = 'approved'",
      ))),
      expenses_pending_approval: Number(q.scalar(
        "SELECT count(*) FROM expenses WHERE status = 'pending_approval'",
      )),
      expenses_open: Number(q.scalar("SELECT count(*) FROM expenses WHERE status = 'approved'")),
    };

    const money_ = {
      advances_this_month: money(Number(q.scalar(
        "SELECT COALESCE(sum(amount),0) FROM advances WHERE request_date >= ? AND status IN ('approved','paid')",
        monthStart,
      ))),
      advance_outstanding: money(Number(q.scalar(
        "SELECT COALESCE(sum(amount - recovered),0) FROM advances WHERE status = 'paid'",
      ))),
      expenses_this_month: money(Number(q.scalar(
        "SELECT COALESCE(sum(COALESCE(paid_amount, amount)),0) FROM expenses WHERE request_date >= ? AND status IN ('approved','settled')",
        monthStart,
      ))),
    };

    const insuranceGaps = q.all(
      `SELECT t.type, count(*) AS uncovered FROM (SELECT 'GMC' AS type UNION SELECT 'GPA'
        UNION SELECT 'GTL' UNION SELECT 'WC') t
       JOIN employments e ON e.status = 'active'
       JOIN drivers d ON d.id = e.driver_id
       WHERE NOT EXISTS (
         SELECT 1 FROM insurance i WHERE i.driver_id = d.id AND i.type = t.type AND i.covered = 1)
       GROUP BY t.type`,
    );

    const alerts = {
      dlExpiring: q.all(
        `SELECT d.id, d.name, d.registration_no, d.dl_valid_till FROM drivers d
         JOIN employments e ON e.driver_id = d.id AND e.status = 'active'
         WHERE d.dl_valid_till IS NOT NULL AND d.dl_valid_till <= ?
         ORDER BY d.dl_valid_till LIMIT 25`,
        in60,
      ),
      missingBank: Number(q.scalar(
        `SELECT count(*) FROM drivers d JOIN employments e ON e.driver_id = d.id AND e.status = 'active'
         WHERE d.bank_account_no IS NULL OR d.bank_ifsc IS NULL`,
      )),
      screeningStuck: Number(q.scalar(
        `SELECT count(*) FROM drivers WHERE status IN ('registered','in_screening')
         AND created_at <= datetime('now', '-14 day')`,
      )),
    };

    const payroll = q.all(
      `SELECT p.period, p.status,
              (SELECT count(*) FROM payroll_lines l WHERE l.period_id = p.id) AS lines,
              (SELECT COALESCE(sum(net_payable),0) FROM payroll_lines l WHERE l.period_id = p.id AND l.hold = 0) AS net
       FROM payroll_periods p ORDER BY p.period DESC LIMIT 3`,
    );

    res.json({
      today: now,
      drivers,
      attendanceToday: Object.fromEntries(attendanceToday.map((r) => [r.code, Number(r.n)])),
      approvals,
      money: money_,
      insuranceGaps,
      alerts,
      payroll,
      rules: {
        expenseDirectorThreshold: config.rules.expenseDirectorThreshold,
        netbankingMaxRequests: config.rules.netbankingMaxRequests,
        cutoffs: config.rules.cutoffs,
      },
    });
  }),
);

// ------------------------------------------------------------------- audit
router.get(
  '/audit',
  authenticate,
  h(async (req, res) => {
    const { entity = '', entity_id = '', limit = 100 } = req.query;
    const where = [];
    const params = [];
    if (entity) {
      where.push('a.entity = ?');
      params.push(entity);
    }
    if (entity_id) {
      where.push('a.entity_id = ?');
      params.push(String(entity_id));
    }
    res.json(
      q.all(
        `SELECT a.*, u.name AS actor_name, u.role AS actor_role FROM audit_log a
         LEFT JOIN users u ON u.id = a.actor_id
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY a.id DESC LIMIT ?`,
        ...params, Math.min(Number(limit) || 100, 500),
      ),
    );
  }),
);

export default router;
