import { config } from './config.js';

/**
 * Send one WhatsApp text message.
 * Uses the Meta WhatsApp Cloud API when WHATSAPP_TOKEN + WHATSAPP_PHONE_NUMBER_ID
 * are configured. Without them it runs in simulation mode: messages are marked
 * sent with a simulated id so the whole campaign flow stays testable.
 */
export async function sendWhatsApp(to, body) {
  if (!config.whatsapp.enabled) {
    return { ok: true, id: `sim-${to}-${Math.floor(Math.random() * 1e9)}`, simulated: true };
  }

  const url = `https://graph.facebook.com/${config.whatsapp.apiVersion}/${config.whatsapp.phoneNumberId}/messages`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.whatsapp.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'text',
        text: { preview_url: false, body },
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, error: data?.error?.message || `HTTP ${res.status}` };
    }
    return { ok: true, id: data?.messages?.[0]?.id || null, simulated: false };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Replace {{name}} / {{client_id}} style placeholders. */
export function renderTemplate(body, vars) {
  return String(body).replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) =>
    vars[key] === undefined || vars[key] === null ? '' : String(vars[key]),
  );
}
