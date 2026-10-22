import { groupLines, height, midY } from './layout.js';
import { toIsoDate } from './parse.js';

/**
 * The client portal's "Employee Registration Details" page -- one driver per
 * page, laid out as label : value pairs in two and three columns:
 *
 *   Register No. : 202610051004237
 *   Name         : SHYAM SINGH
 *   DOB          : 14/08/1981        Location : Chanderiya
 *   Mobile No.   : 7891217723        Phone No. :
 *   ...
 *   Aadhar No.   : 728242389879      PAN No. :    DL No. : RJ0520020087005
 *   DL Issue Auth: RJ05   DL From Date : 13/12/2006   DL To Date : 15/12/2026
 *
 * It reaches us in two layouts. Printed from the portal it is a wide page with
 * every label on one line. Printed from the popup over the driver list it is
 * narrower, so labels wrap onto two lines ("Mobile / No.", "DL To / Date") and
 * the value sits between them; that version has no text layer at all and is
 * read by Tesseract.
 *
 * So nothing here trusts line breaks. Each field is found by its label, and its
 * value is the nearest thing to the right of that label, at the label's height,
 * that has the right shape -- stopping at the next label so one column never
 * bleeds into the next.
 */

// Words that begin a label on this page. A value never runs past one.
const LABEL_START = /^(register|name|sex|marital|dob|location|mobile|phone|email|blood|education|uan|esic|pf|ref|address|city|state|police|company|work|supervisor|doj|designation|function|job|bank|acc|branch|ifsc|micr|aadh\w*|pan|dl)$/i;

// The second half of a label ("Mobile No.", "DL To Date") -- not a value.
const LABEL_TAIL = /^(no|st|date|code|order|hrs|auth|group|name|issue|from|to)$/i;

const bare = (t) => String(t).replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');
const isLabel = (w) => LABEL_START.test(bare(w.text));

/** Undo the usual OCR confusions, but only in a token that is mostly digits. */
function fixDigits(t) {
  const alnum = t.replace(/[^A-Za-z0-9]/g, '');
  const d = alnum.replace(/\D/g, '').length;
  if (!alnum.length || d / alnum.length < 0.5) return t;
  return t.replace(/[Oo]/g, '0').replace(/[Il|]/g, '1').replace(/S/g, '5').replace(/B/g, '8');
}

// ------------------------------------------------------------------- reading
function indexPage(words) {
  const lines = groupLines(words.filter((w) => w.text && w.text.trim()).map((w) => ({ ...w })));
  lines.forEach((line, li) => line.words.forEach((w, i) => { w.line = li; w.i = i; }));
  return { lines, words: lines.flatMap((l) => l.words) };
}

const next = (page, w) => page.lines[w.line].words[w.i + 1];
const prev = (page, w) => page.lines[w.line].words[w.i - 1];

/** Label words matching `re`, top to bottom. */
function anchors(page, re, test = () => true) {
  return page.words.filter((w) => re.test(bare(w.text)) && test(w));
}

/**
 * The value printed to the right of a label: words at the label's height, after
 * its colon, up to the next label. A wrapped label sits half a line above or
 * below its value, so "at the label's height" allows for that.
 *
 * @returns {{ words: Array, colon: boolean }}
 */
function valueRight(page, anchor) {
  const h = height(anchor);
  const band = page.words
    .filter((w) => w !== anchor && w.x0 > anchor.x1 - 0.2 * h && Math.abs(midY(w) - midY(anchor)) <= 1.1 * h)
    .sort((a, b) => a.x0 - b.x0);

  const out = [];
  let colon = false;
  let lastX = anchor.x1;

  for (const w of band) {
    if (w.x0 - lastX > 8 * h) break;              // a column gap with no label in it
    if (!colon && w.text.includes(':')) {
      colon = true;
      const rest = w.text.slice(w.text.indexOf(':') + 1);
      if (bare(rest)) out.push({ ...w, text: rest });
      lastX = w.x1;
      continue;
    }
    if (isLabel(w)) {
      // The next column has started -- unless no value has been seen yet and
      // this is still the anchor's own label ("DL No.", "Aadhar No.").
      if (out.length || colon) break;
      continue;
    }
    if (!colon && !out.length && LABEL_TAIL.test(bare(w.text))) continue;
    if (bare(w.text) || /^[-–—]$/.test(w.text)) out.push(w);
    lastX = w.x1;
  }

  out.sort((a, b) => a.line - b.line || a.x0 - b.x0);
  return { words: out, colon };
}

/** Joined text of a value, tidied. */
const asText = (words) => words
  .map((w) => w.text)
  .join(' ')
  .replace(/^[\s:;|.,-]+|[\s:;|,]+$/g, '')
  .replace(/\s+/g, ' ')
  .trim();

/** The first run of digit tokens whose length is in [min, max]. */
function digitRun(words, min, max) {
  const tokens = words.map((w) => fixDigits(bare(w.text)));
  for (let i = 0; i < tokens.length; i += 1) {
    let run = '';
    for (let j = i; j < tokens.length && /^\d+$/.test(tokens[j]); j += 1) {
      run += tokens[j];
      if (run.length >= min && run.length <= max) return run;
      if (run.length > max) break;
    }
  }
  return null;
}

function firstDate(words) {
  for (const w of words) {
    const m = fixDigits(w.text).match(/(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})/);
    if (m) return toIsoDate(`${m[1]}/${m[2]}/${m[3]}`);
  }
  return null;
}

/** RJ0520020087005, RJ05A20120004 -- OCR reads the 0 of RJ05 as an O. */
function dlNumber(words) {
  for (const w of words) {
    let t = bare(w.text).toUpperCase().replace(/[\s-]/g, '');
    if (t.length < 9 || !/^[A-Z]{2}/.test(t)) continue;
    const rto = t.slice(2, 4).replace(/O/g, '0').replace(/[IL]/g, '1').replace(/S/g, '5').replace(/Z/g, '2');
    const rest = t.slice(4).replace(/[OIL](?=\d)|(?<=\d)[OIL]/g, (c) => (c === 'O' ? '0' : '1'));
    t = t.slice(0, 2) + rto + rest;
    if (/^[A-Z]{2}\d{2}[A-Z0-9]{5,}$/.test(t) && t.replace(/\D/g, '').length >= 7) return t;
  }
  return null;
}

function ifsc(words) {
  for (const w of words) {
    const t = bare(w.text).toUpperCase();
    const fixed = t.length === 11 ? `${t.slice(0, 4)}${t[4].replace('O', '0')}${t.slice(5)}` : t;
    if (/^[A-Z]{4}0[A-Z0-9]{6}$/.test(fixed)) return fixed;
  }
  return null;
}

function phone(words) {
  const d = digitRun(words, 10, 12);
  if (!d) return null;
  const ten = d.length === 12 && d.startsWith('91') ? d.slice(2) : d;
  return /^[6-9]\d{9}$/.test(ten) ? ten : null;
}

// --------------------------------------------------------------- the fields
const after = (page, re) => (w) => re.test(bare(prev(page, w)?.text || ''));
const before = (page, re) => (w) => re.test(bare(next(page, w)?.text || ''));

const FIELDS = [
  ['registered_no', /^register$/i, null, (v) => digitRun(v, 12, 20)],
  ['name', /^name$/i, null, (v, colon) => (colon ? asText(v).replace(/[^A-Za-z .']/g, '').trim() || null : null)],
  ['dob_aadhar', /^dob$/i, null, firstDate],
  ['phone', /^mobile$/i, null, phone],
  ['aadhar_no', /^aadh\w*$/i, null, (v) => {
    const d = digitRun(v, 12, 12);
    return d && /^[2-9]/.test(d) ? d : null;
  }],
  ['dl_no', /^dl$/i, (p) => before(p, /^no$/i), dlNumber],
  ['dl_valid_from', /^from$/i, (p) => after(p, /^dl$/i), firstDate],
  ['dl_valid_till', /^to$/i, (p) => after(p, /^dl$/i), firstDate],
  ['uan_no', /^uan$/i, null, (v) => digitRun(v, 12, 12)],
  ['esic_no', /^esic$/i, null, (v) => digitRun(v, 10, 17)],
  ['bank_account_no', /^acc$/i, null, (v) => digitRun(v, 9, 18)],
  ['bank_ifsc', /^ifsc$/i, null, ifsc],
  ['location', /^location$/i, null, (v, colon) => (colon ? asText(v) || null : null)],
  ['company', /^company$/i, null, (v, colon) => (colon ? asText(v) || null : null)],
  ['function', /^function$/i, null, (v, colon) => (colon ? asText(v) || null : null)],
];

/** The form's reference relations; anything else is "Other". */
const RELATION = {
  father: 'Father', mother: 'Mother', brother: 'Brother', sister: 'Sister', son: 'Son',
  uncle: 'Uncle', wife: 'Spouse', husband: 'Spouse', spouse: 'Spouse',
};

const FAMILY_ROW =
  /(?:^|\s)(?:\d{1,2}\s+)?([A-Za-z][A-Za-z.'` ]{1,40}?)\s+(father|mother|wife|husband|spouse|brother|sister|son|daughter|uncle|aunt|friend|relative|other)\s+((?:\+?91[\s-]?)?[6-9]\d{9})\b/i;

/**
 * @param {Array} words  positioned words (see layout.js)
 * @returns {{ fields: object, confidence: object }}
 */
export function parseDetailsPage(words) {
  const page = indexPage(words);
  const fields = {};
  const confidence = {};
  const put = (k, v) => {
    if (v === null || v === undefined || v === '' || fields[k] !== undefined) return;
    fields[k] = v;
    confidence[k] = 'labelled';
  };

  for (const [key, re, test, read] of FIELDS) {
    const ok = test ? test(page) : () => true;
    for (const a of anchors(page, re, ok)) {
      const { words: v, colon } = valueRight(page, a);
      const value = read(v, colon);
      if (value) {
        put(key, value);
        break;
      }
    }
  }

  put('address', readAddress(page));

  // Family details: "1  AMAR SINGH  Father  9549639713"
  const family = anchors(page, /^family$/i)[0];
  const job = anchors(page, /^job$/i, before(page, /^details$/i))[0];
  const references = [];
  for (const line of page.lines) {
    if (family && line.y <= midY(family)) continue;
    if (job && line.y >= midY(job)) break;
    const m = line.words.map((w) => fixDigits(w.text)).join(' ').match(FAMILY_ROW);
    if (!m) continue;
    const relation = m[2].toLowerCase();
    const row = { relation: RELATION[relation] || 'Other', name: m[1].trim(), phone: m[3].replace(/\D/g, '').slice(-10) };
    if (relation === 'father') put('father_name', row.name);
    // The driver's own number is no use as a reference contact.
    if (row.phone !== fields.phone && !references.some((r) => r.phone === row.phone)) references.push(row);
  }
  if (references.length) put('references', references.slice(0, 2));

  return { fields, confidence };
}

/**
 * Present address: the lines under the first "Address :" label, kept to its own
 * column (the permanent address sits beside it), down to "City". City and
 * state are added when the address lines do not already name them.
 */
function readAddress(page) {
  // "Address :", not the "Present Address" heading above it.
  const label = anchors(page, /^address$/i, (w) => !/^(present|permanent)$/i.test(bare(prev(page, w)?.text || ''))
    && valueRight(page, w).colon)[0];
  if (!label) return null;
  const h = height(label);
  const beside = anchors(page, /^address$/i, (w) => w.x0 > label.x1 && Math.abs(midY(w) - midY(label)) <= h)[0];
  const stopX = beside ? beside.x0 : Infinity;
  const city = anchors(page, /^city$/i, (w) => w.y0 > label.y0 && w.x0 < stopX)[0];
  const bottom = city ? city.y0 : label.y1 + 3 * h;

  const lines = page.lines
    .map((l) => l.words.filter((w) => w.x0 >= label.x1 - 0.2 * h && w.x1 <= stopX
      && midY(w) >= label.y0 - 0.5 * h && midY(w) < bottom))
    .map((ws) => asText(ws.filter((w) => bare(w.text))))
    .filter(Boolean);

  // "VILL-" + "BEDHAM,BHARATPUR" is one word broken across two lines.
  let address = lines.reduce((s, l) => (!s ? l : /[-,/]$/.test(s) ? s + l : `${s}, ${l}`), '');
  if (!address) return null;

  if (city) {
    const cityName = asText(valueRight(page, city).words);
    const state = anchors(page, /^state$/i, (w) => w.x0 > city.x1 && w.x0 < stopX
      && Math.abs(midY(w) - midY(city)) <= height(city))[0];
    const stateName = state ? asText(valueRight(page, state).words) : '';
    [cityName, stateName].forEach((part) => {
      if (part && !address.toLowerCase().includes(part.toLowerCase())) address += `, ${part}`;
    });
  }
  return address;
}
