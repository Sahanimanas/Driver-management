import fs from 'node:fs';
import { config } from './config.js';
import { digits } from './util.js';

/**
 * "Scan the client registration page to populate the fields of registration."
 *
 * Two stages:
 *  1. Get text out of the scanned page. If OCR_API_URL is configured the image
 *     is posted to it; otherwise the caller supplies text (typed, pasted, or
 *     produced by a client-side OCR) and we go straight to parsing.
 *  2. Parse labelled fields out of that text into a registration draft.
 */
export async function ocrImage(filePath, mime) {
  if (!config.ocr.url) {
    return { text: '', engine: 'none' };
  }
  const buf = fs.readFileSync(filePath);
  const form = new FormData();
  form.append('file', new Blob([buf], { type: mime || 'application/octet-stream' }), 'scan');
  const res = await fetch(config.ocr.url, {
    method: 'POST',
    headers: config.ocr.key ? { Authorization: `Bearer ${config.ocr.key}` } : {},
    body: form,
  });
  if (!res.ok) throw new Error(`OCR service returned HTTP ${res.status}`);
  const data = await res.json().catch(() => ({}));
  return { text: data.text || data.ParsedText || '', engine: 'remote' };
}

const LABELS = [
  ['name', /(?:^|\n)\s*(?:driver\s*)?name\s*[:\-]\s*(.+)/i],
  ['phone', /(?:mobile|phone|contact)\s*(?:no\.?|number)?\s*[:\-]\s*([\d\s\-+()]{10,20})/i],
  ['aadhar_no', /(?:aadha?ar|uid)\s*(?:card)?\s*(?:no\.?|number)?\s*[:\-]?\s*((?:\d[\s-]?){12})/i],
  ['dob_aadhar', /(?:d\.?o\.?b\.?|date of birth)\s*[:\-]\s*([0-9]{1,4}[\/\-.][0-9]{1,2}[\/\-.][0-9]{2,4})/i],
  ['dl_no', /(?:driving\s*licen[cs]e|dl)\s*(?:no\.?|number)?\s*[:\-]\s*([A-Z]{2}[\s-]?\d{2}[\s-]?\d{4,11})/i],
  ['dl_valid_till', /(?:valid\s*(?:till|upto|up to)|dl\s*validity|expiry)\s*[:\-]\s*([0-9]{1,4}[\/\-.][0-9]{1,2}[\/\-.][0-9]{2,4})/i],
  ['address', /address\s*[:\-]\s*([\s\S]{5,180}?)(?:\n\s*\n|\n\s*(?:bank|aadha|dl|driving|uan|phone|mobile|date)\b)/i],
  ['bank_account_no', /(?:a\/c|account)\s*(?:no\.?|number)?\s*[:\-]\s*(\d{6,20})/i],
  ['bank_ifsc', /ifsc\s*(?:code)?\s*[:\-]?\s*([A-Z]{4}0[A-Z0-9]{6})/i],
  ['bank_name', /bank\s*(?:name)?\s*[:\-]\s*([A-Za-z .&]{3,60})/i],
  ['uan_no', /uan\s*(?:no\.?|number)?\s*[:\-]?\s*(\d{12})/i],
  ['client_id', /(?:client|employee|emp)\s*id\s*[:\-]?\s*(\d{6})/i],
  ['vehicle_number', /(?:vehicle|cab|car)\s*(?:no\.?|number)?\s*[:\-]?\s*([A-Z]{2}[\s-]?\d{1,2}[\s-]?[A-Z]{1,3}[\s-]?\d{4})/i],
  ['location', /(?:location|site|base|posting)\s*[:\-]\s*(.{2,60})/i],
];

/** Parse registration fields out of free text scanned off the client page. */
export function parseRegistrationText(text) {
  const src = String(text || '').replace(/\r/g, '');
  const fields = {};
  const confidence = {};

  for (const [key, re] of LABELS) {
    const m = src.match(re);
    if (m && m[1]) {
      fields[key] = clean(key, m[1]);
      confidence[key] = 'labelled';
    }
  }

  // Fallbacks when the label is missing but the shape is unambiguous.
  if (!fields.aadhar_no) {
    const m = src.match(/\b(\d{4}\s?\d{4}\s?\d{4})\b/);
    if (m) {
      fields.aadhar_no = digits(m[1]);
      confidence.aadhar_no = 'pattern';
    }
  }
  if (!fields.phone) {
    const m = src.match(/\b([6-9]\d{9})\b/);
    if (m) {
      fields.phone = m[1];
      confidence.phone = 'pattern';
    }
  }
  if (!fields.bank_ifsc) {
    const m = src.match(/\b([A-Z]{4}0[A-Z0-9]{6})\b/);
    if (m) {
      fields.bank_ifsc = m[1];
      confidence.bank_ifsc = 'pattern';
    }
  }

  // Reference contacts: "Father: Ram - 9876543210"
  const refs = [];
  const refRe = /(father|mother|brother|sister|spouse|wife|husband|son|uncle|relative|reference)\s*(?:name)?\s*[:\-]?\s*([A-Za-z .]{3,40})[\s\-,|]+([6-9]\d{9})/gi;
  let rm;
  while ((rm = refRe.exec(src)) !== null && refs.length < 2) {
    refs.push({ relation: title(rm[1]), name: rm[2].trim(), phone: rm[3] });
  }
  if (refs.length) fields.references = refs;

  return {
    fields,
    confidence,
    matched: Object.keys(fields).length,
  };
}

function clean(key, raw) {
  let v = String(raw).trim().replace(/\s{2,}/g, ' ');
  if (key === 'aadhar_no' || key === 'uan_no' || key === 'bank_account_no') return digits(v);
  if (key === 'phone') return digits(v).slice(-10);
  if (key === 'dob_aadhar' || key === 'dl_valid_till') return toIsoDate(v);
  if (key === 'dl_no' || key === 'bank_ifsc' || key === 'vehicle_number') {
    return v.toUpperCase().replace(/[\s-]/g, '');
  }
  if (key === 'address') return v.replace(/\n+/g, ', ').replace(/,\s*,/g, ',').trim();
  return v.replace(/[.,;]$/, '').trim();
}

/** Accepts dd/mm/yyyy, dd-mm-yy, yyyy-mm-dd. */
export function toIsoDate(v) {
  const s = String(v).trim();
  let m = s.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (m) {
    let year = m[3];
    if (year.length === 2) year = Number(year) > 40 ? `19${year}` : `20${year}`;
    return `${year}-${pad(m[2])}-${pad(m[1])}`;
  }
  return s;
}

const pad = (n) => String(n).padStart(2, '0');
const title = (s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
