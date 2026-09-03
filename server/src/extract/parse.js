import { digits } from '../util.js';

/**
 * Turn the text read off a document into registration fields.
 *
 * Supervisors scan a mixture of things: the client's own registration page,
 * an Aadhaar card, a driving licence, a passbook or a cancelled cheque. Each
 * carries a different subset of the fields the form needs, and each labels
 * them differently, so the parser first works out what it is looking at and
 * then applies the rules for that document.
 *
 * Every field that comes out is tagged with how it was found -- `labelled`
 * (next to its own label, most trustworthy), `pattern` (recognised by shape
 * alone) or `derived` -- so the form can highlight what still needs a human
 * to confirm it. Nothing here ever overwrites something a person typed.
 */

// ------------------------------------------------------------ document type
const DOC_SIGNATURES = [
  ['aadhaar', /(unique identification authority|भारत सरकार|government of india|आधार|aadhaar)/i],
  ['licence', /(driving licen[cs]e|transport department|form\s*7|cov\b|dl\s*no)/i],
  ['bank', /(ifsc|passbook|branch code|account holder|micr)/i],
  ['client_page', /(vendor|register(ed)?\s*(no|date)|function|company|approval status)/i],
];

export function classify(text) {
  const hits = DOC_SIGNATURES.filter(([, re]) => re.test(text)).map(([name]) => name);
  return { type: hits[0] || 'unknown', signals: hits };
}

// ----------------------------------------------------------------- patterns
// Order matters: the first rule that matches a field wins, so the most
// specific labelling comes first.
const RULES = [
  ['name', /(?:^|\n)\s*(?:driver\s*|candidate\s*|employee\s*|applicant\s*)?name\s*(?:of\s*(?:the\s*)?(?:driver|applicant))?\s*[:\-|]\s*([A-Za-z][A-Za-z .'`]{2,60})/i],
  ['father_name', /(?:father|s\/o|son of|d\/o|w\/o)(?:'s)?\s*(?:name)?\s*[:\-|]?\s*([A-Za-z][A-Za-z .'`]{2,50})/i],
  ['phone', /(?:mobile|phone|contact|cell|mob)\s*(?:no\.?|number|#)?\s*[:\-|]?\s*((?:\+?91[\s-]?)?[6-9]\d{9})/i],
  ['aadhar_no', /(?:aadha?ar|aadhar|uid|आधार)\s*(?:card)?\s*(?:no\.?|number|#)?\s*[:\-|]?\s*((?:\d[\s-]?){12})/i],
  ['dob_aadhar', /(?:d\.?o\.?b\.?|date of birth|birth date|जन्म तिथि)\s*[:\-|]?\s*([0-9]{1,4}[\/\-.][0-9]{1,2}[\/\-.][0-9]{2,4})/i],
  ['dob_aadhar', /(?:year of birth|yob)\s*[:\-|]?\s*(\d{4})/i],
  ['dl_no', /(?:driving\s*licen[cs]e|licen[cs]e|dl)\s*(?:no\.?|number|#)?\s*[:\-|]?\s*([A-Z]{2}[\s-]?\d{2}[\s-]?(?:19|20)?\d{2}[\s-]?\d{6,8})/i],
  ['dl_no', /\b([A-Z]{2}[\s-]?\d{2}[\s-]?(?:19|20)\d{2}[\s-]?\d{7})\b/],
  ['dl_valid_till', /(?:valid\s*(?:till|upto|up to|until)|validity|expiry|exp\.? date|nt\s*valid)\s*[:\-|]?\s*([0-9]{1,4}[\/\-.][0-9]{1,2}[\/\-.][0-9]{2,4})/i],
  ['dl_valid_from', /(?:valid\s*from|issue\s*date|date of issue|doi)\s*[:\-|]?\s*([0-9]{1,4}[\/\-.][0-9]{1,2}[\/\-.][0-9]{2,4})/i],
  ['address', /(?:address|add|residence|पता)\s*[:\-|]\s*([\s\S]{8,200}?)(?=\n\s*\n|\n\s*(?:bank|aadha|a\/c|dl|driving|uan|phone|mobile|date|pin|ifsc|reference)\b|$)/i],
  ['pincode', /(?:pin\s*(?:code)?|postal code)\s*[:\-|]?\s*(\d{6})\b/i],
  ['bank_account_no', /(?:a\/c|account|acct|savings a\/c)\s*(?:no\.?|number|#)?\s*[:\-|]?\s*(\d{9,18})/i],
  ['bank_ifsc', /ifsc\s*(?:code)?\s*[:\-|]?\s*([A-Z]{4}0[A-Z0-9]{6})/i],
  ['bank_name', /(?:bank\s*name|name of bank)\s*[:\-|]\s*([A-Za-z .&]{3,60})/i],
  ['bank_name', /\b((?:state bank of india|hdfc|icici|axis|punjab national|bank of baroda|canara|union bank|kotak|yes bank|indusind|idbi|central bank|indian bank|uco|bandhan|au small finance)[a-z ]*(?:bank)?)\b/i],
  ['uan_no', /uan\s*(?:no\.?|number|#)?\s*[:\-|]?\s*(\d{12})/i],
  ['esic_no', /(?:esic?|esi)\s*(?:no\.?|number|ip)?\s*[:\-|]?\s*(\d{10,17})/i],
  ['client_id', /(?:client|employee|emp|staff|token)\s*(?:id|code|no\.?)\s*[:\-|]?\s*(\d{6})\b/i],
  ['registered_no', /(?:register(?:ed|ation)?)\s*(?:no\.?|number|id)?\s*[:\-|]?\s*(\d{8,20})/i],
  ['vehicle_number', /(?:vehicle|cab|car|bus|truck)\s*(?:no\.?|number|reg)?\s*[:\-|]?\s*([A-Z]{2}[\s-]?\d{1,2}[\s-]?[A-Z]{1,3}[\s-]?\d{4})/i],
  ['location', /(?:location|site|base|posting|place of work|unit)\s*[:\-|]\s*([A-Za-z][A-Za-z0-9 ,.\-]{1,50})/i],
  ['company', /(?:company|contractor|vendor|firm)\s*(?:name)?\s*[:\-|]\s*([A-Za-z][A-Za-z0-9 .&\-]{2,60})/i],
  ['function', /(?:function|designation|role|post|category)\s*[:\-|]\s*([A-Za-z][A-Za-z0-9 .,\-–—]{2,60})/i],
  ['referred_by', /(?:referred?\s*by|reference\s*of|recommended by|sourced by)\s*[:\-|]?\s*([A-Za-z][A-Za-z .'`]{2,50})/i],
];

// Shape-only fallbacks, used when the label was lost to OCR noise.
const FALLBACKS = [
  ['aadhar_no', /\b(\d{4}\s\d{4}\s\d{4})\b/, digits],
  ['phone', /\b([6-9]\d{9})\b/, (v) => v],
  ['bank_ifsc', /\b([A-Z]{4}0[A-Z0-9]{6})\b/, (v) => v.toUpperCase()],
  ['pincode', /\b([1-9]\d{5})\b/, (v) => v],
  ['vehicle_number', /\b([A-Z]{2}\s?\d{1,2}\s?[A-Z]{1,3}\s?\d{4})\b/, (v) => v.toUpperCase().replace(/\s/g, '')],
];

const REF_RE =
  /(father|mother|brother|sister|spouse|wife|husband|son|daughter|uncle|friend|relative|reference|emergency)\s*(?:name)?\s*[:\-|]?\s*([A-Za-z][A-Za-z .'`]{2,40}?)[\s\-,|]+((?:\+?91[\s-]?)?[6-9]\d{9})/gi;

/**
 * @param {string} text        text read off the document
 * @param {object} [opts]
 * @param {string} [opts.engine]  which OCR engine produced it, for the report
 * @returns {{fields: object, confidence: object, matched: number, docType: string}}
 */
export function parseRegistrationText(text, opts = {}) {
  const src = normalise(text);
  const fields = {};
  const confidence = {};
  const { type, signals } = classify(src);

  for (const [key, re] of RULES) {
    if (fields[key] !== undefined) continue;
    const m = src.match(re);
    if (m && m[1]) {
      const v = clean(key, m[1]);
      if (v !== '' && v !== null) {
        fields[key] = v;
        confidence[key] = 'labelled';
      }
    }
  }

  for (const [key, re, fn] of FALLBACKS) {
    if (fields[key] !== undefined) continue;
    const m = src.match(re);
    if (m && m[1]) {
      fields[key] = fn(m[1]);
      confidence[key] = 'pattern';
    }
  }

  // A licence carries its own date of birth, which must agree with Aadhaar.
  if (type === 'licence' && fields.dob_aadhar && fields.dl_dob === undefined) {
    fields.dl_dob = fields.dob_aadhar;
    confidence.dl_dob = 'derived';
    delete fields.dob_aadhar;
    delete confidence.dob_aadhar;
  }

  // Reference contacts: "Father: Ram Singh - 9876543210"
  const references = [];
  const seen = new Set();
  let rm;
  REF_RE.lastIndex = 0;
  while ((rm = REF_RE.exec(src)) !== null && references.length < 2) {
    const phone = digits(rm[3]).slice(-10);
    if (seen.has(phone)) continue;
    seen.add(phone);
    references.push({ relation: title(rm[1]), name: rm[2].trim(), phone });
  }
  if (references.length) {
    fields.references = references;
    confidence.references = 'labelled';
  }

  // The driver's own number should not be offered as a reference contact.
  if (fields.references && fields.phone) {
    fields.references = fields.references.filter((r) => r.phone !== fields.phone);
    if (!fields.references.length) delete fields.references;
  }

  // Address ends up as the join of the address lines and the pincode.
  if (fields.address && fields.pincode && !fields.address.includes(fields.pincode)) {
    fields.address = `${fields.address} - ${fields.pincode}`;
  }
  delete fields.pincode;
  delete confidence.pincode;

  // A client page is a list of drivers. Offer the rows for the supervisor to
  // pick from, and when there is only one, treat it as the driver being
  // registered and fill the name in.
  let rows = [];
  if (type === 'client_page') {
    rows = parseClientPageRows(src);
    if (rows.length === 1 && !rows[0].nameTruncated && fields.name === undefined) {
      fields.name = rows[0].name;
      confidence.name = 'pattern';
    }
    if (rows.length && fields.registered_no === undefined && !rows[0].registeredNoTruncated) {
      fields.registered_no = rows[0].registered_no;
      confidence.registered_no = 'pattern';
    }
  }

  return {
    fields,
    confidence,
    rows,
    matched: Object.keys(fields).length,
    docType: type,
    signals,
    engine: opts.engine || 'text',
  };
}

// ------------------------------------------------------- client page (table)
/**
 * The client's own registration page is a table, not a labelled form: one row
 * per driver, with the columns truncated by the portal's own layout. There is
 * nothing to match a `Name:` label against, so the rows are read positionally
 * instead -- registration number, then the driver's name, then the approval
 * status the portal is showing.
 *
 * What comes back is a list for the supervisor to pick from, because one page
 * routinely carries twenty drivers and only one of them is being registered.
 */

// Words the portal puts in the approval column; they end the name. OCR clips
// them as often as not ("Tech" comes back as "Tec"), so a word counts as a
// status word when it is a prefix of one, or one is a prefix of it.
const STATUS_WORDS = [
  'app', 'approved', 'approval', 'pending', 'rejected', 'tech', 'technical',
  'safe', 'safety', 'hr', 'ir', 'dp', 'pp', 'doc', 'documents', 'medical',
  'trial', 'verified', 'processing', 'review', 'complete', 'completed', 'under',
];

function isStatusWord(word) {
  // Only short tokens are considered, so a real name is not mistaken for one.
  if (word.length > 5) return false;
  const w = word.toLowerCase();
  return STATUS_WORDS.some((s) => s.startsWith(w) || w.startsWith(s));
}

const ROW_RE = /(\d{8,})(\.{2,3}|…)?\s+(.{2,60}?)\s*$/;

export function parseClientPageRows(text) {
  const rows = [];

  for (const raw of normalise(text).split('\n')) {
    const line = raw.trim();
    if (!line || /register/i.test(line) && /name/i.test(line)) continue;  // header row

    const m = line.match(ROW_RE);
    if (!m) continue;

    const registeredNo = m[1];
    const truncatedNo = Boolean(m[2]);
    const { name, truncated } = takeName(m[3]);
    if (!name) continue;

    // Whatever sat before the registration number is the company / function.
    const before = line.slice(0, line.indexOf(registeredNo)).trim();

    rows.push({
      name,
      nameTruncated: truncated,
      registered_no: registeredNo,
      registeredNoTruncated: truncatedNo,
      context: before.replace(/^[^A-Za-z]+/, '').replace(/\s{2,}/g, ' ') || null,
    });
  }

  return rows;
}

/** Read the driver's name off the tail of a row, stopping at the status column. */
function takeName(tail) {
  const words = tail
    .replace(/[|]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

  const picked = [];
  let truncated = false;

  for (const w of words) {
    const bare = w.replace(/(\.{2,3}|…)$/, '');
    const wasCut = bare !== w;

    // Names are alphabetic; two letters is the shortest real one (e.g. "Ali").
    if (!/^[A-Za-z][A-Za-z.'`-]*$/.test(bare) || bare.length < 2) break;
    if (picked.length && isStatusWord(bare)) break;

    picked.push(bare);
    if (wasCut) {
      truncated = true;
      break;
    }
    if (picked.length === 4) break;
  }

  // A single status word on its own is not a name.
  if (picked.length === 1 && isStatusWord(picked[0])) return { name: '', truncated: false };

  // The status column is set in a different case to the name column, so a short
  // trailing word that breaks the casing of the name is the status bleeding in
  // ("SONU Frech", where OCR made "Tech" out of the approval column).
  if (picked.length > 1 && !truncated) {
    const last = picked[picked.length - 1];
    const rest = picked.slice(0, -1);
    const restAllCaps = rest.every((w) => w === w.toUpperCase());
    if (restAllCaps && last.length <= 5 && last !== last.toUpperCase()) picked.pop();
  }

  return { name: picked.join(' ').replace(/\s+/g, ' ').trim(), truncated };
}

/** Merge several documents into one draft; a labelled hit beats a guessed one. */
export function mergeExtractions(results) {
  const RANK = { labelled: 3, derived: 2, pattern: 1 };
  const fields = {};
  const confidence = {};
  const sources = {};

  results.forEach((r, i) => {
    Object.entries(r.fields || {}).forEach(([k, v]) => {
      const rank = RANK[r.confidence?.[k]] || 0;
      const held = RANK[confidence[k]] || -1;
      if (rank > held) {
        fields[k] = v;
        confidence[k] = r.confidence?.[k] || 'pattern';
        sources[k] = r.source || `document ${i + 1}`;
      }
    });
  });

  return { fields, confidence, sources, matched: Object.keys(fields).length };
}

// --------------------------------------------------------------- normalising
function normalise(text) {
  return String(text || '')
    .replace(/\r/g, '')
    // OCR routinely renders these as separators; treat them as labels.
    .replace(/[|｜]/g, '|')
    .replace(/[ \t]{2,}/g, '  ')
    .replace(/ /g, ' ');
}

function clean(key, raw) {
  let v = String(raw).trim().replace(/\s{2,}/g, ' ');

  if (key === 'aadhar_no') {
    const d = digits(v);
    return d.length === 12 ? d : '';
  }
  if (key === 'uan_no') {
    const d = digits(v);
    return d.length === 12 ? d : '';
  }
  if (key === 'bank_account_no' || key === 'esic_no' || key === 'registered_no') return digits(v);
  if (key === 'phone') {
    const d = digits(v).slice(-10);
    return /^[6-9]\d{9}$/.test(d) ? d : '';
  }
  if (key === 'dob_aadhar' || key === 'dl_valid_till' || key === 'dl_valid_from') return toIsoDate(v);
  if (key === 'dl_no' || key === 'bank_ifsc' || key === 'vehicle_number') {
    return v.toUpperCase().replace(/[\s-]/g, '');
  }
  if (key === 'client_id') return digits(v).slice(0, 6);
  if (key === 'address') {
    return v.replace(/\n+/g, ', ').replace(/\s*,\s*,+/g, ',').replace(/[,\s]+$/, '').trim();
  }
  if (key === 'name' || key === 'father_name' || key === 'referred_by' || key === 'bank_name') {
    return v.replace(/[.,;|]+$/, '').replace(/\s+/g, ' ').trim();
  }
  return v.replace(/[.,;|]+$/, '').trim();
}

/** Accepts dd/mm/yyyy, dd-mm-yy, yyyy-mm-dd and a bare year of birth. */
export function toIsoDate(v) {
  const s = String(v).trim();
  if (/^\d{4}$/.test(s)) return `${s}-01-01`;

  let m = s.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;

  m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (m) {
    let year = m[3];
    if (year.length === 2) year = Number(year) > 40 ? `19${year}` : `20${year}`;
    const day = Number(m[1]);
    const month = Number(m[2]);
    // dd/mm is the Indian convention, but a value over 12 in the first slot
    // can only be the day, and over 12 in the second can only be a month.
    if (day > 12 && month > 12) return s;
    return `${year}-${pad(month)}-${pad(day)}`;
  }
  return s;
}

const pad = (n) => String(n).padStart(2, '0');
const title = (s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
