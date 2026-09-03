export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export const bad = (msg, details) => new HttpError(400, msg, details);
export const notFound = (msg = 'Not found') => new HttpError(404, msg);
export const forbidden = (msg = 'Not permitted') => new HttpError(403, msg);

/** Wrap an async route handler so rejections reach the error middleware. */
export const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ------------------------------------------------------------------ dates
export const today = () => new Date().toISOString().slice(0, 10);
export const nowIso = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

export function isDate(v) {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
}

export function isPeriod(v) {
  return typeof v === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(v);
}

export function daysInPeriod(period) {
  const [y, m] = period.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** All YYYY-MM-DD dates of a period, in order. */
export function periodDays(period) {
  const n = daysInPeriod(period);
  return Array.from({ length: n }, (_, i) => `${period}-${String(i + 1).padStart(2, '0')}`);
}

export function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function diffDays(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
}

/** "3 yr 2 mo" style service length from a whole number of days. */
export function humanDuration(totalDays) {
  if (!totalDays || totalDays < 0) return '0 d';
  const years = Math.floor(totalDays / 365);
  const months = Math.floor((totalDays % 365) / 30);
  const days = Math.floor((totalDays % 365) % 30);
  return [years && `${years} yr`, months && `${months} mo`, days && `${days} d`]
    .filter(Boolean)
    .join(' ') || '0 d';
}

/** Which accumulation window a request falls into (noon / 18:30 cut-offs). */
export function cutoffFor(date = new Date()) {
  const mins = date.getHours() * 60 + date.getMinutes();
  return mins < 12 * 60 ? 'NOON' : 'EVENING';
}

// ------------------------------------------------------------ validation
export function need(body, fields) {
  const missing = fields.filter((f) => {
    const v = body?.[f];
    return v === undefined || v === null || String(v).trim() === '';
  });
  if (missing.length) throw bad(`Missing required field(s): ${missing.join(', ')}`, { missing });
}

export function oneOf(value, allowed, label) {
  if (!allowed.includes(value)) throw bad(`${label} must be one of: ${allowed.join(', ')}`);
  return value;
}

export const digits = (v) => String(v ?? '').replace(/\D/g, '');

/**
 * Twelve digits, and never starting 0 or 1 — the issuing authority does not
 * allot those. Twelve of the same digit is a placeholder somebody typed to get
 * past the form, so it is refused too.
 *
 * The registration form applies the same rules as you type; these are the
 * enforcement, since the form can be bypassed.
 */
export function validAadhar(v) {
  const d = digits(v);
  if (d.length !== 12) return false;
  if (/^[01]/.test(d)) return false;
  if (/^(\d)\1{11}$/.test(d)) return false;
  return true;
}

/** An Indian mobile number: ten digits starting 6-9, with or without 91. */
export function validPhone(v) {
  let d = digits(v);
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return d.length === 10 && /^[6-9]/.test(d);
}

/** Normalise an Indian mobile number to E.164 for WhatsApp. */
export function e164(v) {
  const d = digits(v);
  if (d.length === 10) return `91${d}`;
  if (d.length === 12 && d.startsWith('91')) return d;
  if (d.length === 11 && d.startsWith('0')) return `91${d.slice(1)}`;
  return d;
}

export const money = (n) => Math.round((Number(n) || 0) * 100) / 100;

export function num(v, label, { min = -Infinity, max = Infinity } = {}) {
  const n = Number(v);
  if (!Number.isFinite(n)) throw bad(`${label} must be a number`);
  if (n < min || n > max) throw bad(`${label} must be between ${min} and ${max}`);
  return n;
}

export const bool = (v) => (v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0);

/** Escape for the Tally XML export. */
export function xmlEscape(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
