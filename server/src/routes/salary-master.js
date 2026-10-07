import { Router } from 'express';
import { q, tx, audit } from '../db.js';
import { authenticate, allow } from '../auth.js';
import { buildWorkbook, XLSX_MIME } from '../excel.js';
import { h, need, bad, notFound, isDate, today, money, num, oneOf } from '../util.js';
import { computePay } from '../payroll/engine.js';

const router = Router();
router.use(authenticate);

/**
 * The salary master.
 *
 * "Salary master is required to cover all types of salaries which needs to be
 * given to drivers -- HZL Drivers / Market Drivers. Once driver is deployed,
 * it is linked to a salary structure."
 *
 * A structure is a named set of components: earnings that build the gross, and
 * deductions that come off the net. Each component is either a fixed rupee
 * amount or a percentage of basic or of gross, and is either prorated by
 * attendance or paid whole. The wage register is computed from this, so the
 * arithmetic lives in one place -- `computeSalary` -- and payroll calls it.
 */

const CATEGORIES = ['HZL', 'MARKET'];
export const CATEGORY_LABEL = { HZL: 'HZL Drivers', MARKET: 'Market Drivers' };

const CALCS = ['fixed', 'percent_of_basic', 'percent_of_gross'];
const KINDS = ['earning', 'deduction'];
const ROUNDINGS = ['none', 'rupee'];
const BASES = ['earned', 'fixed'];
const FORMATS = ['standard', 'hzl', 'surat'];
const CONDITION_RE = /^(days_gte|gross_gt|gross_lte):\d+(\.\d+)?$/;

const withComponents = (row) => ({
  ...row,
  components: q.all('SELECT * FROM salary_components WHERE structure_id = ? ORDER BY seq, id', row.id),
  deployments: Number(q.scalar(
    "SELECT count(*) FROM employments WHERE salary_structure_id = ? AND status = 'active'", row.id,
  )),
});

/**
 * Work out one month's pay from a structure.
 *
 * @param {object} structure  a row from salary_structures, with components
 * @param {number} payableDays  P + T + TA for the month
 * @param {number} daysInMonth  calendar days in the month
 */
export function computeSalary(structure, payableDays, daysInMonth, extra = {}) {
  // The arithmetic lives in payroll/engine.js, where it is checked row for row
  // against the client's own registers. This keeps the shape callers expect.
  const p = computePay(structure, {
    payableDays,
    daysInMonth,
    presentDays: extra.presentDays ?? payableDays,
    lsaMonthly: extra.lsaMonthly ?? 0,
  });
  return {
    earnings: p.earnings,
    deductions: p.deductions,
    employer: p.employer,
    gross: p.gross,
    statutoryDeduction: p.totalDeduction,
    net: p.net,
    employerCost: p.employerCost,
    ctc: p.ctc,
    billing: p.billing,
    exact: p.exact,
    monthlyGross: p.monthlyGross,
    ratePerDay: p.ratePerDay,
  };
}

/** Load a structure with its components, ready for computeSalary. */
export function loadStructure(id) {
  if (!id) return null;
  const row = q.get('SELECT * FROM salary_structures WHERE id = ?', Number(id));
  if (!row) return null;
  return withComponents(row);
}

/** Recompute and store the headline monthly gross after any edit. */
function refreshGross(structureId) {
  const s = loadStructure(structureId);
  if (!s) return;
  const { monthlyGross } = computeSalary(s, 30, 30);
  q.run(
    "UPDATE salary_structures SET monthly_gross = ?, updated_at = datetime('now') WHERE id = ?",
    monthlyGross, structureId,
  );
}

// -------------------------------------------------------------------- list
router.get('/meta', (_req, res) => {
  res.json({
    categories: CATEGORIES, categoryLabels: CATEGORY_LABEL, calcs: CALCS, kinds: KINDS,
    roundings: ROUNDINGS, bases: BASES, formats: FORMATS,
  });
});

router.get(
  '/',
  h(async (req, res) => {
    const where = [];
    const params = [];
    if (req.query.category) {
      where.push('category = ?');
      params.push(oneOf(req.query.category, CATEGORIES, 'category'));
    }
    if (req.query.active === 'true') where.push('active = 1');

    const rows = q.all(
      `SELECT * FROM salary_structures ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY category, effective_from DESC, code`,
      ...params,
    ).map(withComponents);

    res.json({ rows, categoryLabels: CATEGORY_LABEL });
  }),
);

router.get(
  '/:id',
  h(async (req, res) => {
    const row = loadStructure(req.params.id);
    if (!row) throw notFound('Salary structure not found');
    res.json(row);
  }),
);

// ------------------------------------------------------------ create / edit
function readComponents(input) {
  if (!Array.isArray(input)) throw bad('components must be a list');
  const list = input
    .filter((c) => c && String(c.name || '').trim())
    .map((c, i) => {
      const name = String(c.name).trim();
      const condition = String(c.condition || '').trim() || null;
      if (condition && !CONDITION_RE.test(condition)) {
        throw bad(`${name}: a condition looks like days_gte:30, gross_gt:12000 or gross_lte:21000`);
      }
      return {
        seq: Number.isFinite(Number(c.seq)) ? Number(c.seq) : i,
        name,
        kind: oneOf(c.kind || 'earning', KINDS, 'component kind'),
        calc: oneOf(c.calc || 'fixed', CALCS, 'component calc'),
        value: money(num(c.value, `${name} value`, { min: 0, max: 10000000 })),
        prorated: c.prorated === false || c.prorated === 0 ? 0 : 1,
        rounding: oneOf(c.rounding || 'none', ROUNDINGS, 'component rounding'),
        basis: oneOf(c.basis || 'earned', BASES, 'component basis'),
        cap: money(num(c.cap || 0, `${name} cap`, { min: 0, max: 10000000 })),
        condition,
        employer: c.employer ? 1 : 0,
        per_driver: c.per_driver ? 1 : 0,
        is_basic: c.is_basic ? 1 : 0,
        notes: c.notes ? String(c.notes).trim() : null,
      };
    });

  if (list.filter((c) => c.is_basic).length > 1) {
    throw bad('Only one component can be marked as the basic');
  }
  list.forEach((c) => {
    if (c.employer && c.kind !== 'deduction') {
      throw bad(`${c.name}: an employer contribution is entered as a deduction-type line`);
    }
    if (c.per_driver && c.kind !== 'earning') {
      throw bad(`${c.name}: an amount set per driver must be an earning`);
    }
    if (c.condition && c.kind === 'earning' && !c.condition.startsWith('days_')) {
      throw bad(`${c.name}: an earning can only depend on days (days_gte:N) — gross isn't known yet`);
    }
  });
  return list;
}

/** Insert one component with every rule it carries. */
function insertComponent(structureId, c) {
  q.run(
    `INSERT INTO salary_components(structure_id, seq, name, kind, calc, value, prorated,
       rounding, basis, cap, condition, employer, per_driver, is_basic, notes)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    structureId, c.seq, c.name, c.kind, c.calc, c.value, c.prorated,
    c.rounding, c.basis, c.cap, c.condition, c.employer, c.per_driver, c.is_basic, c.notes,
  );
}

/** Billing and register fields a structure may carry. */
function billingPatch(body) {
  const out = {};
  if (body.service_charge !== undefined) {
    out.service_charge = money(num(body.service_charge || 0, 'Service charge', { min: 0, max: 1000000 }));
  }
  if (body.gst_rate !== undefined) out.gst_rate = money(num(body.gst_rate || 0, 'GST rate', { min: 0, max: 100 }));
  if (body.tds_rate !== undefined) out.tds_rate = money(num(body.tds_rate || 0, 'TDS rate', { min: 0, max: 100 }));
  if (body.register_format !== undefined) {
    out.register_format = oneOf(body.register_format || 'standard', FORMATS, 'register format');
  }
  if (body.role_label !== undefined) {
    out.role_label = body.role_label ? String(body.role_label).trim().slice(0, 80) : null;
  }
  return out;
}

router.post(
  '/',
  allow('salary_master.manage'),
  h(async (req, res) => {
    need(req.body, ['code', 'name', 'category', 'effective_from']);
    const category = oneOf(req.body.category, CATEGORIES, 'category');
    const code = String(req.body.code).trim().toUpperCase();
    const effectiveFrom = req.body.effective_from;
    if (!isDate(effectiveFrom)) throw bad('effective_from must be YYYY-MM-DD');
    if (q.get('SELECT id FROM salary_structures WHERE code = ?', code)) {
      throw bad(`A salary structure with the code ${code} already exists`);
    }

    const components = readComponents(req.body.components || []);
    if (!components.some((c) => c.kind === 'earning')) {
      throw bad('A salary structure needs at least one earning component');
    }

    const id = tx(() => {
      const newId = q.insert(
        `INSERT INTO salary_structures(code, name, category, effective_from, ot_rate_hour, notes, created_by)
         VALUES (?,?,?,?,?,?,?)`,
        code, String(req.body.name).trim(), category, effectiveFrom,
        money(req.body.ot_rate_hour || 0), req.body.notes || null, req.user.id,
      );
      const extra = billingPatch(req.body);
      if (Object.keys(extra).length) {
        q.run(
          `UPDATE salary_structures SET ${Object.keys(extra).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
          ...Object.values(extra), newId,
        );
      }
      components.forEach((c) =>
        insertComponent(newId, c));
      audit(req.user.id, 'salary_structure', newId, 'created', { code, category });
      return newId;
    });

    refreshGross(id);
    res.status(201).json(loadStructure(id));
  }),
);

router.patch(
  '/:id',
  allow('salary_master.manage'),
  h(async (req, res) => {
    const id = Number(req.params.id);
    const existing = q.get('SELECT * FROM salary_structures WHERE id = ?', id);
    if (!existing) throw notFound('Salary structure not found');

    const patch = {};
    if (req.body.name !== undefined) patch.name = String(req.body.name).trim();
    if (req.body.category !== undefined) patch.category = oneOf(req.body.category, CATEGORIES, 'category');
    if (req.body.effective_from !== undefined) {
      if (!isDate(req.body.effective_from)) throw bad('effective_from must be YYYY-MM-DD');
      patch.effective_from = req.body.effective_from;
    }
    if (req.body.ot_rate_hour !== undefined) patch.ot_rate_hour = money(req.body.ot_rate_hour);
    Object.assign(patch, billingPatch(req.body));
    if (req.body.notes !== undefined) patch.notes = req.body.notes || null;
    if (req.body.active !== undefined) patch.active = req.body.active ? 1 : 0;

    tx(() => {
      if (Object.keys(patch).length) {
        q.run(
          `UPDATE salary_structures SET ${Object.keys(patch).map((k) => `${k} = ?`).join(', ')},
                  updated_at = datetime('now') WHERE id = ?`,
          ...Object.values(patch), id,
        );
      }
      if (req.body.components !== undefined) {
        const components = readComponents(req.body.components);
        if (!components.some((c) => c.kind === 'earning')) {
          throw bad('A salary structure needs at least one earning component');
        }
        q.run('DELETE FROM salary_components WHERE structure_id = ?', id);
        components.forEach((c) =>
          insertComponent(id, c));
      }
      audit(req.user.id, 'salary_structure', id, 'updated', patch);
    });

    refreshGross(id);
    res.json(loadStructure(id));
  }),
);

router.delete(
  '/:id',
  allow('salary_master.manage'),
  h(async (req, res) => {
    const id = Number(req.params.id);
    const existing = q.get('SELECT * FROM salary_structures WHERE id = ?', id);
    if (!existing) throw notFound('Salary structure not found');

    const inUse = Number(q.scalar('SELECT count(*) FROM employments WHERE salary_structure_id = ?', id));
    if (inUse) {
      throw bad(
        `${existing.code} is linked to ${inUse} deployment(s) and cannot be deleted. `
          + 'Deactivate it instead — existing deployments keep their structure and new ones stop offering it.',
        { code: 'STRUCTURE_IN_USE', deployments: inUse },
      );
    }
    q.run('DELETE FROM salary_structures WHERE id = ?', id);
    audit(req.user.id, 'salary_structure', id, 'deleted', { code: existing.code });
    res.json({ deleted: true });
  }),
);

// ------------------------------------------------------------------ preview
/** What one month on this structure pays, at a given attendance. */
router.get(
  '/:id/preview',
  h(async (req, res) => {
    const structure = loadStructure(req.params.id);
    if (!structure) throw notFound('Salary structure not found');
    const daysInMonth = Number(req.query.days_in_month) || 30;
    const payableDays = req.query.payable_days === undefined
      ? daysInMonth
      : num(req.query.payable_days, 'payable_days', { min: 0, max: 31 });
    res.json({
      structure: { id: structure.id, code: structure.code, name: structure.name },
      payableDays,
      daysInMonth,
      ...computeSalary(structure, payableDays, daysInMonth, {
        lsaMonthly: Number(req.query.lsa_monthly) || 0,
      }),
    });
  }),
);

// ----------------------------------------------------------------- download
router.get(
  '/export/all',
  h(async (req, res) => {
    const structures = q.all('SELECT * FROM salary_structures ORDER BY category, code').map(withComponents);
    const rows = [];
    structures.forEach((s) => {
      s.components.forEach((c) => {
        rows.push({
          code: s.code,
          name: s.name,
          category: CATEGORY_LABEL[s.category],
          effective_from: s.effective_from,
          active: s.active ? 'Yes' : 'No',
          component: c.name,
          kind: c.kind === 'earning' ? 'Earning' : 'Deduction',
          calc: { fixed: 'Fixed', percent_of_basic: '% of Basic', percent_of_gross: '% of Gross' }[c.calc],
          value: Number(c.value),
          prorated: c.prorated ? 'Yes' : 'No',
        });
      });
      const totals = computeSalary(s, 30, 30);
      rows.push({
        code: s.code, name: s.name, category: CATEGORY_LABEL[s.category],
        effective_from: s.effective_from, active: s.active ? 'Yes' : 'No',
        component: 'MONTHLY GROSS', kind: '', calc: '', value: totals.monthlyGross, prorated: '',
      });
    });

    const buf = await buildWorkbook({
      sheetName: 'Salary Master',
      title: `Salary Master — as on ${today()}`,
      columns: [
        { header: 'Code', key: 'code', width: 14 },
        { header: 'Structure', key: 'name', width: 28 },
        { header: 'Category', key: 'category', width: 16 },
        { header: 'Effective From', key: 'effective_from', width: 15 },
        { header: 'Active', key: 'active', width: 9 },
        { header: 'Component', key: 'component', width: 24 },
        { header: 'Type', key: 'kind', width: 12 },
        { header: 'Basis', key: 'calc', width: 14 },
        { header: 'Value', key: 'value', width: 13, numFmt: '#,##0.00' },
        { header: 'Prorated', key: 'prorated', width: 10 },
      ],
      rows,
      notes: [
        'Prorated components are scaled by payable days / days in the month; the rest are paid whole.',
        'Payable days are P + T + TA. L and LE are not payable.',
      ],
    });
    res.setHeader('Content-Type', XLSX_MIME);
    res.setHeader('Content-Disposition', 'attachment; filename="salary-master.xlsx"');
    res.send(buf);
  }),
);

export default router;
