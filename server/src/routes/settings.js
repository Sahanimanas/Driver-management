import { Router } from 'express';
import { q, audit } from '../db.js';
import { config } from '../config.js';
import { authenticate, allow } from '../auth.js';
import { upload, saveAttachment, removeAttachment } from '../files.js';
import { h, bad } from '../util.js';

const router = Router();

/**
 * Client-supplied configuration that has to be changeable without a redeploy.
 *
 * The scope opens with "change the name of ... will share logo", so the trading
 * name, the tagline and the logo are all settings rather than constants. The
 * branding is readable without signing in, because the login screen needs it.
 */

const KEYS = {
  app_name: { label: 'Application name', max: 40 },
  app_tagline: { label: 'Tagline', max: 80 },
  client_name: { label: 'Client name', max: 80 },
  logo_attachment_id: { label: 'Logo', max: 64 },
};

const get = (key) => q.get('SELECT value FROM app_settings WHERE key = ?', key)?.value ?? null;

const set = (key, value, userId) =>
  q.run(
    `INSERT INTO app_settings(key, value, updated_by, updated_at)
     VALUES (?,?,?,datetime('now'))
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value, updated_by = excluded.updated_by, updated_at = datetime('now')`,
    key, value, userId ?? null,
  );

export function branding() {
  const logoId = get('logo_attachment_id');
  return {
    appName: get('app_name') || config.branding.appName,
    tagline: get('app_tagline') || config.branding.tagline,
    clientName: get('client_name') || null,
    logoId,
    // The file route is authenticated, so the login screen falls back to text.
    logoUrl: logoId ? `/api/files/${logoId}` : null,
  };
}

/** Public: the login screen has to render before anyone has a session. */
router.get('/branding', (_req, res) => res.json(branding()));

router.get(
  '/settings',
  authenticate,
  h(async (_req, res) => {
    res.json({
      branding: branding(),
      roles: q.all('SELECT key, label, description FROM roles ORDER BY builtin DESC, label'),
      rules: {
        expenseDirectorThreshold: config.rules.expenseDirectorThreshold,
        netbankingMaxRequests: config.rules.netbankingMaxRequests,
        cutoffs: config.rules.cutoffs,
        payableCodes: config.rules.payableCodes,
        advanceLimitPercent: config.rules.advanceLimitPercent,
      },
      whatsapp: { enabled: config.whatsapp.enabled },
    });
  }),
);

router.put(
  '/settings/branding',
  authenticate,
  allow('settings.manage'),
  h(async (req, res) => {
    const applied = {};
    for (const [key, meta] of Object.entries(KEYS)) {
      if (key === 'logo_attachment_id') continue;   // set through the upload route
      if (req.body[key] === undefined) continue;
      const value = req.body[key] === null || req.body[key] === '' ? null : String(req.body[key]).trim();
      if (value && value.length > meta.max) throw bad(`${meta.label} must be ${meta.max} characters or fewer`);
      set(key, value, req.user.id);
      applied[key] = value;
    }
    if (!Object.keys(applied).length) throw bad('Nothing to update');
    audit(req.user.id, 'settings', 'branding', 'updated', applied);
    res.json(branding());
  }),
);

router.post(
  '/settings/logo',
  authenticate,
  allow('settings.manage'),
  upload.single('file'),
  h(async (req, res) => {
    if (!req.file) throw bad('No logo uploaded');
    if (!/^image\//.test(req.file.mimetype)) throw bad('The logo must be an image');

    const previous = get('logo_attachment_id');
    const id = saveAttachment(req.file, {
      ownerType: 'system', ownerId: 'branding', kind: 'logo', userId: req.user.id,
    });
    set('logo_attachment_id', id, req.user.id);
    if (previous) removeAttachment(previous);

    audit(req.user.id, 'settings', 'branding', 'logo_uploaded', { filename: req.file.originalname });
    res.status(201).json(branding());
  }),
);

router.delete(
  '/settings/logo',
  authenticate,
  allow('settings.manage'),
  h(async (req, res) => {
    const previous = get('logo_attachment_id');
    if (previous) removeAttachment(previous);
    set('logo_attachment_id', null, req.user.id);
    audit(req.user.id, 'settings', 'branding', 'logo_removed');
    res.json(branding());
  }),
);

// ---------------------------------------------------------------- locations
/**
 * The deployment sites. Deployments pick their location from this list, so a
 * site is spelt one way everywhere -- attendance filters, broadcasts and the
 * registers all group by it.
 */
export function checkLocation(value) {
  const name = String(value ?? '').trim();
  if (!name) return null;
  const active = q.all('SELECT name FROM locations WHERE active = 1');
  // Until the list has been set up, any location is accepted.
  if (!active.length) return name;
  const hit = active.find((l) => l.name.toLowerCase() === name.toLowerCase());
  if (!hit) {
    throw bad(`"${name}" is not on the list of locations. Pick one from the list, or ask `
      + 'Admin / Director to add it in Settings.', { code: 'UNKNOWN_LOCATION' });
  }
  return hit.name;
}

router.get(
  '/locations',
  authenticate,
  h(async (req, res) => {
    const all = req.query.all === 'true';
    res.json(q.all(
      `SELECT l.*, (SELECT count(*) FROM employments e
                     WHERE e.location = l.name AND e.status = 'active') AS deployed
         FROM locations l ${all ? '' : 'WHERE l.active = 1'} ORDER BY l.name`,
    ));
  }),
);

router.post(
  '/locations',
  authenticate,
  allow('settings.manage'),
  h(async (req, res) => {
    const name = String(req.body.name || '').trim().replace(/\s+/g, ' ');
    if (name.length < 2 || name.length > 60) throw bad('A location name is 2 to 60 characters');
    const existing = q.get('SELECT * FROM locations WHERE name = ? COLLATE NOCASE', name);
    if (existing?.active) throw bad(`${existing.name} is already on the list`);
    if (existing) {
      q.run('UPDATE locations SET active = 1 WHERE id = ?', existing.id);
    } else {
      q.insert('INSERT INTO locations(name) VALUES (?)', name);
    }
    audit(req.user.id, 'settings', 'locations', 'location_added', { name });
    res.status(201).json(q.get('SELECT * FROM locations WHERE name = ? COLLATE NOCASE', name));
  }),
);

/** Rename, or retire a site. Retired sites stay on old deployments. */
router.patch(
  '/locations/:id',
  authenticate,
  allow('settings.manage'),
  h(async (req, res) => {
    const loc = q.get('SELECT * FROM locations WHERE id = ?', Number(req.params.id));
    if (!loc) throw bad('Location not found');
    if (req.body.active !== undefined) {
      q.run('UPDATE locations SET active = ? WHERE id = ?', req.body.active ? 1 : 0, loc.id);
    }
    if (req.body.name !== undefined) {
      const name = String(req.body.name).trim().replace(/\s+/g, ' ');
      if (name.length < 2 || name.length > 60) throw bad('A location name is 2 to 60 characters');
      const clash = q.get('SELECT id FROM locations WHERE name = ? COLLATE NOCASE AND id <> ?', name, loc.id);
      if (clash) throw bad(`${name} is already on the list`);
      // A rename carries the live deployments with it.
      q.run('UPDATE locations SET name = ? WHERE id = ?', name, loc.id);
      q.run('UPDATE employments SET location = ? WHERE location = ?', name, loc.name);
    }
    audit(req.user.id, 'settings', 'locations', 'location_updated', { id: loc.id, ...req.body });
    res.json(q.get('SELECT * FROM locations WHERE id = ?', loc.id));
  }),
);

export default router;
