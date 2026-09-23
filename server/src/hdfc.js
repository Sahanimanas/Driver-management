import { buildWorkbook, XLSX_MIME } from './excel.js';
import { config } from './config.js';
import { today } from './util.js';

/**
 * HDFC Bank "RBI Adapter For RTGS NEFT FT" bulk upload sheet.
 *
 * One layout for every payment the company makes to drivers -- the day's
 * advances and the month's salary -- so Finance uploads the same kind of file
 * either way. It copies Sheet1 of the sheets Finance uploads today (e.g. the
 * Surat August 3rd sheet) column for column, headers word for word:
 *
 *   A  Transaction Type        N = NEFT for every account, HDFC ones included;
 *                              R = RTGS at Rs 2 lakh and over. I (fund
 *                              transfer) needs a registered beneficiary code,
 *                              which is not used, so it is never produced.
 *   B  Beneficiary Code        blank (only for I)
 *   C  Account Number          text, so leading zeros survive
 *   D  (no header)             the amount, a plain number
 *   E  Beneficiary Name        "NAME CLIENTID", at most 40 characters
 *   F-M                        cheque / DD and instruction fields, blank
 *   N  Customer Reference      VENDOR
 *   O-V                        payment details and cheque no., blank
 *   W  Chq / Trn Date          DD/MM/YYYY, as text
 *   X  MICR                    blank
 *   Y  IFSC Code
 *   Z-AA Bank / Branch name    blank
 *   AB Beneficiary email id    the company's email, the same on every row
 *
 * Reconciliation matches the returned bank statement by account number, so
 * the fixed VENDOR reference does not get in its way.
 */
export const HDFC_COLUMNS = [
  { header: 'Transaction Type (N – NFET, R – RTGS & I - Fund Transfer in HDFC Bank account)', key: 'txnType', width: 12 },
  { header: 'Beneficiary Code (Mandatory In case of Fund Transfer only)', key: 'beneCode', width: 14 },
  { header: 'Beneficiary Account Number', key: 'account', width: 22 },
  { header: '', key: 'amount', width: 12 },
  { header: 'Beneficiary Name (Upto 40 character without any special character)', key: 'name', width: 34 },
  { header: 'Drawee Location', key: 'drawee', width: 10 },
  { header: 'Print Location', key: 'print', width: 10 },
  { header: 'Bene Address 1', key: 'addr1', width: 10 },
  { header: 'Bene Address 2', key: 'addr2', width: 10 },
  { header: 'Bene Address 3', key: 'addr3', width: 10 },
  { header: 'Bene Address 4', key: 'addr4', width: 10 },
  { header: 'Bene Address 5', key: 'addr5', width: 10 },
  { header: 'Instruction Reference Number', key: 'instrRef', width: 14 },
  { header: 'Customer Reference Number(Which needs to be reflected in statement upto character upto 20)', key: 'custRef', width: 16 },
  { header: 'Payment details 1', key: 'pd1', width: 10 },
  { header: 'Payment details 2', key: 'pd2', width: 10 },
  { header: 'Payment details 3', key: 'pd3', width: 10 },
  { header: 'Payment details 4', key: 'pd4', width: 10 },
  { header: 'Payment details 5', key: 'pd5', width: 10 },
  { header: 'Payment details 6', key: 'pd6', width: 10 },
  { header: 'Payment details 7', key: 'pd7', width: 10 },
  { header: 'Cheque Number', key: 'cheque', width: 10 },
  { header: 'Chq / Trn Date (DD/MM/YYYY)', key: 'date', width: 13 },
  { header: 'MICR Number', key: 'micr', width: 10 },
  { header: 'IFSC Code', key: 'ifsc', width: 14 },
  { header: 'Bene Bank Name', key: 'bank', width: 10 },
  { header: 'Bene Bank Branch Name', key: 'branch', width: 10 },
  { header: 'Beneficiary email id', key: 'email', width: 20 },
];

/** NEFT, or RTGS at Rs 2 lakh and over. */
export function transactionType(amount) {
  return Number(amount) >= 200000 ? 'R' : 'N';
}

const ddmmyyyy = (iso) => {
  const [y, m, d] = String(iso || today()).slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
};

/** Letters, digits and spaces only, as HDFC accepts them. */
const clean = (s) => String(s || '').replace(/[^A-Za-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

/** "ARVIND KUMAR YADAV 42152": the name, shortened if need be so the ID always fits. */
function beneName(name, employeeId) {
  const id = clean(employeeId);
  const room = id ? 40 - id.length - 1 : 40;
  const n = clean(name).toUpperCase().slice(0, room).trim();
  return id ? `${n} ${id}` : n;
}

/**
 * payments: [{ name, employeeId, account, ifsc, amount }]
 */
export function hdfcRows(payments, { date = today() } = {}) {
  return payments.map((p) => ({
    txnType: transactionType(p.amount),
    account: String(p.account || '').trim(),
    amount: Math.round(Number(p.amount) * 100) / 100,
    name: beneName(p.name, p.employeeId),
    custRef: config.hdfc.customerRef,
    date: ddmmyyyy(date),
    ifsc: String(p.ifsc || '').toUpperCase().trim(),
    email: config.hdfc.email,
  }));
}

/**
 * The upload file, as .xlsx laid out exactly like the RBI Adapter sheet (a
 * header row, then one row per payment), or as .csv (no header). The debit
 * account is chosen in ENet at upload time, so it is not part of the record.
 */
export async function buildHdfcFile(payments, { date, format = 'xlsx' } = {}) {
  const rows = hdfcRows(payments, { date });
  if (format === 'csv') {
    const esc = (v) => {
      const s = String(v ?? '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const body = rows.map((r) => HDFC_COLUMNS.map((c) => esc(r[c.key])).join(',')).join('\r\n');
    return { buffer: Buffer.from(`${body}\r\n`, 'utf8'), mime: 'text/csv', ext: 'csv' };
  }
  // No title and no notes under the data: the sheet has to be uploadable as it
  // stands, so it is nothing but the header row and one row per payment.
  const buffer = await buildWorkbook({ sheetName: 'Sheet1', columns: HDFC_COLUMNS, rows });
  return { buffer, mime: XLSX_MIME, ext: 'xlsx' };
}
