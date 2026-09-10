import ExcelJS from 'exceljs';
import { computePay } from './engine.js';
import { diffDays } from '../util.js';

/**
 * The pay register, in the client's own layouts.
 *
 * Two formats, copied cell for cell from the registers the client sends
 * (hzl_pay_register / surat, July 2026):
 *
 *   'hzl'    HZL DRIVER   — titles on rows 2-4, block headings on row 6, column
 *                           headers on row 7, drivers from row 8: a days block,
 *                           a "Fixed Gross" block, a "Payable salary" block, then
 *                           one blank row, the totals and the invoice footer —
 *                           service charge, IGST, total invoice.
 *   'surat'  SURAT DRIVER — a SUBTOTAL row on row 1, headers on row 2, drivers
 *                           from row 3, columns A to BO: every component as a
 *                           fixed / earned pair, PF and ESIC, CTC, and
 *                           per-driver invoice and TDS; a SUM row after a gap.
 *
 * Anything on another structure, or on a flat wage, goes on a plain sheet.
 *
 * Driver rows hold values from the pay engine at full precision; only the
 * display is rounded, as in the client's cells, so every SUM lands on the same
 * paisa as theirs. Totals and the invoice footer are live formulas, so the
 * register can still be audited in Excel.
 */

const MONTHS = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST',
  'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];

export function monthLabel(period) {
  const [y, m] = period.split('-').map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}

const MONEY = '#,##0.00';
const WHOLE = '0';                                            // HZL: whole rupees, no separators
const ACCOUNTING = '_ * #,##0_ ;_ * -#,##0_ ;_ * "-"??_ ;_ @_ '; // Surat: zero shows as "-"
const DATE = 'dd-mm-yyyy';
const PT_RE = /professional\s*tax|^pt$/i;
const thin = { style: 'thin', color: { argb: 'FFBFBFBF' } };
const BORDER = { top: thin, left: thin, bottom: thin, right: thin };
const HEAD_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3B57' } };
const GROUP_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDCE6F1' } };
const TOTAL_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F2F2' } };

export function colLetter(n) {
  let s = '';
  let x = n;
  while (x > 0) {
    const m = (x - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s;
}

const pick = (lines, name) => (name ? (lines || []).find((x) => x.name === name) : null);
const raw = (lines, name) => { const x = pick(lines, name); return x ? (x.raw ?? x.amount) : 0; };
const full = (lines, name) => { const x = pick(lines, name); return x ? (x.full ?? 0) : 0; };
const dateOf = (iso) => (iso ? new Date(`${String(iso).slice(0, 10)}T00:00:00Z`) : '');
const text = (v) => (v === null || v === undefined ? '' : String(v));
const numeric = (v) => { const n = Number(v); return Number.isFinite(n) && String(v).trim() !== '' ? n : text(v); };

// ------------------------------------------------------------------ shaping
/**
 * One payroll line, with the day breakdown and both the full-month and the
 * actual pay worked out — the register shows the two side by side.
 */
export function registerLine(l, structure, period, daysInMonth) {
  const first = `${period}-01`;
  const last = `${period}-${String(daysInMonth).padStart(2, '0')}`;
  const doj = l.date_of_joining ? String(l.date_of_joining).slice(0, 10) : null;
  const dol = l.date_of_leaving ? String(l.date_of_leaving).slice(0, 10) : null;

  const notJoined = doj && doj > first ? Math.min(daysInMonth, diffDays(first, doj)) : 0;
  const left = dol && dol < last ? Math.min(daysInMonth, diffDays(dol, last)) : 0;
  const present = Number(l.present_days || 0) + Number(l.training_days || 0) + Number(l.transit_days || 0);
  const payable = Number(l.payable_days || 0);
  const month = { daysInMonth, lsaMonthly: Number(l.lsa_monthly || 0) };

  return {
    code: l.client_id,
    name: l.name,
    registrationNo: l.registration_no,
    location: l.location,
    doj,
    status: dol && dol <= last ? 'Left' : 'Active',
    bankName: l.bank_name,
    bankBranch: l.bank_branch,
    bankAccount: l.bank_account_no,
    ifsc: l.bank_ifsc,
    uan: l.uan_no,
    days: {
      present,
      // Leave is unpaid on the current rules, so it lands here with absence.
      absent: Math.max(0, daysInMonth - payable - notJoined - left),
      weeklyOff: 0,
      holiday: 0,
      approvedLeave: 0,
      notJoined,
      left,
      total: daysInMonth,
      payable,
    },
    pay: computePay(structure, { ...month, payableDays: payable, presentDays: payable }),
    fixed: computePay(structure, { ...month, payableDays: daysInMonth, presentDays: daysInMonth }),
  };
}

// ------------------------------------------------------------------ helpers
function writer(ws) {
  const sums = new Map();
  return {
    sums,
    put(row, col, value, fmt, sum = false) {
      const c = ws.getCell(row, col);
      c.value = value === undefined ? null : value;
      if (fmt) c.numFmt = fmt;
      c.border = BORDER;
      if (sum && typeof value === 'number') sums.set(col, (sums.get(col) || 0) + value);
    },
  };
}

function formula(ws, row, col, f, result, fmt = MONEY) {
  const c = ws.getCell(row, col);
  c.value = { formula: f, result };
  if (fmt) c.numFmt = fmt;
  c.font = { bold: true };
  c.fill = TOTAL_FILL;
  c.border = BORDER;
}

function label(ws, row, fromCol, toCol, value) {
  if (toCol > fromCol) ws.mergeCells(row, fromCol, row, toCol);
  const c = ws.getCell(row, fromCol);
  c.value = value;
  c.font = { bold: true };
  c.fill = TOTAL_FILL;
  c.border = BORDER;
}

function headerRow(ws, row, blocks) {
  blocks.forEach(([start, heads]) => heads.forEach((h, i) => {
    const c = ws.getCell(row, start + i);
    c.value = h;
    c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    c.fill = HEAD_FILL;
    c.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    c.border = BORDER;
  }));
  ws.getRow(row).height = 42;
}

function groupHeader(ws, row, fromCol, toCol, value) {
  ws.mergeCells(row, fromCol, row, toCol);
  const c = ws.getCell(row, fromCol);
  c.value = value;
  c.font = { bold: true };
  c.fill = GROUP_FILL;
  c.alignment = { horizontal: 'center' };
  c.border = BORDER;
}

// ---------------------------------------------------------------- HZL sheet
// The client's header wording, which isn't quite the component names:
// [component, "Fixed" block header, "Payable" block header].
const HZL_HEADS = [
  [/^basic/i, 'Fixed Basic+VDA', 'Basic + VDA'],
  [/^hra/i, 'Fixed HRA', 'HRA'],
  [/mobile/i, 'Fixed Mobile Allowance', 'Mobile Allowance'],
  [/^food/i, 'Fixed food allowance', 'Food Allowance'],
];
const hzlHeads = (c) => HZL_HEADS.find(([re]) => re.test(c.name)) || [null, `Fixed ${c.name}`, c.name];

function hzlSheet(ws, { structure, lines, daysInMonth }, meta, period) {
  const month = monthLabel(period);
  const earn = structure.components.filter((c) => c.kind === 'earning');
  const ptName = (structure.components.find(
    (c) => c.kind === 'deduction' && !c.employer && PT_RE.test(c.name),
  ) || {}).name;

  const BASE = ['Sr. No', 'Employee ID', 'Employee Name', 'Designation', 'Drive for', 'Location',
    'DOJ', 'Status', 'Bank Name', 'Bank A/c No', 'IFSC Code', 'Bank Branch', 'PT State', 'Present',
    'Absent', 'Weekly Off', 'Holiday', 'Approved leave', 'Not Joined', 'Left', 'Total Day',
    'Payable Days'];
  const FIXED = [...earn.map((c) => hzlHeads(c)[1]), 'Fixed Gross', 'Fixed Professional Tax',
    'Fixed Total deduction', 'Fixed Net payable'];
  const PAY = [...earn.map((c) => hzlHeads(c)[2]), 'Gross', 'Professional Tax', 'Total Deduction',
    'Net payable'];

  const fixedStart = BASE.length + 1;
  const payStart = fixedStart + FIXED.length + 1;   // one blank column between, as the client has
  const lastCol = payStart + PAY.length - 1;
  const GROUP = 6;
  const HEAD = 7;
  const FIRST = 8;

  [[2, `Client :  ${meta.clientName}`], [3, `Vendor : ${meta.vendorName}`],
    [4, `PAY REGISTER FOR THE MONTH OF ${month}`]].forEach(([r, v]) => {
    ws.mergeCells(r, 1, r, 7);
    const c = ws.getCell(r, 1);
    c.value = v;
    c.font = { bold: true, size: r === 4 ? 12 : 11 };
  });
  groupHeader(ws, GROUP, fixedStart, fixedStart + FIXED.length - 1, 'Fixed Gross');
  groupHeader(ws, GROUP, payStart, lastCol, `Payable salary for the month of ${month}`);
  headerRow(ws, HEAD, [[1, BASE], [fixedStart, FIXED], [payStart, PAY]]);

  const w = writer(ws);
  lines.forEach((l, i) => {
    const r = FIRST + i;
    const d = l.days;
    [i + 1, numeric(l.code), l.name, 'Driver', structure.role_label || '', l.location || '',
      dateOf(l.doj), l.status, l.bankName || '', text(l.bankAccount), l.ifsc || '', l.bankBranch || '', '']
      .forEach((v, k) => w.put(r, k + 1, v, k === 6 ? DATE : undefined));
    [d.present, d.absent, d.weeklyOff, d.holiday, d.approvedLeave, d.notJoined, d.left, d.total, d.payable]
      .forEach((v, k) => w.put(r, 14 + k, v, WHOLE, true));

    earn.forEach((c, k) => w.put(r, fixedStart + k, full(l.fixed.earnings, c.name), WHOLE, true));
    const fx = fixedStart + earn.length;
    w.put(r, fx, l.fixed.exact.gross, WHOLE, true);
    w.put(r, fx + 1, raw(l.fixed.deductions, ptName), WHOLE, true);
    w.put(r, fx + 2, l.fixed.exact.totalDeduction, WHOLE, true);
    w.put(r, fx + 3, l.fixed.exact.net, WHOLE, true);

    earn.forEach((c, k) => w.put(r, payStart + k, raw(l.pay.earnings, c.name), WHOLE, true));
    const px = payStart + earn.length;
    w.put(r, px, l.pay.exact.gross, WHOLE, true);
    w.put(r, px + 1, raw(l.pay.deductions, ptName), WHOLE, true);
    w.put(r, px + 2, l.pay.exact.totalDeduction, WHOLE, true);
    w.put(r, px + 3, l.pay.exact.net, WHOLE, true);
  });
  const last = FIRST + lines.length - 1;

  // One blank row, the totals, then the invoice footer exactly as the client bills it.
  const tot = last + 2;
  const grossCol = payStart + earn.length;
  const grossTotal = w.sums.get(grossCol) || 0;
  label(ws, tot, 1, 3, `Total Gross HZL ${month}`);
  formula(ws, tot, 4, `SUM(${colLetter(grossCol)}${FIRST}:${colLetter(grossCol)}${last})`, grossTotal, WHOLE);
  for (const [col, s] of w.sums) {
    formula(ws, tot, col, `SUM(${colLetter(col)}${FIRST}:${colLetter(col)}${last})`, s, WHOLE);
  }

  const sc = Number(structure.service_charge || 0);
  const gst = Number(structure.gst_rate || 0);
  const presentTotal = w.sums.get(14) || 0;
  const scTotal = (sc / daysInMonth) * presentTotal;
  const gstTotal = ((grossTotal + scTotal) * gst) / 100;
  label(ws, tot + 1, 1, 3, `Service Charge @ ${sc} Per Person`);
  formula(ws, tot + 1, 4, `${sc}/${daysInMonth}*${colLetter(14)}${tot}`, scTotal, WHOLE);
  label(ws, tot + 2, 1, 3, `IGST@${gst}%`);
  formula(ws, tot + 2, 4, `SUM(D${tot}:D${tot + 1})*${gst}%`, gstTotal, WHOLE);
  label(ws, tot + 3, 1, 3, 'Total Invoice');
  formula(ws, tot + 3, 4, `SUM(D${tot}:D${tot + 2})`, grossTotal + scTotal + gstTotal, WHOLE);

  ws.getColumn(1).width = 6;
  ws.getColumn(2).width = 11;
  ws.getColumn(3).width = 26;
  ws.getColumn(5).width = 28;
  for (let c = 6; c <= 13; c += 1) ws.getColumn(c).width = c === 9 ? 22 : 14;
  for (let c = 14; c <= 22; c += 1) ws.getColumn(c).width = 8;
  for (let c = fixedStart; c <= lastCol; c += 1) ws.getColumn(c).width = 12;
  ws.getColumn(payStart - 1).width = 3;
  ws.views = [{ state: 'frozen', xSplit: 3, ySplit: HEAD }];
}

// -------------------------------------------------------------- Surat sheet
function suratSheet(ws, { structure, lines, daysInMonth }, meta, period) {
  const gst = Number(structure.gst_rate || 0);
  const find = (pred) => (structure.components.find(pred) || {}).name;
  const E = (re) => find((c) => c.kind === 'earning' && re.test(c.name));
  const N = {
    basic: find((c) => c.kind === 'earning' && (c.is_basic || /^basic/i.test(c.name))),
    hra: E(/hra/i),
    personal: E(/personal/i),
    journey: E(/journey/i),
    lsa: find((c) => c.kind === 'earning' && (c.per_driver || /^lsa|loyalty/i.test(c.name))),
    mobile: E(/mobile/i),
    leaveEnc: E(/leave\s*enc/i),
    statBonus: E(/statutory/i),
    halt: E(/halt/i),
    food: E(/^food/i),
    safety: E(/safety/i),
    bonus: E(/attendance\s*bonus|^bonus/i),
    incentive: E(/incentive/i),
    ot: E(/\bot\b|overtime/i),
    pfEr: find((c) => c.kind === 'deduction' && c.employer && /pf|provident/i.test(c.name)),
    esicEr: find((c) => c.kind === 'deduction' && c.employer && /esic/i.test(c.name)),
    pf: find((c) => c.kind === 'deduction' && !c.employer && /pf|provident/i.test(c.name)),
    esic: find((c) => c.kind === 'deduction' && !c.employer && /esic/i.test(c.name)),
    pt: find((c) => c.kind === 'deduction' && !c.employer && PT_RE.test(c.name)),
  };

  const fx = (l, name) => full(l.pay.earnings, name);
  const er = (l, name) => raw(l.pay.earnings, name);
  const ded = (l, name) => raw(l.pay.deductions, name);
  const empEarned = (l, name) => raw(l.pay.employer, name);
  const empFixed = (l, name) => raw(l.fixed.employer, name);
  // The client leaves some columns empty when the structure has no such
  // component, and writes 0 ("-") in others; `blank` copies which is which.
  const blank = (name, v) => (name ? v : null);

  // The client's CTC column: every component at its fixed figure, the LSA
  // actually earned, and employer PF on the fixed basic.
  const ctcColumn = (l) => structure.components
    .filter((c) => c.kind === 'earning')
    .reduce((s, c) => s + (c.name === N.lsa ? er(l, c.name) : fx(l, c.name)), 0)
    + (N.pfEr ? empFixed(l, N.pfEr) : 0);

  const A = ACCOUNTING;
  // [header, value(line, index), format, summed] — headers as the client
  // writes them, line breaks included.
  const COLS = [
    ['Sl No.', (l, i) => i + 1],
    ['Associate Code', () => null],
    ['Month', () => dateOf(`${period}-01`), DATE],
    ['Contractor Name', () => meta.contractor],
    ['Code', (l) => numeric(l.code)],
    ['Name of Associate', (l) => l.name],
    ['Date of Joining', (l) => dateOf(l.doj), DATE],
    ['Branch', (l) => l.location || ''],
    ['Branch Incharge', () => null],
    ['Bank Name', (l) => l.bankName || ''],
    ['Bank Ac No', (l) => text(l.bankAccount)],
    ['Bank Branch', (l) => l.ifsc || ''],
    ['Function', () => structure.role_label || ''],
    ['EMPPFNo', () => meta.pfEstablishmentNo || ''],
    ['UAN No', (l) => l.uan || '-'],
    ['EmpESINo', () => 0],
    ['CTC', ctcColumn, WHOLE, true],
    ['BASIC+DA', (l) => fx(l, N.basic), A, true],
    ['BASIC+\nDA', (l) => er(l, N.basic), A, true],
    ['HRA', (l) => fx(l, N.hra), A, true],
    ['HRA', (l) => er(l, N.hra), A, true],
    ['Personal Allowance', (l) => fx(l, N.personal), A, true],
    ['Personal Allowance', (l) => er(l, N.personal), A, true],
    ['Journey Plan', (l) => fx(l, N.journey), A, true],
    ['Journey Plan', (l) => er(l, N.journey), A, true],
    ['LSA', (l) => er(l, N.lsa), A, true],
    ['Mobile Allowance', (l) => fx(l, N.mobile), A, true],
    ['Mobile Allowance', (l) => er(l, N.mobile), A, true],
    ['Leave Encashment', (l) => blank(N.leaveEnc, fx(l, N.leaveEnc)), A, true],
    ['Leave Encashment', (l) => er(l, N.leaveEnc), A, true],
    ['Statutory Bonus 22-23', (l) => blank(N.statBonus, fx(l, N.statBonus)), A, true],
    ['Statutory Bonus 22-23', (l) => er(l, N.statBonus), A, true],
    ['Halt Allowance', (l) => fx(l, N.halt), A, true],
    ['Halt Allowance', (l) => er(l, N.halt), A, true],
    ['Food Allowance', (l) => blank(N.food, fx(l, N.food)), A, true],
    ['Food Allowance', (l) => blank(N.food, er(l, N.food)), A, true],
    ['Safety Adherance', (l) => blank(N.safety, fx(l, N.safety)), A, true],
    ['Safety Adherance', (l) => blank(N.safety, er(l, N.safety)), A, true],
    ['BONUS', (l) => fx(l, N.bonus), A, true],
    ['Attendance Bonus', (l) => er(l, N.bonus), A, true],
    ['Incentive R', (l) => blank(N.incentive, fx(l, N.incentive)), A, true],
    ['Incentive R', (l) => blank(N.incentive, er(l, N.incentive)), A, true],
    ['OT\nALLOW', (l) => er(l, N.ot), A, true],
    ['PF \n(13%)', (l) => empFixed(l, N.pfEr), A, true],
    ['PF \n(13%)', (l) => empEarned(l, N.pfEr), A, true],
    ['ESIC \n(3.25%)', (l) => blank(N.esicEr, empFixed(l, N.esicEr)), A, true],
    ['ESIC\n(3.25%)', (l) => blank(N.esicEr, empEarned(l, N.esicEr)), A, true],
    ['PF Ded', (l) => ded(l, N.pf), A, true],
    ['ESIC\n(0.75%)', (l) => blank(N.esic, ded(l, N.esic)), A, true],
    ['PT', (l) => ded(l, N.pt), A, true],
    ['Total Ded', (l) => l.pay.exact.totalDeduction, A, true],
    ['Gross', (l) => l.pay.exact.gross, A, true],
    ['Salary in Hand', (l) => l.pay.exact.net, A, true],
    ['COST TO COMPANY\n(CTC)', (l) => l.pay.exact.ctc, A, true],
    ['Month Days', () => daysInMonth, A, true],
    ['Pr Day', (l) => l.days.payable, A, true],
    ['Tot Day', () => daysInMonth, A, true],
    ['OT \nHOURS', () => null, A, true],
    ['Net Payable', (l) => l.pay.exact.net, A, true],
    ['Standard SC', () => Number(structure.service_charge || 0), A, true],
    ['Service Charge', (l) => l.pay.exact.billing.serviceCharge, A, true],
    ['Taxable Amount (Invoice)', (l) => l.pay.exact.billing.taxable, A, true],
    [`GST @${gst}%(Prov)`, (l) => l.pay.exact.billing.gst, A, true],
    ['Total Invoice Value', (l) => l.pay.exact.billing.invoice, A, true],
    ['TDS Rate', () => Number(structure.tds_rate || 0), A, true],
    ['TDS Provision', (l) => l.pay.exact.billing.tds, A, true],
    ['Net Payable', (l) => l.pay.exact.billing.netToVendor, A, true],
  ];

  const START = 1;   // column A, as in the client's register
  const HEAD = 2;
  const FIRST = 3;
  headerRow(ws, HEAD, [[START, COLS.map((c) => c[0])]]);

  const w = writer(ws);
  lines.forEach((l, i) => {
    COLS.forEach(([, get, fmt, summed], k) => w.put(FIRST + i, START + k, get(l, i), fmt, Boolean(summed)));
  });
  const last = FIRST + lines.length - 1;

  // A SUBTOTAL across the top and, after one blank row, a SUM row — both
  // unlabelled, as the client has them.
  const tot = last + 2;
  COLS.forEach(([, , fmt, summed], k) => {
    if (!summed) return;
    const col = START + k;
    const L = colLetter(col);
    const s = w.sums.get(col) || 0;
    formula(ws, 1, col, `SUBTOTAL(9,${L}${FIRST}:${L}${last})`, s, fmt);
    formula(ws, tot, col, `SUM(${L}${FIRST}:${L}${last})`, s, fmt);
  });

  COLS.forEach(([h], k) => {
    ws.getColumn(START + k).width = /Name of Associate|Bank Name|Function/.test(h) ? 24 : 12;
  });
  ws.getColumn(START).width = 6;
  ws.views = [{ state: 'frozen', xSplit: 6, ySplit: HEAD }];
}

// ------------------------------------------------------------- other sheet
function plainSheet(ws, { lines }, meta, period) {
  const HEADS = ['Sr. No', 'Client ID', 'Reg. No', 'Driver Name', 'Location', 'Present',
    'Payable Days', 'Total Days', 'Gross', 'Deductions', 'Net payable'];
  ws.mergeCells(1, 1, 1, 6);
  ws.getCell(1, 1).value = `PAY REGISTER FOR THE MONTH OF ${monthLabel(period)} — other drivers`;
  ws.getCell(1, 1).font = { bold: true, size: 12 };
  headerRow(ws, 3, [[1, HEADS]]);
  const w = writer(ws);
  lines.forEach((l, i) => {
    const r = 4 + i;
    [i + 1, numeric(l.code), l.registrationNo || '', l.name, l.location || ''].forEach((v, k) => w.put(r, k + 1, v));
    w.put(r, 6, l.days.present, '0', true);
    w.put(r, 7, l.days.payable, '0', true);
    w.put(r, 8, l.days.total, '0', true);
    w.put(r, 9, l.pay.exact.gross, MONEY, true);
    w.put(r, 10, l.pay.exact.totalDeduction, MONEY, true);
    w.put(r, 11, l.pay.exact.net, MONEY, true);
  });
  const last = 3 + lines.length;
  const tot = last + 2;
  label(ws, tot, 1, 5, 'Total');
  for (const [col, s] of w.sums) {
    formula(ws, tot, col, `SUM(${colLetter(col)}4:${colLetter(col)}${last})`, s, col >= 9 ? MONEY : '0');
  }
  [6, 11, 16, 26, 22, 9, 11, 9, 14, 13, 14].forEach((wd, i) => { ws.getColumn(i + 1).width = wd; });
  ws.views = [{ state: 'frozen', xSplit: 4, ySplit: 3 }];
}

// ------------------------------------------------------------------ builder
/**
 * @param {object} args
 * @param {string} args.period                 YYYY-MM
 * @param {Array}  args.groups                 [{ format, structure, lines, daysInMonth }]
 * @param {object} args.meta                   { clientName, vendorName, contractor, pfEstablishmentNo }
 */
export async function buildPayRegister({ period, groups, meta }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = meta.vendorName || 'Quantum';
  wb.created = new Date();
  // Have Excel recalculate on open, so every total shows even where no cached
  // result was stored (ExcelJS drops a cached 0).
  wb.calcProperties.fullCalcOnLoad = true;

  const used = new Set();
  const sheetName = (base, code) => {
    let n = base;
    if (used.has(n)) n = `${base} ${code || used.size}`.slice(0, 31);
    used.add(n);
    return n;
  };

  for (const g of groups) {
    if (!g.lines.length) continue;
    if (g.format === 'hzl') hzlSheet(wb.addWorksheet(sheetName('HZL DRIVER', g.structure.code)), g, meta, period);
    else if (g.format === 'surat') suratSheet(wb.addWorksheet(sheetName('SURAT DRIVER', g.structure.code)), g, meta, period);
    else plainSheet(wb.addWorksheet(sheetName('OTHER DRIVERS', g.structure?.code)), g, meta, period);
  }
  if (!wb.worksheets.length) wb.addWorksheet('Pay Register').getCell('A1').value = 'No payroll lines for this period.';

  return Buffer.from(await wb.xlsx.writeBuffer());
}
