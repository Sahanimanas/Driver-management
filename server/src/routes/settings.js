import { Router } from 'express';
import { q, audit } from '../db.js';
import { config } from '../config.js';
import { authenticate, allow, ROLES, ROLE_LABEL, ROLE_DESCRIPTION } from '../auth.js';
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
      roles: ROLES.map((r) => ({ key: r, label: ROLE_LABEL[r], description: ROLE_DESCRIPTION[r] })),
      rules: {
        expenseDirectorThreshold: config.rules.expenseDirectorThreshold,
        netbankingMaxRequests: config.rules.netbankingMaxRequests,
        cutoffs: config.rules.cutoffs,
        payableCodes: config.rules.payableCodes,
      },
      whatsapp: { enabled: config.whatsapp.enabled },
    });
  }),
);

router.put(
  '/settings/branding',
  authenticate,
  allow('admin'),
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
  allow('admin'),
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
  allow('admin'),
  h(async (req, res) => {
    const previous = get('logo_attachment_id');
    if (previous) removeAttachment(previous);
    set('logo_attachment_id', null, req.user.id);
    audit(req.user.id, 'settings', 'branding', 'logo_removed');
    res.json(branding());
  }),
);

export default router;
