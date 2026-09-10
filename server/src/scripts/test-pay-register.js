/**
 * Pay-register regression test.
 *
 *   npm run test:payroll
 *
 * Replays the client's own July 2026 pay register -- 58 HZL and 172 Surat
 * drivers -- through the pay engine and the salary structures the salary
 * master is seeded with, and requires every figure to match what Excel
 * computed, to the paisa: each component, gross, deductions, net, employer PF,
 * CTC, and the service charge, GST, invoice and TDS the client is billed.
 *
 * It then builds the downloadable register from the same drivers and checks
 * the workbook reads like the client's files (hzl_pay_register.csv and
 * surat.csv): every header in the same cell, drivers from the same row, and
 * the totals and invoice footer on the rows the client has them.
 *
 * The fixture holds numbers only; every name, code, bank and UAN was stripped
 * before it was committed. Exits 1 on any difference.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import { computePay } from '../payroll/engine.js';
import { CLIENT_STRUCTURES } from '../payroll/structures.js';
import { buildPayRegister, registerLine } from '../payroll/register.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(
  fs.readFileSync(path.join(here, 'fixtures', 'client-pay-register-2026-07.json'), 'utf8'),
);

const HZL = CLIENT_STRUCTURES.find((s) => s.register_format === 'hzl');
const SURAT = CLIENT_STRUCTURES.find((s) => s.register_format === 'surat');

// Excel shows two places; allow for its own last-digit rounding.
const TOL = 0.011;
const fails = [];
let checks = 0;
const cmp = (sheet, row, field, want, got) => {
  checks += 1;
  if (Math.abs(Number(want) - Number(got)) > TOL) fails.push({ sheet, row, field, want, got });
};
const amt = (lines, re) => (lines.find((l) => re.test(l.name)) || { amount: 0 }).amount;

// ---------------------------------------------------------------------- HZL
let hz = { gross: 0, net: 0, sc: 0 };
for (const r of data.hzl) {
  const p = computePay(HZL, { payableDays: r.payableDays, daysInMonth: r.totalDays, presentDays: r.present });
  cmp('HZL', r.row, 'basic', r.out.basic, amt(p.earnings, /^basic/i));
  cmp('HZL', r.row, 'hra', r.out.hra, amt(p.earnings, /^hra/i));
  cmp('HZL', r.row, 'mobile', r.out.mobile, amt(p.earnings, /mobile/i));
  cmp('HZL', r.row, 'food', r.out.food, amt(p.earnings, /food/i));
  cmp('HZL', r.row, 'gross', r.out.gross, p.gross);
  cmp('HZL', r.row, 'deduction', r.out.deduction, p.totalDeduction);
  cmp('HZL', r.row, 'net', r.out.net, p.net);
  // Totals sum unrounded values, as the register's own SUM() does.
  hz = { gross: hz.gross + p.exact.gross, net: hz.net + p.exact.net, sc: hz.sc + p.exact.billing.serviceCharge };
}
const igst = ((hz.gross + hz.sc) * HZL.gst_rate) / 100;
cmp('HZL', 'total', 'gross', data.hzTotals.gross, hz.gross);
cmp('HZL', 'total', 'net', data.hzTotals.net, hz.net);
cmp('HZL', 'total', 'serviceCharge', data.hzTotals.serviceCharge, hz.sc);
cmp('HZL', 'total', 'igst', data.hzTotals.igst, igst);
cmp('HZL', 'total', 'invoice', data.hzTotals.invoice, hz.gross + hz.sc + igst);

// -------------------------------------------------------------------- Surat
const su = { gross: 0, inHand: 0, ctc: 0, invoice: 0, netToVendor: 0 };
for (const r of data.surat) {
  const p = computePay(SURAT, {
    payableDays: r.presentDays, daysInMonth: r.monthDays, presentDays: r.presentDays, lsaMonthly: r.lsaMonthly,
  });
  const o = r.out;
  cmp('Surat', r.row, 'basic', o.basic, amt(p.earnings, /^basic/i));
  cmp('Surat', r.row, 'hra', o.hra, amt(p.earnings, /^hra/i));
  cmp('Surat', r.row, 'personal', o.personal, amt(p.earnings, /personal/i));
  cmp('Surat', r.row, 'lsa', o.lsa, amt(p.earnings, /^lsa/i));
  cmp('Surat', r.row, 'mobile', o.mobile, amt(p.earnings, /mobile/i));
  cmp('Surat', r.row, 'halt', o.halt, amt(p.earnings, /halt/i));
  cmp('Surat', r.row, 'attendanceBonus', o.attendanceBonus, amt(p.earnings, /attendance bonus/i));
  cmp('Surat', r.row, 'pfEmployee', o.pfEmployee, amt(p.deductions, /^pf/i));
  cmp('Surat', r.row, 'pt', o.pt, amt(p.deductions, /professional tax/i));
  cmp('Surat', r.row, 'totalDeduction', o.totalDeduction, p.totalDeduction);
  cmp('Surat', r.row, 'pfEmployer', o.pfEmployer, amt(p.employer, /pf/i));
  cmp('Surat', r.row, 'gross', o.gross, p.gross);
  cmp('Surat', r.row, 'inHand', o.inHand, p.net);
  cmp('Surat', r.row, 'ctc', o.ctc, p.ctc);
  cmp('Surat', r.row, 'serviceCharge', o.serviceCharge, p.billing.serviceCharge);
  cmp('Surat', r.row, 'taxable', o.taxable, p.billing.taxable);
  cmp('Surat', r.row, 'gst', o.gst, p.billing.gst);
  cmp('Surat', r.row, 'invoice', o.invoice, p.billing.invoice);
  cmp('Surat', r.row, 'tds', o.tds, p.billing.tds);
  cmp('Surat', r.row, 'netToVendor', o.netToVendor, p.billing.netToVendor);
  su.gross += p.exact.gross;
  su.inHand += p.exact.net;
  su.ctc += p.exact.ctc;
  su.invoice += p.exact.billing.invoice;
  su.netToVendor += p.exact.billing.netToVendor;
}
for (const k of Object.keys(su)) cmp('Surat', 'total', k, data.suTotals[k], su[k]);

// ------------------------------------------------------------------- layout
// Header rows exactly as the client's registers have them (line breaks inside
// a header are compared as spaces). null = the empty spacer column.
const HZL_HEADERS = ['Sr. No', 'Employee ID', 'Employee Name', 'Designation', 'Drive for', 'Location',
  'DOJ', 'Status', 'Bank Name', 'Bank A/c No', 'IFSC Code', 'Bank Branch', 'PT State', 'Present',
  'Absent', 'Weekly Off', 'Holiday', 'Approved leave', 'Not Joined', 'Left', 'Total Day',
  'Payable Days', 'Fixed Basic+VDA', 'Fixed HRA', 'Fixed Mobile Allowance', 'Fixed food allowance',
  'Fixed Gross', 'Fixed Professional Tax', 'Fixed Total deduction', 'Fixed Net payable', null,
  'Basic + VDA', 'HRA', 'Mobile Allowance', 'Food Allowance', 'Gross', 'Professional Tax',
  'Total Deduction', 'Net payable'];
const SURAT_HEADERS = ['Sl No.', 'Associate Code', 'Month', 'Contractor Name', 'Code',
  'Name of Associate', 'Date of Joining', 'Branch', 'Branch Incharge', 'Bank Name', 'Bank Ac No',
  'Bank Branch', 'Function', 'EMPPFNo', 'UAN No', 'EmpESINo', 'CTC', 'BASIC+DA', 'BASIC+ DA', 'HRA',
  'HRA', 'Personal Allowance', 'Personal Allowance', 'Journey Plan', 'Journey Plan', 'LSA',
  'Mobile Allowance', 'Mobile Allowance', 'Leave Encashment', 'Leave Encashment',
  'Statutory Bonus 22-23', 'Statutory Bonus 22-23', 'Halt Allowance', 'Halt Allowance',
  'Food Allowance', 'Food Allowance', 'Safety Adherance', 'Safety Adherance', 'BONUS',
  'Attendance Bonus', 'Incentive R', 'Incentive R', 'OT ALLOW', 'PF (13%)', 'PF (13%)',
  'ESIC (3.25%)', 'ESIC (3.25%)', 'PF Ded', 'ESIC (0.75%)', 'PT', 'Total Ded', 'Gross',
  'Salary in Hand', 'COST TO COMPANY (CTC)', 'Month Days', 'Pr Day', 'Tot Day', 'OT HOURS',
  'Net Payable', 'Standard SC', 'Service Charge', 'Taxable Amount (Invoice)', 'GST @18%(Prov)',
  'Total Invoice Value', 'TDS Rate', 'TDS Provision', 'Net Payable'];

const norm = (x) => String(x ?? '').replace(/\s+/g, ' ').trim();
const same = (sheet, cell, want, got) => {
  checks += 1;
  if (norm(want) !== norm(got)) fails.push({ sheet, row: cell, field: 'text', want, got });
};
const cellValue = (ws, addr) => {
  const v = ws.getCell(addr).value;
  return v && typeof v === 'object' && 'result' in v ? v.result : v;
};

const PERIOD = '2026-07';
const line = (i, days, lsa = 0) => ({
  client_id: 900000 + i, name: `Driver ${i + 1}`, present_days: days, payable_days: days, lsa_monthly: lsa,
});
const buf = await buildPayRegister({
  period: PERIOD,
  meta: {
    clientName: 'QUANTUM CORPSERV (INDIA) PRIVATE LIMITED',
    vendorName: 'Dynamic India Management Association & Consulting',
    contractor: 'DIMAC',
    pfEstablishmentNo: 'DSNHP2391164000',
  },
  groups: [
    { format: 'hzl', structure: HZL, daysInMonth: 31,
      lines: data.hzl.map((r, i) => registerLine(line(i, r.payableDays), HZL, PERIOD, r.totalDays)) },
    { format: 'surat', structure: SURAT, daysInMonth: 31,
      lines: data.surat.map((r, i) => registerLine(line(i, r.presentDays, r.lsaMonthly), SURAT, PERIOD, r.monthDays)) },
  ],
});
const book = new ExcelJS.Workbook();
await book.xlsx.load(buf);

// HZL: titles on 2-4, block headings on 6, headers on 7, drivers from 8, then
// one blank row and the totals + invoice footer (row 67 for 58 drivers).
const hzWs = book.getWorksheet('HZL DRIVER');
same('HZL layout', 'A2', 'Client : QUANTUM CORPSERV (INDIA) PRIVATE LIMITED', cellValue(hzWs, 'A2'));
same('HZL layout', 'A4', 'PAY REGISTER FOR THE MONTH OF JULY 2026', cellValue(hzWs, 'A4'));
same('HZL layout', 'W6', 'Fixed Gross', cellValue(hzWs, 'W6'));
same('HZL layout', 'AF6', 'Payable salary for the month of JULY 2026', cellValue(hzWs, 'AF6'));
HZL_HEADERS.forEach((h, i) => same('HZL layout', `${hzWs.getCell(7, i + 1).address}`, h, cellValue(hzWs, hzWs.getCell(7, i + 1).address)));
same('HZL layout', 'A8', 1, cellValue(hzWs, 'A8'));
const hzTot = 8 + data.hzl.length + 1;
same('HZL layout', `A${hzTot}`, 'Total Gross HZL JULY 2026', cellValue(hzWs, `A${hzTot}`));
same('HZL layout', `A${hzTot + 3}`, 'Total Invoice', cellValue(hzWs, `A${hzTot + 3}`));
cmp('HZL layout', `D${hzTot}`, 'gross', data.hzTotals.gross, cellValue(hzWs, `D${hzTot}`));
cmp('HZL layout', `D${hzTot + 1}`, 'serviceCharge', data.hzTotals.serviceCharge, cellValue(hzWs, `D${hzTot + 1}`));
cmp('HZL layout', `D${hzTot + 2}`, 'igst', data.hzTotals.igst, cellValue(hzWs, `D${hzTot + 2}`));
cmp('HZL layout', `D${hzTot + 3}`, 'invoice', data.hzTotals.invoice, cellValue(hzWs, `D${hzTot + 3}`));

// Surat: SUBTOTAL row 1, headers on 2 from column A, drivers from 3, and the
// SUM row after one blank row (row 176 for 172 drivers).
const suWs = book.getWorksheet('SURAT DRIVER');
SURAT_HEADERS.forEach((h, i) => same('Surat layout', suWs.getCell(2, i + 1).address, h, cellValue(suWs, suWs.getCell(2, i + 1).address)));
same('Surat layout', 'A3', 1, cellValue(suWs, 'A3'));
same('Surat layout', 'N3', 'DSNHP2391164000', cellValue(suWs, 'N3'));
const suTot = 3 + data.surat.length + 1;
for (const [col, key] of [['AZ', 'gross'], ['BA', 'inHand'], ['BB', 'ctc'], ['BL', 'invoice'], ['BO', 'netToVendor']]) {
  cmp('Surat layout', `${col}1`, key, data.suTotals[key], cellValue(suWs, `${col}1`));
  cmp('Surat layout', `${col}${suTot}`, key, data.suTotals[key], cellValue(suWs, `${col}${suTot}`));
}

// ------------------------------------------------------------------ report
console.log(`\nPay register — client July 2026: ${data.hzl.length} HZL + ${data.surat.length} Surat drivers, ${checks} checks`);
if (!fails.length) {
  console.log('  All figures match the client register to the paisa, and the workbook matches its layout.\n');
  process.exit(0);
}
const show = (x) => (typeof x === 'number' ? Math.round(x * 100) / 100 : JSON.stringify(x));
console.log(`  ${fails.length} mismatch(es):`);
fails.slice(0, 20).forEach((f) => {
  console.log(`    ${f.sheet} ${f.row} ${f.field}: register ${show(f.want)}, ours ${show(f.got)}`);
});
console.log('');
process.exit(1);
