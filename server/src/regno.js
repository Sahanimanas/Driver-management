import { q, nextCounter } from './db.js';
import { bad } from './util.js';

/**
 * The registration number allotted to a new driver, e.g. QDM/2026/00042.
 *
 * Admin / Director sets the format in Settings: a prefix, the separator, the
 * year (four digits, two, or none) and how many digits the running number is
 * padded to. With a year in the number the count restarts every year; without
 * one it runs on. A change applies to registrations from then on -- numbers
 * already allotted are never rewritten, since they are on paper elsewhere.
 */
export const REGNO_DEFAULT = { prefix: 'QDM', separator: '/', year: 'YYYY', digits: 5 };

const SEPARATORS = ['/', '-', ''];
const YEARS = ['YYYY', 'YY', 'none'];

export function regNoFormat() {
  const raw = q.get("SELECT value FROM app_settings WHERE key = 'reg_no_format'")?.value;
  try {
    return { ...REGNO_DEFAULT, ...(raw ? JSON.parse(raw) : {}) };
  } catch {
    return { ...REGNO_DEFAULT };
  }
}

export function formatRegNo(fmt, year, n) {
  const yearPart = fmt.year === 'YYYY' ? String(year) : fmt.year === 'YY' ? String(year).slice(-2) : '';
  return [fmt.prefix, yearPart, String(n).padStart(Number(fmt.digits) || 1, '0')]
    .filter(Boolean)
    .join(fmt.separator);
}

/** Check a format sent from Settings, and return it normalised. */
export function validateRegNoFormat(input = {}) {
  const fmt = {
    prefix: String(input.prefix ?? '').trim().toUpperCase(),
    separator: String(input.separator ?? ''),
    year: String(input.year ?? 'YYYY'),
    digits: Number(input.digits),
  };
  if (!/^[A-Z0-9-]{0,10}$/.test(fmt.prefix)) {
    throw bad('The prefix is up to 10 letters, digits or hyphens, e.g. QDM');
  }
  if (!SEPARATORS.includes(fmt.separator)) throw bad('The separator must be "/", "-" or none');
  if (!YEARS.includes(fmt.year)) throw bad('The year must be YYYY, YY or none');
  if (!Number.isInteger(fmt.digits) || fmt.digits < 3 || fmt.digits > 8) {
    throw bad('The running number is padded to between 3 and 8 digits');
  }
  if (!fmt.prefix && fmt.year === 'none') {
    throw bad('Keep a prefix or the year, or registration numbers become bare counts');
  }
  return fmt;
}

/** Allot the next number. Skips any that is already taken, e.g. after a format change. */
export function allocateRegistrationNo() {
  const fmt = regNoFormat();
  const year = new Date().getFullYear();
  const counter = fmt.year === 'none' ? 'registration:all' : `registration:${year}`;
  for (let tries = 0; tries < 100000; tries += 1) {
    const no = formatRegNo(fmt, year, nextCounter(counter));
    if (!q.get('SELECT 1 FROM drivers WHERE registration_no = ?', no)) return no;
  }
  throw bad('Could not allot a free registration number — check the format in Settings');
}
