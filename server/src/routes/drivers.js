import { Router } from 'express';
import { q, tx, audit, nextCounter } from '../db.js';
import { authenticate, allow } from '../auth.js';
import { upload, saveAttachment, removeAttachment } from '../files.js';
import { ocrImage, parseRegistrationText } from '../scan.js';
import {
  h, need, bad, notFound, isDate, validAadhar, validPhone, digits,
  diffDays, humanDuration, today, oneOf,
} from '../util.js';

const router = Router();
router.use(authenticate);

const SCREENING_TYPES = ['trial', 'safety', 'medical'];
const INSURANCE_TYPES = ['GMC', 'GPA', 'GTL', 'WC'];

function allocateRegistrationNo() {
  const year = new Date().getFullYear();
  const n = nextCounter(`registration:${year}`);
  return `QDM/${year}/${String(n).padStart(5, '0')}`;
}

/** Total days of service across every stint the person has ever had. */
export function longevity(driverId) {
  const stints = q.all(
    'SELECT date_of_joining, date_of_leaving FROM employments WHERE driver_id = ? ORDER BY date_of_joining',
    driverId,
  );
  const days = stints.reduce(
    (sum, s) => sum + Math.max(0, diffDays(s.date_of_joining, s.date_of_leaving || today())),
    0,
  );
  return { stints: stints.length, days, label: humanDuration(days) };
}

function driverPayload(body) {
  const p = typeof body.payload === 'string' ? JSON.parse(body.payload) : body;
  return p || {};
}

// -------------------------------------------------------------- list/search
router.get(
  '/',
  h(async (req, res) => {
    const { search = '', status = '', location = '', deployed = '', limit = 100, offset = 0 } = req.query;
    const where = [];
    const params = [];

    if (search) {
      where.push(`(d.name LIKE ? OR d.registration_no LIKE ? OR d.phone LIKE ?
                   OR d.aadhar_no LIKE ? OR e.client_id LIKE ?)`);
      const like = `%${String(search).trim()}%`;
      params.push(like, like, like, digits(search) || like, like);
    }
    if (status) {
      where.push('d.status = ?');
      params.push(status);
    }
    if (location) {
      where.push('e.location = ?');
      params.push(location);
    }
    if (deployed === 'true') where.push('e.id IS NOT NULL');
    if (deployed === 'false') where.push('e.id IS NULL');

    const sql = `
      SELECT d.id, d.registration_no, d.name, d.phone, d.status, d.photo_id, d.dl_valid_till,
             e.id AS employment_id, e.client_id, e.date_of_joining, e.vehicle_number, e.location,
             e.monthly_wage
      FROM drivers d
      LEFT JOIN employments e ON e.driver_id = d.id AND e.status = 'active'
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY d.created_at DESC
      LIMIT ? OFFSET ?`;

    const rows = q.all(sql, ...params, Number(limit), Number(offset));
    const total = q.scalar(
      `SELECT count(*) FROM drivers d
       LEFT JOIN employments e ON e.driver_id = d.id AND e.status = 'active'
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`,
      ...params,
    );
    res.json({ rows, total: Number(total) });
  }),
);

router.get('/locations', (req, res) => {
  res.json(
    q.all("SELECT DISTINCT location FROM employments WHERE location IS NOT NULL AND location <> '' ORDER BY location")
      .map((r) => r.location),
  );
});

// ------------------------------------------------------------------ profile
router.get(
  '/:id',
  h(async (req, res) => {
    const id = Number(req.params.id);
    const driver = q.get('SELECT * FROM drivers WHERE id = ?', id);
    if (!driver) throw notFound('Driver not found');

    const employments = q.all(
      'SELECT * FROM employments WHERE driver_id = ? ORDER BY date_of_joining DESC',
      id,
    );
    res.json({
      driver,
      references: q.all('SELECT * FROM driver_references WHERE driver_id = ?', id),
      screenings: q.all('SELECT * FROM screenings WHERE driver_id = ?', id),
      employments,
      activeEmployment: employments.find((e) => e.status === 'active') || null,
      insurance: q.all('SELECT * FROM insurance WHERE driver_id = ?', id),
      longevity: longevity(id),
      advances: q.all(
        `SELECT a.*, u.name AS requested_by_name FROM advances a
         LEFT JOIN users u ON u.id = a.requested_by
         WHERE a.driver_id = ? ORDER BY a.requested_at DESC LIMIT 25`,
        id,
      ),
      expenses: q.all(
        'SELECT * FROM expenses WHERE driver_id = ? ORDER BY requested_at DESC LIMIT 25',
        id,
      ),
      attachments: q.all(
        "SELECT id, kind, filename, mime, uploaded_at FROM attachments WHERE owner_type = 'driver' AND owner_id = ?",
        String(id),
      ),
    });
  }),
);

// ------------------------------------------------------------- registration
const REG_FILES = upload.fields([
  { name: 'photo', maxCount: 1 },
  { name: 'aadhar_doc', maxCount: 1 },
  { name: 'dl_doc', maxCount: 1 },
]);

router.post(
  '/',
  allow('supervisor', 'senior_manager'),
  REG_FILES,
  h(async (req, res) => {
    const p = driverPayload(req.body);
    need(p, ['name', 'phone', 'aadhar_no']);

    if (!validPhone(p.phone)) throw bad('Phone number must be a valid 10 digit mobile number');
    if (!validAadhar(p.aadhar_no)) throw bad('Aadhar number must be 12 digits');
    if (p.dob_aadhar && !isDate(p.dob_aadhar)) throw bad('Date of birth must be YYYY-MM-DD');
    if (p.dl_valid_till && !isDate(p.dl_valid_till)) throw bad('DL validity must be YYYY-MM-DD');

    // The scope requires the Aadhar DOB to match the DOB on the driving licence.
    if (p.dob_aadhar && p.dl_dob && p.dob_aadhar !== p.dl_dob && !p.dob_mismatch_ack) {
      throw bad(
        `Date of birth on Aadhar (${p.dob_aadhar}) does not match the driving licence (${p.dl_dob}). ` +
          'Correct the details, or resubmit with dob_mismatch_ack to record the exception.',
        { code: 'DOB_MISMATCH' },
      );
    }

    const aadhar = digits(p.aadhar_no);
    const dupe = q.get('SELECT id, registration_no, name FROM drivers WHERE aadhar_no = ?', aadhar);
    if (dupe) {
      throw bad(
        `This Aadhar is already registered to ${dupe.name} (${dupe.registration_no}). ` +
          'Use the existing record and add a new deployment so service longevity stays linked.',
        { code: 'DUPLICATE_AADHAR', driverId: dupe.id },
      );
    }

    const files = req.files || {};
    const result = tx(() => {
      const registrationNo = allocateRegistrationNo();
      const id = q.insert(
        `INSERT INTO drivers
          (registration_no, name, phone, aadhar_no, address, dob_aadhar, dl_no, dl_dob,
           dl_valid_from, dl_valid_till, bank_account_name, bank_account_no, bank_ifsc, bank_name,
           uan_no, remarks, created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        registrationNo,
        p.name.trim(),
        digits(p.phone).slice(-10),
        aadhar,
        p.address || null,
        p.dob_aadhar || null,
        p.dl_no ? String(p.dl_no).toUpperCase().replace(/\s/g, '') : null,
        p.dl_dob || null,
        p.dl_valid_from || null,
        p.dl_valid_till || null,
        p.bank_account_name || p.name.trim(),
        p.bank_account_no ? digits(p.bank_account_no) : null,
        p.bank_ifsc ? String(p.bank_ifsc).toUpperCase() : null,
        p.bank_name || null,
        p.uan_no ? digits(p.uan_no) : null,
        p.dob_mismatch_ack ? `DOB mismatch accepted (Aadhar ${p.dob_aadhar} / DL ${p.dl_dob})` : p.remarks || null,
        req.user.id,
      );

      const attach = (field, kind, column) => {
        const f = files[field]?.[0];
        if (!f) return;
        const attId = saveAttachment(f, {
          ownerType: 'driver', ownerId: id, kind, userId: req.user.id,
        });
        q.run(`UPDATE drivers SET ${column} = ? WHERE id = ?`, attId, id);
      };
      attach('photo', 'photo', 'photo_id');
      attach('aadhar_doc', 'aadhar', 'aadhar_doc_id');
      attach('dl_doc', 'dl', 'dl_doc_id');

      const refs = Array.isArray(p.references) ? p.references.filter((r) => r?.name && r?.phone) : [];
      refs.slice(0, 4).forEach((r) => {
        q.run(
          'INSERT INTO driver_references(driver_id, name, relation, phone) VALUES (?,?,?,?)',
          id, r.name.trim(), r.relation || null, digits(r.phone).slice(-10),
        );
      });

      // Screening checklist is created up front so the pipeline is visible.
      SCREENING_TYPES.forEach((t) => {
        q.run('INSERT INTO screenings(driver_id, type) VALUES (?,?)', id, t);
      });
      INSURANCE_TYPES.forEach((t) => {
        q.run('INSERT INTO insurance(driver_id, type, covered) VALUES (?,?,0)', id, t);
      });

      audit(req.user.id, 'driver', id, 'registered', { registrationNo });
      return { id, registrationNo };
    });

    res.status(201).json({
      id: result.id,
      registration_no: result.registrationNo,
      driver: q.get('SELECT * FROM drivers WHERE id = ?', result.id),
    });
  }),
);

// ---------------------------------------------------------------- edit
const EDITABLE = [
  'name', 'phone', 'address', 'dob_aadhar', 'dl_no', 'dl_dob', 'dl_valid_from', 'dl_valid_till',
  'bank_account_name', 'bank_account_no', 'bank_ifsc', 'bank_name', 'uan_no', 'remarks',
];

router.patch(
  '/:id',
  allow('supervisor', 'senior_manager', 'accounts'),
  h(async (req, res) => {
    const id = Number(req.params.id);
    const driver = q.get('SELECT * FROM drivers WHERE id = ?', id);
    if (!driver) throw notFound('Driver not found');

    const patch = {};
    EDITABLE.forEach((k) => {
      if (req.body[k] !== undefined) patch[k] = req.body[k] === '' ? null : req.body[k];
    });
    if (!Object.keys(patch).length) throw bad('Nothing to update');
    if (patch.phone && !validPhone(patch.phone)) throw bad('Phone number must be a valid 10 digit mobile number');

    const merged = { ...driver, ...patch };
    if (merged.dob_aadhar && merged.dl_dob && merged.dob_aadhar !== merged.dl_dob && !req.body.dob_mismatch_ack) {
      throw bad('Aadhar date of birth and driving licence date of birth do not match', { code: 'DOB_MISMATCH' });
    }

    const sets = Object.keys(patch).map((k) => `${k} = ?`).join(', ');
    q.run(
      `UPDATE drivers SET ${sets}, updated_at = datetime('now') WHERE id = ?`,
      ...Object.values(patch), id,
    );
    audit(req.user.id, 'driver', id, 'updated', patch);
    res.json(q.get('SELECT * FROM drivers WHERE id = ?', id));
  }),
);

// ------------------------------------------------------------ references
router.put(
  '/:id/references',
  allow('supervisor', 'senior_manager'),
  h(async (req, res) => {
    const id = Number(req.params.id);
    if (!q.get('SELECT id FROM drivers WHERE id = ?', id)) throw notFound('Driver not found');
    const refs = Array.isArray(req.body.references) ? req.body.references : [];
    if (refs.some((r) => !r.name || !validPhone(r.phone))) {
      throw bad('Each reference needs a name and a valid 10 digit phone number');
    }
    tx(() => {
      q.run('DELETE FROM driver_references WHERE driver_id = ?', id);
      refs.slice(0, 4).forEach((r) =>
        q.run(
          'INSERT INTO driver_references(driver_id, name, relation, phone) VALUES (?,?,?,?)',
          id, r.name.trim(), r.relation || null, digits(r.phone).slice(-10),
        ),
      );
    });
    audit(req.user.id, 'driver', id, 'references_updated');
    res.json(q.all('SELECT * FROM driver_references WHERE driver_id = ?', id));
  }),
);

// ------------------------------------------------------------- documents
router.post(
  '/:id/documents',
  allow('supervisor', 'senior_manager', 'accounts'),
  upload.single('file'),
  h(async (req, res) => {
    const id = Number(req.params.id);
    const driver = q.get('SELECT * FROM drivers WHERE id = ?', id);
    if (!driver) throw notFound('Driver not found');
    if (!req.file) throw bad('No file uploaded');
    const kind = oneOf(req.body.kind || 'other', ['photo', 'aadhar', 'dl', 'other'], 'kind');

    const attId = saveAttachment(req.file, { ownerType: 'driver', ownerId: id, kind, userId: req.user.id });
    const column = { photo: 'photo_id', aadhar: 'aadhar_doc_id', dl: 'dl_doc_id' }[kind];
    if (column) {
      const previous = driver[column];
      q.run(`UPDATE drivers SET ${column} = ? WHERE id = ?`, attId, id);
      if (previous) removeAttachment(previous);
    }
    audit(req.user.id, 'driver', id, 'document_uploaded', { kind });
    res.status(201).json({ id: attId, kind });
  }),
);

// -------------------------------------------------- screening / onboarding
router.get('/:id/screenings', h(async (req, res) => {
  res.json(q.all('SELECT * FROM screenings WHERE driver_id = ?', Number(req.params.id)));
}));

router.post(
  '/:id/screenings',
  allow('supervisor', 'senior_manager'),
  h(async (req, res) => {
    const id = Number(req.params.id);
    const driver = q.get('SELECT * FROM drivers WHERE id = ?', id);
    if (!driver) throw notFound('Driver not found');

    const type = oneOf(req.body.type, SCREENING_TYPES, 'type');
    const status = oneOf(req.body.status, ['pending', 'passed', 'failed'], 'status');
    const conductedOn = req.body.conducted_on || today();
    if (!isDate(conductedOn)) throw bad('conducted_on must be YYYY-MM-DD');

    q.run(
      `INSERT INTO screenings(driver_id, type, status, conducted_on, remarks, recorded_by)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(driver_id, type) DO UPDATE SET
         status = excluded.status, conducted_on = excluded.conducted_on,
         remarks = excluded.remarks, recorded_by = excluded.recorded_by,
         updated_at = datetime('now')`,
      id, type, status, conductedOn, req.body.remarks || null, req.user.id,
    );

    // Roll the driver status forward based on the whole checklist.
    const all = q.all('SELECT type, status FROM screenings WHERE driver_id = ?', id);
    const passedAll = SCREENING_TYPES.every((t) => all.find((s) => s.type === t)?.status === 'passed');
    const anyFailed = all.some((s) => s.status === 'failed');
    let next = driver.status;
    if (driver.status !== 'deployed' && driver.status !== 'left') {
      if (anyFailed) next = 'rejected';
      else if (passedAll) next = 'cleared';
      else next = 'in_screening';
    }
    if (next !== driver.status) q.run('UPDATE drivers SET status = ? WHERE id = ?', next, id);

    audit(req.user.id, 'driver', id, 'screening_recorded', { type, status });
    res.json({
      screenings: q.all('SELECT * FROM screenings WHERE driver_id = ?', id),
      status: next,
      readyForDeployment: passedAll && !anyFailed,
    });
  }),
);

// --------------------------------------------- scan the registration page
router.post(
  '/scan',
  allow('supervisor', 'senior_manager'),
  upload.single('file'),
  h(async (req, res) => {
    let text = req.body.text || '';
    let engine = 'text';
    let attachmentId = null;

    if (req.file) {
      attachmentId = saveAttachment(req.file, {
        ownerType: 'system', ownerId: null, kind: 'scan', userId: req.user.id,
      });
      if (!text) {
        const ocr = await ocrImage(req.file.path, req.file.mimetype);
        text = ocr.text;
        engine = ocr.engine;
      }
    }

    if (!text) {
      return res.json({
        fields: {}, matched: 0, engine,
        scanId: attachmentId,
        message:
          'The page was stored but no text could be read. Configure OCR_API_URL for automatic ' +
          'extraction, or paste the text from the registration page to auto-fill the form.',
      });
    }

    const parsed = parseRegistrationText(text);
    return res.json({ ...parsed, engine, scanId: attachmentId });
  }),
);

export default router;
