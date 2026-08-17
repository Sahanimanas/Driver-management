import { Router } from 'express';
import { q, tx, audit } from '../db.js';
import { authenticate, allow } from '../auth.js';
import { config } from '../config.js';
import { sendWhatsApp, renderTemplate } from '../whatsapp.js';
import { h, need, bad, notFound, e164, validPhone } from '../util.js';

const router = Router();
router.use(authenticate);

/**
 * Resolve an audience filter to a recipient list.
 * { status, location, insuranceMissing, deployedOnly, driverIds }
 */
function resolveAudience(filter = {}) {
  const where = [];
  const params = [];

  if (Array.isArray(filter.driverIds) && filter.driverIds.length) {
    where.push(`d.id IN (${filter.driverIds.map(() => '?').join(',')})`);
    params.push(...filter.driverIds.map(Number));
  }
  if (filter.status) {
    where.push('d.status = ?');
    params.push(filter.status);
  }
  if (filter.deployedOnly) where.push('e.id IS NOT NULL');
  if (filter.location) {
    where.push('e.location = ?');
    params.push(filter.location);
  }
  if (filter.insuranceMissing) {
    where.push(
      `NOT EXISTS (SELECT 1 FROM insurance i WHERE i.driver_id = d.id AND i.type = ? AND i.covered = 1)`,
    );
    params.push(String(filter.insuranceMissing).toUpperCase());
  }

  return q.all(
    `SELECT d.id, d.name, d.phone, d.registration_no, e.client_id, e.location, e.vehicle_number
     FROM drivers d LEFT JOIN employments e ON e.driver_id = d.id AND e.status = 'active'
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY d.name`,
    ...params,
  );
}

router.get('/status', (_req, res) => {
  res.json({
    provider: config.whatsapp.enabled ? 'whatsapp_cloud_api' : 'simulation',
    simulated: !config.whatsapp.enabled,
    note: config.whatsapp.enabled
      ? 'Messages are delivered through the WhatsApp Cloud API.'
      : 'Running in simulation mode — set WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID to send for real.',
  });
});

/** Preview who a filter would reach, before anything is sent. */
router.post(
  '/audience/preview',
  h(async (req, res) => {
    const recipients = resolveAudience(req.body.audience || {});
    const reachable = recipients.filter((r) => validPhone(r.phone));
    res.json({
      total: recipients.length,
      reachable: reachable.length,
      unreachable: recipients.filter((r) => !validPhone(r.phone)).map((r) => ({
        id: r.id, name: r.name, phone: r.phone,
      })),
      sample: reachable.slice(0, 10),
    });
  }),
);

router.get(
  '/campaigns',
  h(async (_req, res) => {
    res.json(
      q.all(
        `SELECT c.*, u.name AS created_by_name FROM campaigns c
         LEFT JOIN users u ON u.id = c.created_by ORDER BY c.created_at DESC LIMIT 100`,
      ),
    );
  }),
);

router.get(
  '/campaigns/:id',
  h(async (req, res) => {
    const c = q.get('SELECT * FROM campaigns WHERE id = ?', Number(req.params.id));
    if (!c) throw notFound('Campaign not found');
    res.json({
      campaign: c,
      recipients: q.all(
        `SELECT r.*, d.name FROM campaign_recipients r LEFT JOIN drivers d ON d.id = r.driver_id
         WHERE r.campaign_id = ? ORDER BY r.id`,
        c.id,
      ),
    });
  }),
);

/**
 * Create and send a mass WhatsApp message.
 * The body supports {{name}}, {{client_id}}, {{vehicle}}, {{location}} placeholders.
 */
router.post(
  '/campaigns',
  allow('supervisor', 'senior_manager', 'director'),
  h(async (req, res) => {
    need(req.body, ['title', 'body']);
    const audience = req.body.audience || {};
    const recipients = resolveAudience(audience).filter((r) => validPhone(r.phone));
    if (!recipients.length) throw bad('That audience has no drivers with a valid mobile number');
    if (recipients.length > 5000) throw bad('Audience is too large for a single campaign (max 5000)');

    const campaignId = tx(() => {
      const id = q.insert(
        `INSERT INTO campaigns(title, body, audience, status, total, created_by)
         VALUES (?,?,?,'draft',?,?)`,
        String(req.body.title).trim(), String(req.body.body), JSON.stringify(audience),
        recipients.length, req.user.id,
      );
      recipients.forEach((r) =>
        q.run(
          'INSERT INTO campaign_recipients(campaign_id, driver_id, phone) VALUES (?,?,?)',
          id, r.id, e164(r.phone),
        ),
      );
      audit(req.user.id, 'campaign', id, 'created', { total: recipients.length });
      return id;
    });

    if (req.body.send_now === false) {
      return res.status(201).json({ campaign: q.get('SELECT * FROM campaigns WHERE id = ?', campaignId) });
    }
    const result = await dispatch(campaignId, req.user.id);
    return res.status(201).json(result);
  }),
);

router.post(
  '/campaigns/:id/send',
  allow('supervisor', 'senior_manager', 'director'),
  h(async (req, res) => {
    const c = q.get('SELECT * FROM campaigns WHERE id = ?', Number(req.params.id));
    if (!c) throw notFound('Campaign not found');
    if (c.status === 'sent') throw bad('This campaign has already been sent');
    res.json(await dispatch(c.id, req.user.id));
  }),
);

/** Send every queued recipient, in small concurrent batches. */
async function dispatch(campaignId, userId) {
  const campaign = q.get('SELECT * FROM campaigns WHERE id = ?', campaignId);
  q.run("UPDATE campaigns SET status = 'sending' WHERE id = ?", campaignId);

  const pending = q.all(
    `SELECT r.*, d.name, d.registration_no, e.client_id, e.vehicle_number, e.location
     FROM campaign_recipients r
     LEFT JOIN drivers d ON d.id = r.driver_id
     LEFT JOIN employments e ON e.driver_id = d.id AND e.status = 'active'
     WHERE r.campaign_id = ? AND r.status = 'queued'`,
    campaignId,
  );

  let sent = 0;
  let failed = 0;
  const BATCH = 10;
  for (let i = 0; i < pending.length; i += BATCH) {
    const slice = pending.slice(i, i + BATCH);
    // eslint-disable-next-line no-await-in-loop
    const results = await Promise.all(
      slice.map((r) =>
        sendWhatsApp(
          r.phone,
          renderTemplate(campaign.body, {
            name: r.name || '',
            client_id: r.client_id || '',
            registration_no: r.registration_no || '',
            vehicle: r.vehicle_number || '',
            location: r.location || '',
          }),
        ).then((out) => ({ r, out })),
      ),
    );
    results.forEach(({ r, out }) => {
      if (out.ok) {
        sent += 1;
        q.run(
          "UPDATE campaign_recipients SET status = 'sent', provider_id = ?, sent_at = datetime('now') WHERE id = ?",
          out.id, r.id,
        );
      } else {
        failed += 1;
        q.run("UPDATE campaign_recipients SET status = 'failed', error = ? WHERE id = ?", out.error, r.id);
      }
    });
  }

  q.run(
    `UPDATE campaigns SET status = 'sent', sent_count = sent_count + ?, failed_count = failed_count + ?,
                          sent_at = datetime('now') WHERE id = ?`,
    sent, failed, campaignId,
  );
  audit(userId, 'campaign', campaignId, 'sent', { sent, failed });

  return {
    campaign: q.get('SELECT * FROM campaigns WHERE id = ?', campaignId),
    sent,
    failed,
    simulated: !config.whatsapp.enabled,
  };
}

export default router;
