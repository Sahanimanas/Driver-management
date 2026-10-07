import { Router } from 'express';
import { q, tx, audit } from '../db.js';
import { allocateRegistrationNo } from '../regno.js';
import { authenticate, allow } from '../auth.js';
import { driverScope, assertDriver } from '../scope.js';
import { upload, saveAttachment, removeAttachment } from '../files.js';
import { extractFromFile, extractFromText, mergeExtractions, ocrStatus } from '../scan.js';
import {
  h, need, bad, notFound, isDate, validAadhar, validPhone, digits,
  diffDays, humanDuration, today, oneOf,
} from '../util.js';

const router = Router();
router.use(authenticate);

const SCREENING_TYPES = ['trial', 'safety', 'medical'];
const INSURANCE_TYPES = ['GMC', 'GPA', 'GTL', 'WC'];

/**
 * The starred fields of the registration section of the scope. Bank details
 * and the UAN are deliberately absent: the scope allows those two to be filled
 * in at the deployment step instead, so they are checked there rather than
 * here (see deployments.js).
 */
const MANDATORY = [
  ['name', 'Name'],
  ['phone', 'Phone number'],
  ['aadhar_no', 'Aadhar Card Number'],
  ['address', 'Address'],
  ['dob_aadhar', 'Date of birth as per Aadhar'],
  ['dl_no', 'Driving License No'],
  ['dl_valid_till', 'Driving License validity'],
  ['dl_dob', 'Date of birth as per Driving License'],
];

// Aadhar and the licence are both captured front and back.
const MANDATORY_FILES = [
  ['photo', 'Photo'],
  ['aadhar_doc', 'Aadhar (front)'],
  ['aadhar_back_doc', 'Aadhar (back)'],
  ['dl_doc', 'Driving License (front)'],
  ['dl_back_doc', 'Driving License (back)'],
];

/** Upload field -> [attachment kind, column on the driver row]. */
const DOC_SLOTS = {
  photo: ['photo', 'photo_id'],
  aadhar_doc: ['aadhar', 'aadhar_doc_id'],
  aadhar_back_doc: ['aadhar_back', 'aadhar_back_doc_id'],
  dl_doc: ['dl', 'dl_doc_id'],
  dl_back_doc: ['dl_back', 'dl_back_doc_id'],
  bank_proof: ['bank_proof', 'bank_proof_doc_id'],
};

/**
 * Only the account number, IFSC and holder's name are asked for; the bank's
 * name is read off the first four letters of the IFSC, which identify it.
 */
const IFSC_BANKS = {
  SBIN: 'State Bank of India', HDFC: 'HDFC Bank', ICIC: 'ICICI Bank', UTIB: 'Axis Bank',
  PUNB: 'Punjab National Bank', BARB: 'Bank of Baroda', CNRB: 'Canara Bank',
  UBIN: 'Union Bank of India', BKID: 'Bank of India', IOBA: 'Indian Overseas Bank',
  IDIB: 'Indian Bank', CBIN: 'Central Bank of India', MAHB: 'Bank of Maharashtra',
  UCBA: 'UCO Bank', PSIB: 'Punjab & Sind Bank', KKBK: 'Kotak Mahindra Bank',
  YESB: 'Yes Bank', INDB: 'IndusInd Bank', IDFB: 'IDFC First Bank', FDRL: 'Federal Bank',
  AIRP: 'Airtel Payments Bank', IPOS: 'India Post Payments Bank', AUBL: 'AU Small Finance Bank',
  BDBL: 'Bandhan Bank', RATN: 'RBL Bank', KARB: 'Karnataka Bank', SIBL: 'South Indian Bank',
  JAKA: 'Jammu & Kashmir Bank', ESFB: 'Equitas Small Finance Bank', DBSS: 'DBS Bank India',
};

export const bankFromIfsc = (ifsc) => IFSC_BANKS[String(ifsc || '').slice(0, 4).toUpperCase()] || null;

/**
 * Everything a driver still owes before they can be put forward for
 * deployment: the starred registration fields, the document copies, the two
 * reference contacts, and the bank details / UAN that may be deferred.
 */
export function completeness(driverId) {
  const d = q.get('SELECT * FROM drivers WHERE id = ?', driverId);
  if (!d) return null;

  const missing = MANDATORY.filter(([k]) => !d[k]).map(([, label]) => label);
  MANDATORY_FILES.forEach(([field, label]) => {
    if (!d[DOC_SLOTS[field][1]]) missing.push(label);
  });

  const refs = Number(q.scalar('SELECT count(*) FROM driver_references WHERE driver_id = ?', driverId));
  if (refs < 2) missing.push(`Reference contacts (${refs} of 2 recorded)`);

  // Deferrable to the deployment step, but still needed before the first payout.
  const deferred = [];
  if (!d.bank_account_no || !d.bank_ifsc) deferred.push('Bank Account Details');
  if (!d.bank_proof_doc_id) deferred.push('Cancelled cheque or passbook');
  if (!d.uan_no) deferred.push('UAN number');

  return { complete: missing.length === 0, missing, deferred, referenceCount: refs };
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
    const {
      search = '', status = '', location = '', deployed = '', blacklisted = '', limit = 100, offset = 0,
    } = req.query;
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
    // Registered but not deployed: everyone without a live deployment who could
    // still be put forward -- not the blacklisted, not the client-rejected.
    if (deployed === 'false') where.push("e.id IS NULL AND d.blacklisted = 0 AND d.status <> 'rejected'");
    if (blacklisted === 'true') where.push('d.blacklisted = 1');
    const scope = driverScope(req.user);
    where.push(scope.sql);
    params.push(...scope.params);

    const sql = `
      SELECT d.id, d.registration_no, d.name, d.phone, d.status, d.photo_id, d.dl_valid_till,
             d.blacklisted, d.blacklisted_on,
             e.id AS employment_id, e.client_id, e.date_of_joining, e.vehicle_number, e.location,
             e.supervisor_id, s.name AS salary_class, su.name AS supervisor_name
      FROM drivers d
      LEFT JOIN employments e ON e.driver_id = d.id AND e.status = 'active'
      LEFT JOIN salary_structures s ON s.id = e.salary_structure_id
      LEFT JOIN users su ON su.id = e.supervisor_id
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
    assertDriver(req.user, id);

    const employments = q.all(
      `SELECT e.*, s.name AS salary_class, s.code AS salary_class_code, su.name AS supervisor_name
         FROM employments e LEFT JOIN salary_structures s ON s.id = e.salary_structure_id
         LEFT JOIN users su ON su.id = e.supervisor_id
        WHERE e.driver_id = ? ORDER BY e.date_of_joining DESC`,
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
      completeness: completeness(id),
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
      debits: q.all(
        `SELECT x.*, u.name AS created_by_name FROM driver_debits x
         LEFT JOIN users u ON u.id = x.created_by
         WHERE x.driver_id = ? ORDER BY x.debit_date DESC, x.id DESC LIMIT 50`,
        id,
      ),
      blacklistedBy: driver.blacklisted_by
        ? q.get('SELECT name FROM users WHERE id = ?', driver.blacklisted_by)?.name || null
        : null,
      attachments: q.all(
        "SELECT id, kind, filename, mime, uploaded_at FROM attachments WHERE owner_type = 'driver' AND owner_id = ?",
        String(id),
      ),
    });
  }),
);

// ------------------------------------------------------------- registration
const REG_FILES = upload.fields(Object.keys(DOC_SLOTS).map((name) => ({ name, maxCount: 1 })));

router.post(
  '/',
  allow('drivers.register'),
  REG_FILES,
  h(async (req, res) => {
    const p = driverPayload(req.body);
    const files = req.files || {};

    // Starred fields of the scope. A supervisor who genuinely cannot complete
    // one may pass allow_incomplete, which records the driver as an incomplete
    // registration rather than silently accepting a hole.
    const incomplete = [];
    MANDATORY.forEach(([k, label]) => {
      const v = p[k];
      if (v === undefined || v === null || String(v).trim() === '') incomplete.push(label);
    });
    MANDATORY_FILES.forEach(([field, label]) => {
      if (!files[field]?.[0]) incomplete.push(label);
    });
    const refsIn = Array.isArray(p.references) ? p.references.filter((r) => r?.name && r?.phone) : [];
    if (refsIn.length < 2) incomplete.push('Two reference contacts');

    if (incomplete.length && !p.allow_incomplete) {
      throw bad(
        `These are mandatory on the registration form and are still blank: ${incomplete.join(', ')}. `
          + 'Fill them in, or resubmit with allow_incomplete to save a partial registration.',
        { code: 'INCOMPLETE_REGISTRATION', missing: incomplete },
      );
    }

    need(p, ['name', 'phone', 'aadhar_no']);

    if (!validPhone(p.phone)) throw bad('Phone number must be a valid 10 digit mobile number');
    if (!validAadhar(p.aadhar_no)) throw bad('Aadhar number must be 12 digits');
    if (p.dob_aadhar && !isDate(p.dob_aadhar)) throw bad('Date of birth must be YYYY-MM-DD');
    if (p.dl_valid_till && !isDate(p.dl_valid_till)) throw bad('DL validity must be YYYY-MM-DD');
    if (p.bank_ifsc && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(String(p.bank_ifsc).toUpperCase().trim())) {
      throw bad('IFSC code must be 11 characters, e.g. SBIN0004521');
    }

    // The scope requires the Aadhar DOB to match the DOB on the driving licence.
    if (p.dob_aadhar && p.dl_dob && p.dob_aadhar !== p.dl_dob && !p.dob_mismatch_ack) {
      throw bad(
        `Date of birth on Aadhar (${p.dob_aadhar}) does not match the driving licence (${p.dl_dob}). ` +
          'Correct the details, or resubmit with dob_mismatch_ack to record the exception.',
        { code: 'DOB_MISMATCH' },
      );
    }

    // Both sides of the Aadhar and the licence are never optional, even on an
    // incomplete registration. A single PDF holding both sides is uploaded to
    // each of the two fields.
    const sidesMissing = MANDATORY_FILES
      .filter(([field]) => field !== 'photo' && !files[field]?.[0])
      .map(([, label]) => label);
    if (sidesMissing.length) {
      throw bad(
        `Upload both sides of the Aadhar and the Driving License — missing: ${sidesMissing.join(', ')}. `
          + 'An image or a PDF is accepted for each side; if one PDF holds both sides, attach it to both fields.',
        { code: 'DOCUMENT_SIDES_REQUIRED', missing: sidesMissing },
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

    const result = tx(() => {
      const registrationNo = allocateRegistrationNo();
      const id = q.insert(
        `INSERT INTO drivers
          (registration_no, name, phone, aadhar_no, address, dob_aadhar, dl_no, dl_dob,
           dl_valid_from, dl_valid_till, bank_account_name, bank_account_no, bank_ifsc, bank_name,
           bank_branch, uan_no, referred_by, scan_id, remarks, created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
        p.bank_ifsc ? String(p.bank_ifsc).toUpperCase().trim() : null,
        p.bank_name || bankFromIfsc(p.bank_ifsc),
        p.bank_branch ? String(p.bank_branch).trim() : null,
        p.uan_no ? digits(p.uan_no) : null,
        p.referred_by ? String(p.referred_by).trim() : null,
        p.scan_id || null,
        [
          p.dob_mismatch_ack ? `DOB mismatch accepted (Aadhar ${p.dob_aadhar} / DL ${p.dl_dob})` : null,
          incomplete.length ? `Registered incomplete — pending: ${incomplete.join(', ')}` : null,
          p.remarks || null,
        ].filter(Boolean).join(' | ') || null,
        req.user.id,
      );

      Object.entries(DOC_SLOTS).forEach(([field, [kind, column]]) => {
        const f = files[field]?.[0];
        if (!f) return;
        const attId = saveAttachment(f, {
          ownerType: 'driver', ownerId: id, kind, userId: req.user.id,
        });
        q.run(`UPDATE drivers SET ${column} = ? WHERE id = ?`, attId, id);
      });

      refsIn.slice(0, 4).forEach((r) => {
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

      audit(req.user.id, 'driver', id, 'registered', { registrationNo, incomplete });
      return { id, registrationNo };
    });

    res.status(201).json({
      id: result.id,
      registration_no: result.registrationNo,
      driver: q.get('SELECT * FROM drivers WHERE id = ?', result.id),
      completeness: completeness(result.id),
    });
  }),
);

// ---------------------------------------------------------------- edit
const EDITABLE = [
  'name', 'phone', 'address', 'dob_aadhar', 'dl_no', 'dl_dob', 'dl_valid_from', 'dl_valid_till',
  'bank_account_name', 'bank_account_no', 'bank_ifsc', 'bank_name', 'bank_branch', 'uan_no', 'referred_by',
  'remarks',
];

router.patch(
  '/:id',
  allow('drivers.edit'),
  h(async (req, res) => {
    const id = Number(req.params.id);
    const driver = q.get('SELECT * FROM drivers WHERE id = ?', id);
    if (!driver) throw notFound('Driver not found');
    assertDriver(req.user, id);

    const patch = {};
    EDITABLE.forEach((k) => {
      if (req.body[k] !== undefined) patch[k] = req.body[k] === '' ? null : req.body[k];
    });
    if (!Object.keys(patch).length) throw bad('Nothing to update');
    if (patch.phone && !validPhone(patch.phone)) throw bad('Phone number must be a valid 10 digit mobile number');
    if (patch.bank_ifsc) {
      patch.bank_ifsc = String(patch.bank_ifsc).toUpperCase().trim();
      if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(patch.bank_ifsc)) {
        throw bad('IFSC code must be 11 characters, e.g. SBIN0004521');
      }
      if (patch.bank_name === undefined && bankFromIfsc(patch.bank_ifsc)) {
        patch.bank_name = bankFromIfsc(patch.bank_ifsc);
      }
    }
    if (patch.bank_account_no) patch.bank_account_no = digits(patch.bank_account_no);

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
  allow('drivers.register'),
  h(async (req, res) => {
    const id = Number(req.params.id);
    if (!q.get('SELECT id FROM drivers WHERE id = ?', id)) throw notFound('Driver not found');
    assertDriver(req.user, id);
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
  allow('drivers.edit'),
  upload.single('file'),
  h(async (req, res) => {
    const id = Number(req.params.id);
    const driver = q.get('SELECT * FROM drivers WHERE id = ?', id);
    if (!driver) throw notFound('Driver not found');
    assertDriver(req.user, id);
    if (!req.file) throw bad('No file uploaded');
    const columns = Object.fromEntries(Object.values(DOC_SLOTS));
    const kind = oneOf(req.body.kind || 'other', [...Object.keys(columns), 'other'], 'kind');

    const attId = saveAttachment(req.file, { ownerType: 'driver', ownerId: id, kind, userId: req.user.id });
    const column = columns[kind];
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
  assertDriver(req.user, req.params.id);
  res.json(q.all('SELECT * FROM screenings WHERE driver_id = ?', Number(req.params.id)));
}));

router.post(
  '/:id/screenings',
  allow('drivers.register'),
  h(async (req, res) => {
    const id = Number(req.params.id);
    const driver = q.get('SELECT * FROM drivers WHERE id = ?', id);
    if (!driver) throw notFound('Driver not found');
    assertDriver(req.user, id);

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

// --------------------------------------------------------------- blacklist
/**
 * Blacklist a driver who has left, or who was never deployed. A deployed
 * driver is blacklisted by ending the deployment with the blacklist option, so
 * that the date of leaving is recorded in the attendance sheet first.
 */
router.post(
  '/:id/blacklist',
  allow('drivers.blacklist'),
  h(async (req, res) => {
    const id = Number(req.params.id);
    const driver = q.get('SELECT * FROM drivers WHERE id = ?', id);
    if (!driver) throw notFound('Driver not found');
    assertDriver(req.user, id);
    if (driver.blacklisted) throw bad('This driver is already blacklisted');
    const reason = String(req.body.reason || '').trim();
    if (reason.length < 3) throw bad('Record the reason for blacklisting the driver');
    const open = q.get("SELECT client_id FROM employments WHERE driver_id = ? AND status = 'active'", id);
    if (open) {
      throw bad(
        `This driver is deployed under client ID ${open.client_id}. End the deployment and tick `
          + 'the blacklist option there, so the date of leaving is recorded in attendance.',
        { code: 'STILL_DEPLOYED' },
      );
    }
    blacklist(id, reason, req.user.id);
    res.json(q.get('SELECT * FROM drivers WHERE id = ?', id));
  }),
);

/** Lifting a blacklist is a management decision. */
router.post(
  '/:id/blacklist/lift',
  allow('drivers.unblacklist'),
  h(async (req, res) => {
    const id = Number(req.params.id);
    const driver = q.get('SELECT * FROM drivers WHERE id = ?', id);
    if (!driver) throw notFound('Driver not found');
    if (!driver.blacklisted) throw bad('This driver is not blacklisted');
    const reason = String(req.body.reason || '').trim();
    if (reason.length < 3) throw bad('Record why the blacklist is being lifted');
    q.run(
      `UPDATE drivers SET blacklisted = 0, blacklisted_on = NULL, blacklist_reason = NULL,
              blacklisted_by = NULL, updated_at = datetime('now') WHERE id = ?`,
      id,
    );
    audit(req.user.id, 'driver', id, 'blacklist_lifted', {
      reason, previousReason: driver.blacklist_reason, blacklistedOn: driver.blacklisted_on,
    });
    res.json(q.get('SELECT * FROM drivers WHERE id = ?', id));
  }),
);

/** Shared with ending a deployment, which can blacklist in the same step. */
export function blacklist(driverId, reason, userId, on = today()) {
  q.run(
    `UPDATE drivers SET blacklisted = 1, blacklisted_on = ?, blacklist_reason = ?, blacklisted_by = ?,
            updated_at = datetime('now') WHERE id = ?`,
    on, reason, userId, driverId,
  );
  audit(userId, 'driver', driverId, 'blacklisted', { reason, on });
}

// --------------------------------------------- scan the registration page
/** Which engines are available, so the form can say what it is about to do. */
router.get('/scan/status', (_req, res) => res.json(ocrStatus()));

/**
 * "Scan the client registration page to populate the fields of registration,
 * and fields which are blank should be populated manually by supervisor."
 *
 * Takes a PDF, an image or pasted text. Several files can go up at once -- a
 * client page, an Aadhaar card and a licence together -- and the fields are
 * merged, with a labelled reading always beating one recognised by shape.
 *
 * Nothing is saved here. The response is a draft for the supervisor to check
 * and correct, which is the point of the exercise.
 */
router.post(
  '/scan',
  allow('drivers.register'),
  upload.array('files', 5),
  h(async (req, res) => {
    const files = req.files?.length ? req.files : (req.file ? [req.file] : []);
    const pasted = req.body.text || '';

    if (!files.length && !pasted.trim()) {
      throw bad('Upload the registration page, or paste the text from it');
    }

    const results = [];
    const scanIds = [];

    for (const f of files) {
      // The page is kept: it is the evidence behind the registration.
      scanIds.push(saveAttachment(f, {
        ownerType: 'system', ownerId: null, kind: 'scan', userId: req.user.id,
      }));
      results.push(await extractFromFile(f.path, f.mimetype, f.originalname));
    }
    if (pasted.trim()) results.push(extractFromText(pasted));

    const merged = mergeExtractions(results.map((r) => ({
      fields: r.fields, confidence: r.confidence, source: r.name,
    })));

    // Rows from every client page in the upload, de-duplicated.
    const rows = [];
    const seen = new Set();
    results.forEach((r) => (r.rows || []).forEach((row) => {
      const key = `${row.registered_no}|${row.name}`.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      rows.push(row);
    }));

    const notes = results.map((r) => r.note).filter(Boolean);
    const readNothing = !merged.matched && !rows.length;

    audit(req.user.id, 'driver', null, 'registration_page_scanned', {
      files: files.length, matched: merged.matched, rows: rows.length,
    });

    res.json({
      ...merged,
      rows,
      scanId: scanIds[0] || null,
      scanIds,
      engines: results.map((r) => r.engine),
      documents: results.flatMap((r) => r.pages),
      docTypes: [...new Set(results.flatMap((r) => r.docTypes))],
      ocr: ocrStatus(),
      message: readNothing
        ? notes.join(' ') || 'Nothing could be read from the page. Paste the text from it instead, '
          + 'or fill the form in by hand — every field can be typed.'
        : null,
      notes,
    });
  }),
);

export default router;
