import fs from 'node:fs';
import { Router } from 'express';
import { q, tx, audit } from '../db.js';
import { authenticate, allow } from '../auth.js';
import { upload } from '../files.js';
import { buildWorkbook, readWorkbook, XLSX_MIME } from '../excel.js';
import { h, bad, notFound, oneOf, bool, isDate, digits } from '../util.js';
import { toIsoDate } from '../scan.js';

const router = Router();
router.use(authenticate);

export const TYPES = ['GMC', 'GPA', 'GTL', 'WC'];
export const TYPE_LABEL = {
  GMC: 'Group Medical Cover',
  GPA: 'Group Personal Accident',
  GTL: 'Group Term Life',
  WC: 'Workmen Compensation',
};

const yes = (v) => {
  const s = String(v ?? '').trim().toLowerCase();
  return ['y', 'yes', 'true', '1', 'covered', 'x'].includes(s) ? 1 : 0;
};

router.get('/types', (_req, res) => res.json({ types: TYPES, labels: TYPE_LABEL }));

/** Coverage matrix for deployed drivers, one row per driver, one column per policy. */
router.get(
  '/',
  h(async (req, res) => {
    const { search = '', location = '', type = '', covered = '', includeUndeployed = 'false' } = req.query;
    const where = [];
    const params = [];
    if (includeUndeployed !== 'true') where.push('e.id IS NOT NULL');
    if (search) {
      where.push('(d.name LIKE ? OR d.registration_no LIKE ? OR e.client_id LIKE ?)');
      const like = `%${search}%`;
      params.push(like, like, like);
    }
    if (location) {
      where.push('e.location = ?');
      params.push(location);
    }

    const drivers = q.all(
      `SELECT d.id, d.name, d.registration_no, d.phone, d.uan_no,
              e.client_id, e.location, e.date_of_joining
       FROM drivers d
       LEFT JOIN employments e ON e.driver_id = d.id AND e.status = 'active'
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY d.name`,
      ...params,
    );

    const cover = q.all('SELECT * FROM insurance');
    const byDriver = new Map();
    cover.forEach((c) => {
      if (!byDriver.has(c.driver_id)) byDriver.set(c.driver_id, {});
      byDriver.get(c.driver_id)[c.type] = c;
    });

    let rows = drivers.map((d) => {
      const policies = {};
      TYPES.forEach((t) => {
        const c = byDriver.get(d.id)?.[t];
        policies[t] = {
          covered: Boolean(c?.covered),
          policy_no: c?.policy_no || '',
          valid_from: c?.valid_from || '',
          valid_to: c?.valid_to || '',
        };
      });
      return { ...d, policies };
    });

    if (type) {
      const t = oneOf(String(type).toUpperCase(), TYPES, 'type');
      if (covered === 'true') rows = rows.filter((r) => r.policies[t].covered);
      if (covered === 'false') rows = rows.filter((r) => !r.policies[t].covered);
    }

    const summary = {};
    TYPES.forEach((t) => {
      summary[t] = rows.filter((r) => r.policies[t].covered).length;
    });
    res.json({ rows, total: rows.length, summary, types: TYPES, labels: TYPE_LABEL });
  }),
);

/** Update one policy for one driver (the tick-box / dropdown in the UI). */
router.put(
  '/:driverId/:type',
  allow('supervisor', 'finance'),
  h(async (req, res) => {
    const driverId = Number(req.params.driverId);
    if (!q.get('SELECT id FROM drivers WHERE id = ?', driverId)) throw notFound('Driver not found');
    const type = oneOf(String(req.params.type).toUpperCase(), TYPES, 'type');
    const { policy_no, valid_from, valid_to, remarks } = req.body;
    if (valid_from && !isDate(valid_from)) throw bad('valid_from must be YYYY-MM-DD');
    if (valid_to && !isDate(valid_to)) throw bad('valid_to must be YYYY-MM-DD');

    q.run(
      `INSERT INTO insurance(driver_id, type, covered, policy_no, valid_from, valid_to, remarks, updated_by)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(driver_id, type) DO UPDATE SET
         covered = excluded.covered, policy_no = excluded.policy_no,
         valid_from = excluded.valid_from, valid_to = excluded.valid_to,
         remarks = excluded.remarks, updated_by = excluded.updated_by,
         updated_at = datetime('now')`,
      driverId, type, bool(req.body.covered), policy_no || null,
      valid_from || null, valid_to || null, remarks || null, req.user.id,
    );
    audit(req.user.id, 'insurance', driverId, 'updated', { type, covered: bool(req.body.covered) });
    res.json(q.get('SELECT * FROM insurance WHERE driver_id = ? AND type = ?', driverId, type));
  }),
);

/**
 * Download the coverage list. Without ?type= you get the full matrix; with
 * ?type=GMC&covered=true you get exactly the drivers covered under that policy.
 * The same layout is accepted back by the upload endpoint.
 */
router.get(
  '/export',
  h(async (req, res) => {
    const type = req.query.type ? oneOf(String(req.query.type).toUpperCase(), TYPES, 'type') : null;
    const coveredOnly = req.query.covered === 'true';

    const drivers = q.all(
      `SELECT d.id, d.name, d.registration_no, d.phone, d.uan_no, d.dob_aadhar,
              e.client_id, e.location, e.date_of_joining
       FROM drivers d
       LEFT JOIN employments e ON e.driver_id = d.id AND e.status = 'active'
       WHERE e.id IS NOT NULL ORDER BY d.name`,
    );
    const cover = q.all('SELECT * FROM insurance');
    const byDriver = new Map();
    cover.forEach((c) => {
      if (!byDriver.has(c.driver_id)) byDriver.set(c.driver_id, {});
      byDriver.get(c.driver_id)[c.type] = c;
    });

    const base = [
      { header: 'Registration No', key: 'registration_no', width: 18 },
      { header: 'Client ID', key: 'client_id', width: 12 },
      { header: 'Driver Name', key: 'name', width: 26 },
      { header: 'Phone', key: 'phone', width: 14 },
      { header: 'Date of Birth', key: 'dob_aadhar', width: 14 },
      { header: 'UAN', key: 'uan_no', width: 16 },
      { header: 'Location', key: 'location', width: 16 },
      { header: 'Date of Joining', key: 'date_of_joining', width: 15 },
    ];

    const columns = type
      ? [...base,
        { header: 'Covered', key: 'covered', width: 10 },
        { header: 'Policy No', key: 'policy_no', width: 20 },
        { header: 'Valid From', key: 'valid_from', width: 13 },
        { header: 'Valid To', key: 'valid_to', width: 13 }]
      : [...base, ...TYPES.flatMap((t) => [
        { header: t, key: t, width: 8 },
        { header: `${t} Policy No`, key: `${t} Policy No`, width: 18 },
        { header: `${t} Valid From`, key: `${t} Valid From`, width: 14 },
        { header: `${t} Valid To`, key: `${t} Valid To`, width: 13 },
      ])];

    let rows = drivers.map((d) => {
      const row = { ...d };
      if (type) {
        const c = byDriver.get(d.id)?.[type];
        row.covered = c?.covered ? 'Yes' : 'No';
        row.policy_no = c?.policy_no || '';
        row.valid_from = c?.valid_from || '';
        row.valid_to = c?.valid_to || '';
      } else {
        TYPES.forEach((t) => {
          const c = byDriver.get(d.id)?.[t];
          row[t] = c?.covered ? 'Yes' : 'No';
          row[`${t} Policy No`] = c?.policy_no || '';
          row[`${t} Valid From`] = c?.valid_from || '';
          row[`${t} Valid To`] = c?.valid_to || '';
        });
      }
      return row;
    });

    if (type && coveredOnly) rows = rows.filter((r) => r.covered === 'Yes');

    const label = type ? `${type} — ${TYPE_LABEL[type]}` : 'All Policies';
    const buf = await buildWorkbook({
      sheetName: type || 'Insurance',
      title: `Insurance Coverage — ${label}`,
      columns,
      rows,
      notes: [
        'Edit the Yes/No, policy number and the Valid From / Valid To columns, then upload this file '
          + 'back to update coverage in bulk. Dates may be written as YYYY-MM-DD or DD/MM/YYYY.',
        'Registration No (or Client ID) identifies the driver — do not change those columns.',
        'A blank policy number or date leaves the value already on record untouched.',
      ],
    });
    res.setHeader('Content-Type', XLSX_MIME);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="insurance-${type || 'all'}${coveredOnly ? '-covered' : ''}.xlsx"`,
    );
    res.send(buf);
  }),
);

/** Bulk update coverage from an uploaded sheet. */
router.post(
  '/import',
  allow('supervisor', 'finance'),
  upload.single('file'),
  h(async (req, res) => {
    if (!req.file) throw bad('No file uploaded');
    const forcedType = req.body.type ? oneOf(String(req.body.type).toUpperCase(), TYPES, 'type') : null;
    const dryRun = req.body.dry_run === 'true' || req.body.dry_run === true;

    let parsed;
    try {
      parsed = await readWorkbook(req.file.path);
    } finally {
      fs.unlink(req.file.path, () => {});
    }
    const { headers, rows } = parsed;
    if (!rows.length) throw bad('The uploaded sheet has no data rows');

    const key = (obj, ...names) => {
      for (const n of names) {
        const found = Object.keys(obj).find((k) => k.trim().toLowerCase() === n.toLowerCase());
        if (found) return obj[found];
      }
      return undefined;
    };

    /** Is this column present in the uploaded sheet at all? */
    const hasColumn = (name) =>
      headers.some((h) => String(h).trim().toLowerCase() === name.toLowerCase());

    const results = { updated: 0, skipped: 0, errors: [] };
    const changes = [];

    tx(() => {
      rows.forEach((row) => {
        const reg = String(key(row, 'Registration No', 'Reg No', 'Registration') ?? '').trim();
        const clientId = String(key(row, 'Client ID', 'ID', 'Employee ID') ?? '').trim();
        const driver = reg
          ? q.get('SELECT id, name FROM drivers WHERE registration_no = ?', reg)
          : clientId
            ? q.get(
              `SELECT d.id, d.name FROM drivers d JOIN employments e ON e.driver_id = d.id
               WHERE e.client_id = ?`, digits(clientId),
            )
            : null;

        if (!driver) {
          results.errors.push({ row: row.__row, error: `Driver not found (${reg || clientId || 'no identifier'})` });
          return;
        }

        /**
         * Apply one policy for this driver.
         *
         * The sheet is authoritative for every column it actually carries: a
         * cell the supervisor cleared clears the stored value, because the
         * sheet they downloaded and edited *is* the state they want. A column
         * that is not in the sheet at all is left alone, so a cut-down sheet
         * with only the Yes/No columns does not wipe policy numbers.
         */
        const applyType = (t) => {
          const single = forcedType && t === forcedType;
          const coveredCol = single ? 'Covered' : t;
          const policyCol = single ? 'Policy No' : `${t} Policy No`;
          const fromCol = single ? 'Valid From' : `${t} Valid From`;
          const toCol = single ? 'Valid To' : `${t} Valid To`;

          // Nothing about this policy in the sheet: not this row's business.
          if (!hasColumn(coveredCol)) return false;

          const existing = q.get(
            'SELECT * FROM insurance WHERE driver_id = ? AND type = ?', driver.id, t,
          ) || {};

          // A blank cell in a column the sheet carries means "clear this".
          const fromSheet = (col, current, transform = (v) => v) => {
            if (!hasColumn(col)) return current ?? null;
            const raw = key(row, col);
            const text = raw === undefined || raw === null ? '' : String(raw).trim();
            return text === '' ? null : transform(text);
          };

          const covered = yes(key(row, coveredCol));
          const policyNo = fromSheet(policyCol, existing.policy_no);
          const validFrom = fromSheet(fromCol, existing.valid_from, toIsoDate);
          const validTo = fromSheet(toCol, existing.valid_to, toIsoDate);

          const before = {
            covered: Boolean(existing.covered),
            policy_no: existing.policy_no ?? null,
            valid_from: existing.valid_from ?? null,
            valid_to: existing.valid_to ?? null,
          };
          const after = {
            covered: Boolean(covered), policy_no: policyNo, valid_from: validFrom, valid_to: validTo,
          };
          const changed = Object.keys(after).some((k) => before[k] !== after[k]);

          changes.push({
            driver: driver.name, type: t, changed, ...after,
            was: changed ? before : undefined,
          });

          if (!dryRun) {
            q.run(
              `INSERT INTO insurance(driver_id, type, covered, policy_no, valid_from, valid_to, updated_by)
               VALUES (?,?,?,?,?,?,?)
               ON CONFLICT(driver_id, type) DO UPDATE SET
                 covered = excluded.covered,
                 policy_no = excluded.policy_no,
                 valid_from = excluded.valid_from,
                 valid_to = excluded.valid_to,
                 updated_by = excluded.updated_by, updated_at = datetime('now')`,
              driver.id, t, covered, policyNo, validFrom, validTo, req.user.id,
            );
          }
          return true;
        };

        const before = changes.length;
        const touched = (forcedType ? [forcedType] : TYPES).map(applyType).some(Boolean);
        const rowChanged = changes.slice(before).some((c) => c.changed);
        if (touched) {
          results.updated += 1;
          if (rowChanged) results.changed = (results.changed || 0) + 1;
        }
        else {
          results.skipped += 1;
          results.errors.push({ row: row.__row, error: 'No recognised policy column on this row' });
        }
      });
      if (dryRun) throw new RollbackDryRun(results, changes, headers);
    });

    audit(req.user.id, 'insurance', null, 'bulk_import', { updated: results.updated });
    res.json({ ...results, dryRun: false, headers, changes: changes.slice(0, 50) });
  }),
);

/** Sentinel used to roll back a dry-run import. */
class RollbackDryRun extends Error {
  constructor(results, changes, headers) {
    super('dry-run');
    this.results = results;
    this.changes = changes;
    this.headers = headers;
    this.dryRun = true;
  }
}

// Convert the dry-run rollback into a normal 200 response.
router.use((err, _req, res, next) => {
  if (err?.dryRun) {
    return res.json({
      ...err.results, dryRun: true, headers: err.headers, changes: err.changes.slice(0, 50),
    });
  }
  return next(err);
});

export default router;
