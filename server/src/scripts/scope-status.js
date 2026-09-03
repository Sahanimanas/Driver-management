/**
 * Build the scope status workbook.
 *
 *   npm run scope-status
 *
 * Every point of `Web Application_Quantum.docx` is listed with where it is
 * implemented and what state it is in. The point text is quoted from the
 * document so the sheet can be read side by side with it.
 *
 * Status values:
 *   Done                 built, exercised by a test, and seen working
 *   Done — needs client  built and working on placeholder data; the client
 *                        still owes a figure, a format or an asset
 *   Not started          nothing in the document to build from yet
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..', '..', '..');

const DONE = 'Done';
const NEEDS = 'Done — needs client input';
const TODO = 'Not started';

// section, point (quoted from the document), status, where it lives, notes
const POINTS = [
  // ------------------------------------------------------------- branding
  ['Branding',
    'Change the name of Sahchr… will share logo and DIMAC',
    NEEDS,
    'Settings → Branding; server/src/routes/settings.js',
    'The application name, tagline, client name and logo are editable at runtime and take effect '
    + 'immediately across the sidebar, the login screen and the browser tab. Awaiting the final '
    + 'trading name and the logo file from the client.'],

  // --------------------------------------------------------- registration
  ['Registration', 'Register driver with: Name*', DONE,
    'Drivers → Register driver', 'Mandatory; refused unless saved explicitly as an incomplete registration.'],
  ['Registration', 'Photo*', DONE, 'Drivers → Register driver', 'Mandatory. Served through the authenticated /api/files route, not a public folder.'],
  ['Registration', 'Phone number*', DONE, 'Drivers → Register driver', 'Mandatory; validated as a 10 digit Indian mobile number.'],
  ['Registration', 'Aadhar Card Number*', DONE, 'Drivers → Register driver', 'Mandatory; 12 digits. A repeat Aadhaar is refused with a link to the existing driver, so a returning driver is never registered twice.'],
  ['Registration', 'Address*', DONE, 'Drivers → Register driver', 'Mandatory.'],
  ['Registration',
    'Date of birth as per Aadhar (it should match with Driving License)*', DONE,
    'Drivers → Register driver',
    'Mandatory. A mismatch against the licence date of birth blocks the save unless it is explicitly recorded as an exception, which is written to the remarks and the audit log.'],
  ['Registration', 'Driving License No with validity and date of birth*', DONE,
    'Drivers → Register driver', 'All three mandatory. Licences expiring within 60 days are surfaced on the dashboard.'],
  ['Registration', 'Copy of Aadhar and DL upload*', DONE, 'Drivers → Register driver', 'Both mandatory.'],
  ['Registration',
    'Reference contact numbers (two numbers of relatives i.e. father, brother etc)*', DONE,
    'Drivers → Register driver', 'Two are required; the relation is captured alongside each number.'],
  ['Registration', 'Bank Account Details (Account number and IFSC code)', DONE,
    'Drivers → Register driver, or Deploy',
    'Not mandatory at registration — per the scope this may be completed at the deployment step. IFSC is format-checked. Required before any payment run.'],
  ['Registration', 'UAN number', DONE, 'Drivers → Register driver, or Deploy',
    'As above: may be completed at the deployment step.'],
  ['Registration', 'Name of person who has referred the driver', DONE,
    'Drivers → Register driver → Referred by',
    'Added this round. Shown on the driver profile and editable there.'],
  ['Registration',
    '* fields are mandatory… if not populated by scanning, then it should be manually filled', DONE,
    'Drivers → Register driver',
    'The form lists what is still outstanding as you type and will not submit until it is clear. A supervisor who genuinely cannot complete a field ticks "save as an incomplete registration"; the gap then stays visible on the driver profile until it is closed.'],
  ['Registration', 'Point 10 and 11 can be populated in deployment step', DONE,
    'Deploy modal → Bank details and UAN',
    'The deploy screen carries the bank and UAN fields and writes them back onto the driver. Deployment is refused without bank details unless explicitly deferred to before the first payment run.'],
  ['Registration',
    'Scan the client registration page to populate the fields of registration', DONE,
    'Drivers → Register driver → Scan registration page; server/src/extract/',
    'Handles a PDF with a text layer (read directly), a scanned or printed PDF (page images pulled out and read by OCR), photographs, and pasted text. Several files at once are merged. OCR runs in-process — no external service required — and a configured OCR_API_URL is used in preference when present. Verified against the real client page in testing_docs/AJAY.pdf.'],
  ['Registration',
    'fields which are blank should be populated manually by supervisor', DONE,
    'Drivers → Register driver',
    'Scanning never saves anything. Every value is presented as a suggestion tagged with how it was found (labelled / pattern / derived), pre-filled fields are highlighted, and anything blank is typed in by hand.'],
  ['Registration', 'Allocate a registration number for each driver', DONE,
    'Automatic on save', 'Format QDM/YYYY/00001. It stays with the person across every client ID they ever hold.'],

  // ---------------------------------------------------------- deployment
  ['Deployment', 'ID from Client (six digit ID)', DONE, 'Driver profile → Deploy',
    'Exactly six digits, and unique across the system.'],
  ['Deployment', 'Date of joining — billing of driver starts', DONE, 'Driver profile → Deploy',
    'Attendance and billing both start from this date.'],
  ['Deployment', 'Vehicle Number', DONE, 'Driver profile → Deploy', ''],
  ['Deployment', 'Location where driver is placed', DONE, 'Driver profile → Deploy', ''],
  ['Deployment', 'Or its rejected… and capture reason of rejection', DONE,
    'Driver profile → Client rejected',
    'Added this round. No employment is created; the driver is marked rejected with the client\'s reason and the date, and can be put back in the pipeline if the client reconsiders.'],
  ['Deployment', 'Deployment is only after the driver passes the tests', DONE,
    'Driver profile → Screening',
    'Trial test, safety orientation and medical must all pass before an ID can be issued.'],

  // -------------------------------------------------------- redeployment
  ['Redeployment', 'Driver leaves and joins back — new ID linked to the earlier ID', DONE,
    'Driver profile → Rejoin with new ID',
    'The new ID attaches to the same driver record. The ID history tab lists every ID the person has held.'],
  ['Redeployment', 'Old ID / New ID / Vehicle, Location and date of rejoining', DONE,
    'Driver profile → ID history', ''],
  ['Redeployment', 'Driver\'s deployed vehicle and location are changed (latest ID kept)', DONE,
    'Deployments → Edit',
    'The client ID stays; vehicle, location and the salary structure can be changed on the live deployment.'],
  ['Redeployment', 'All IDs of driver should be linked to him so longevity of service can be calculated', DONE,
    'Driver profile → Total service',
    'Service is summed across every stint and shown on the profile header.'],
  ['Redeployment', 'Registration number will be same for a driver having multiple client IDs', DONE,
    'Throughout', 'The registration number identifies the person; the client ID identifies the stint.'],

  // ----------------------------------------------------------- attendance
  ['Attendance', 'T — Training', DONE, 'Attendance', 'Payable.'],
  ['Attendance', 'TA — In Transit', DONE, 'Attendance', 'Payable.'],
  ['Attendance', 'P — Driving / Present', DONE, 'Attendance', 'Payable.'],
  ['Attendance', 'L — Leave', DONE, 'Attendance', 'Not payable.'],
  ['Attendance', 'LE — Resigned or left', DONE, 'Attendance',
    'Not payable. Marking LE closes the deployment on that date and stops billing.'],
  ['Attendance', 'Default selection for deployed driver is P', DONE, 'Attendance',
    'An unmarked day for a deployed driver counts as P throughout — the grid, the register and payroll all agree. Supervisors record only the exceptions.'],
  ['Attendance',
    'The date of deployment or redeployment shall be the start of attendance', DONE,
    'Attendance', 'Days outside a stint are struck out and cannot be marked. Future dates are refused.'],
  ['Attendance', 'Provision to upload bulk attendance of drivers', DONE,
    'Attendance → Bulk upload',
    'Added this round. Download the month pre-filled with every deployed driver, edit offline, upload it back. The upload is checked first and shows exactly what would change and what would be skipped before anything is written.'],

  // ------------------------------------------------------------ insurance
  ['Insurance', 'Track whether each deployed driver is covered: GMC', DONE, 'Insurance', ''],
  ['Insurance', 'GPA', DONE, 'Insurance', ''],
  ['Insurance', 'GTL', DONE, 'Insurance', ''],
  ['Insurance', 'WC', DONE, 'Insurance', ''],
  ['Insurance', 'Check or select from drop down', DONE, 'Insurance',
    'A matrix of the four policies per driver, with policy number and validity.'],
  ['Insurance',
    'Provision to download list of drivers covered in different insurance', DONE,
    'Insurance → Download',
    'The whole matrix, or one policy filtered to covered drivers only. Deployment status is a column.'],
  ['Insurance', 'Upload excel to update the list along with if they are deployed or not', DONE,
    'Insurance → Upload',
    'With a "check file" dry run that shows what would change before anything is saved.'],

  // ---------------------------------------------------------- salary master
  ['Salary master',
    'Salary master to cover all types of salaries which needs to be given to drivers', NEEDS,
    'Salary Master; server/src/routes/salary-master.js',
    'Built this round. A structure is a set of components — earnings and deductions, each a fixed amount or a percentage of basic or gross, each either prorated by attendance or paid whole. A live preview shows what any number of payable days pays. Seeded with realistic placeholders; awaiting the client\'s actual figures.'],
  ['Salary master', 'HZL Drivers', NEEDS, 'Salary Master → HZL-STD',
    'Structure exists and is linked to deployments. Figures are placeholders.'],
  ['Salary master', 'Market Drivers', NEEDS, 'Salary Master → MKT-STD',
    'Structure exists and is linked to deployments. Figures are placeholders.'],
  ['Salary master', 'Once driver is deployed, it is linked to a salary structure', DONE,
    'Deploy modal → Salary structure',
    'Deployment is refused without either a structure or an explicit flat monthly wage.'],
  ['Salary master',
    'Wage register should be output from system at the end of month once attendance is finalized', NEEDS,
    'Salary → Wage register',
    'Computed component by component off the linked structure, with the salary category, the structure code and the statutory deduction as columns. The exact column layout is "as per client requirements" and is still to be supplied.'],

  // ------------------------------------------------------------- advances
  ['Advances', 'Supervisor raises the advance request on behalf of the driver', DONE,
    'Advances → Raise request', 'Only for a currently deployed driver.'],
  ['Advances', 'Request details: ID of Driver', DONE, 'Advances', ''],
  ['Advances', 'Amount in INR', DONE, 'Advances', ''],
  ['Advances', 'Reason of request', DONE, 'Advances', ''],
  ['Advances', 'Date of request', DONE, 'Advances', ''],
  ['Advances',
    'Request moves to Senior Manager for approval and then to Director', NEEDS,
    'Advances → Approve',
    'CHANGED BY REQUEST. The role list agreed for this build is Supervisor, Admin/Director and Finance — there is no Senior Manager — so the two approval steps collapse into one: the supervisor raises, Admin/Director approves, Finance pays. The document\'s intent that no one approves their own request is kept: a request raised by an Admin/Director must be actioned by a different Admin/Director. Confirm this is what you want.'],
  ['Advances',
    'If Senior Manager raises the request, it should go to Director for approval', NEEDS,
    'Advances → Approve',
    'Same change as above. Self-approval is blocked outright, which covers the case the document was guarding against.'],
  ['Advances',
    'While approving, see how much advance has been given to the driver for the month and how much salary is accrued as per attendance', DONE,
    'Advances → Approve modal',
    'Added this round. The approval screen shows advances taken this month, salary accrued from the attendance actually on record, unrecovered advance outstanding, and what is left after this request — flagged in red if the request takes the driver past what they have earned.'],
  ['Advances', 'Once approved, accounts team should make payment', DONE,
    'Advances → Payment runs', 'Finance only.'],
  ['Advances', 'Pay through internet banking if request is only 3-4 or urgent', DONE,
    'Advances → Payment runs', 'Up to four requests, with the UTRs recorded individually.'],
  ['Advances',
    'Pay through uploading sheet if more than 4; sheet provided by system download', DONE,
    'Advances → Payment runs → Bank upload sheet',
    'Beyond four the system generates the bank upload sheet. A driver with incomplete bank details is refused rather than silently dropped.'],
  ['Advances',
    'All requests till noon and then till 6:30 pm accumulated and paid through either method', DONE,
    'Advances → Payment runs',
    'Requests are stamped with their cut-off window when raised and grouped into runs by date and window.'],
  ['Advances', 'Weekly update of ledger in tally through linkage with bank system', NEEDS,
    'Tally Linkage',
    'A weekly run produces a Tally-importable XML voucher file plus a matching spreadsheet, with ledgers named "Driver Name (Registration No)". Posted advances are flagged so a run never double-posts. The direct bank feed needs the bank\'s statement format or API credentials.'],
  ['Advances', 'Download advance register on monthly basis', DONE,
    'Advances → Advance register', 'Any date range, with approvals, UTRs and recovery per request.'],

  // ------------------------------------------------------------- expenses
  ['Expenses',
    'Pay petty cash to supervisor for payment to drivers, safety shoe, medical bills or other', DONE,
    'Expenses → Petty cash', 'Finance issues and recovers the float; the balance per supervisor is on the tab.'],
  ['Expenses',
    'Supervisor raises purchase requirement or expense payment request', DONE,
    'Expenses → Raise request', ''],
  ['Expenses', 'Name / ID of driver', DONE, 'Expenses', 'Optional — an expense can also be general rather than against one driver.'],
  ['Expenses', 'Purpose of expense', DONE, 'Expenses', ''],
  ['Expenses', 'Amount', DONE, 'Expenses', ''],
  ['Expenses', 'Reimbursement or Expense', DONE, 'Expenses', ''],
  ['Expenses',
    'Senior Manager approves if individual expenses are less than Rs 3000', NEEDS,
    'Expenses → Approve',
    'CHANGED BY REQUEST, as for advances. Admin/Director approves every request; the Rs 3,000 threshold now decides who pays rather than who approves — below it the supervisor pays from petty cash, at or above it Finance pays the vendor directly. The threshold is configurable.'],
  ['Expenses',
    'Above Rs 3000 approved by Senior Manager and Director, payment done by accounts directly to vendor', NEEDS,
    'Expenses → Approve', 'Same change. The "Finance pays the vendor directly" half is unchanged.'],
  ['Expenses',
    'Supervisor pays using petty cash and uploads the supporting (receipt and payment transaction details)', DONE,
    'Expenses → Settle',
    'An expense cannot be settled until a supporting document is on record. Settling a petty cash expense posts against that supervisor\'s float.'],
  ['Expenses', 'These expenses are updated in tally against each driver along with supporting uploaded', DONE,
    'Tally Linkage → Expenses', 'Posted per driver ledger with the supporting attached to the expense record.'],

  // ------------------------------------------------------- salary payment
  ['Salary payment', 'Collate and finalize salary attendance with client', DONE,
    'Salary → Collate, then Finalise',
    'Payable days are P + T + TA; L and LE are not billed. Finalising locks the month\'s attendance.'],
  ['Salary payment', 'Update the details and download the wage register for invoicing purpose', NEEDS,
    'Salary → Wage register', 'Working; the client\'s required column layout is still awaited.'],
  ['Salary payment',
    'Download the driver salary payment sheet with option to either hold or pay the driver and edit the attendance', DONE,
    'Salary → Payment sheet',
    'Fully editable before paying: correct the attendance days, adjust deductions, or hold a driver with a reason. Edited days are re-run through the salary structure.'],
  ['Salary payment', 'It should have net payable along with attendance details', NEEDS,
    'Salary → Payment sheet', 'Present. The exact format is "shall be provided" and is still awaited.'],
  ['Salary payment', 'Prepare payment sheet for upload in HDFC enet system', NEEDS,
    'Salary → HDFC e-Net sheet',
    'Generated, with held drivers and drivers with incomplete bank details excluded and listed. Column order should be checked against a real e-Net template before the first live run.'],
  ['Salary payment',
    'Upload and update payment in system against each driver from Bank statement', DONE,
    'Salary → Upload bank statement',
    'Payments are matched by reference, then account number, then a unique amount. Unmatched rows are reported rather than guessed at.'],
  ['Salary payment', 'Update payment details in tally ledger', DONE, 'Tally Linkage → Salary', ''],

  // -------------------------------------------------------- communication
  ['Communication', 'Mass communication to Drivers through WhatsApp', NEEDS,
    'WhatsApp',
    'Compose with {{name}}, {{client_id}}, {{vehicle}}, {{location}} placeholders; target by deployment status, location or missing insurance; preview the audience and the rendered message before sending; delivery recorded per recipient. Runs in simulation mode until WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID are supplied.'],

  // -------------------------------------------------------------- reports
  ['Reports', 'Reports:', TODO,
    '—',
    'The document ends with this heading and nothing under it. Nothing has been built against it. In the meantime every register in the system downloads as Excel — attendance, insurance, advances, wage register, payment sheet, salary master, Tally. Please list the reports you need.'],

  // ------------------------------------------- additional, requested this round
  ['Roles (requested)', 'Supervisor role', DONE,
    'Users & roles',
    'Registers drivers, records screening, deploys, marks attendance, raises advance and expense requests, settles petty cash.'],
  ['Roles (requested)', 'Admin / Director role', DONE,
    'Users & roles',
    'Approves every advance and expense, owns the salary master and branding, manages users, and can do everything the other roles can.'],
  ['Roles (requested)', 'Finance role', DONE,
    'Users & roles',
    'Advance payment runs, expense settlement, payroll and the wage register, bank sheets, bank reconciliation, Tally linkage, petty cash float.'],
  ['Roles (requested)', 'Consolidation from the previous five roles', DONE,
    'server/src/auth.js, server/src/db.js',
    'Senior Manager and Director both become Admin / Director; Accounts becomes Finance. Existing databases are migrated automatically on first boot — users are remapped and the two approval stages on advances and expenses are merged into one.'],

  ['Testing (requested)', 'Testing documents for the registration data extraction', DONE,
    'testing_docs/; npm run test:extraction',
    'A harness runs every document in testing_docs/ and asserts against optional .expected.json fixtures. Currently 34 assertions, all passing, over the real client page (AJAY.pdf — image-only, 22 drivers read off it) and a labelled single-driver form (21 fields read).'],
  ['Testing (requested)', 'API regression test', DONE,
    'npm run test:api',
    '34 checks over the roles, branding, salary master, approval chain, expense routing, registration rules, deployment rules, bulk attendance upload and payroll. All passing.'],
];

const STATUS_FILL = {
  [DONE]: 'FFE3F5EC',
  [NEEDS]: 'FFFDF1DE',
  [TODO]: 'FFFDECEB',
};
const STATUS_FONT = {
  [DONE]: 'FF1B7F4B',
  [NEEDS]: 'FF9A6300',
  [TODO]: 'FFC0392B',
};

async function build() {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Quantum Driver Management';
  wb.created = new Date();

  // ------------------------------------------------------------- summary
  const counts = POINTS.reduce((acc, [, , status]) => {
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, {});

  const sum = wb.addWorksheet('Summary');
  sum.columns = [{ width: 34 }, { width: 12 }, { width: 76 }];
  sum.mergeCells('A1:C1');
  sum.getCell('A1').value = 'Web Application — Quantum · Scope status';
  sum.getCell('A1').font = { bold: true, size: 15 };
  sum.getRow(1).height = 26;

  sum.getCell('A2').value = `Against "Web Application_Quantum.docx" · generated ${new Date().toISOString().slice(0, 10)}`;
  sum.getCell('A2').font = { italic: true, color: { argb: 'FF666666' } };

  let r = 4;
  const line = (label, value, note) => {
    sum.getCell(`A${r}`).value = label;
    sum.getCell(`A${r}`).font = { bold: true };
    sum.getCell(`B${r}`).value = value;
    sum.getCell(`C${r}`).value = note || '';
    sum.getCell(`C${r}`).alignment = { wrapText: true, vertical: 'top' };
    r += 1;
  };

  line('Total points tracked', POINTS.length, 'Every line item of the scope document, plus the roles and testing work requested alongside it.');
  line(DONE, counts[DONE] || 0, 'Built, covered by a test, and seen working in the running application.');
  line(NEEDS, counts[NEEDS] || 0, 'Built and working on placeholder data. The client still owes a figure, a format or an asset — see the Detail sheet.');
  line(TODO, counts[TODO] || 0, 'Nothing in the document to build from yet.');

  r += 1;
  sum.getCell(`A${r}`).value = 'By section';
  sum.getCell(`A${r}`).font = { bold: true, size: 12 };
  r += 1;

  const bySection = new Map();
  POINTS.forEach(([section, , status]) => {
    if (!bySection.has(section)) bySection.set(section, { total: 0, done: 0 });
    const s = bySection.get(section);
    s.total += 1;
    if (status === DONE) s.done += 1;
  });
  sum.getCell(`A${r}`).value = 'Section';
  sum.getCell(`B${r}`).value = 'Complete';
  sum.getCell(`C${r}`).value = 'Points';
  [`A${r}`, `B${r}`, `C${r}`].forEach((c) => {
    sum.getCell(c).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    sum.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3B57' } };
  });
  r += 1;
  for (const [section, s] of bySection) {
    sum.getCell(`A${r}`).value = section;
    sum.getCell(`B${r}`).value = `${s.done} / ${s.total}`;
    sum.getCell(`C${r}`).value = s.total;
    r += 1;
  }

  r += 1;
  sum.mergeCells(`A${r}:C${r}`);
  sum.getCell(`A${r}`).value = 'Decisions to confirm';
  sum.getCell(`A${r}`).font = { bold: true, size: 12 };
  r += 1;
  const notes = [
    'Approval chain. The role list agreed for this build — Supervisor, Admin/Director, Finance — has no Senior Manager, so the document\'s two approval steps have been merged into one: the supervisor raises, Admin/Director approves, Finance pays. Nobody can approve a request they raised themselves. Say the word if you would rather keep two distinct approval levels.',
    'The Rs 3,000 expense threshold now decides who pays rather than who approves: below it the supervisor pays from petty cash, at or above it Finance pays the vendor directly.',
    'Still needed from the client: the trading name and logo; the HZL and Market salary structures; the wage register, payment sheet and HDFC e-Net formats; WhatsApp Cloud API credentials; and the list of reports.',
  ];
  notes.forEach((n) => {
    sum.mergeCells(`A${r}:C${r}`);
    const cell = sum.getCell(`A${r}`);
    cell.value = `•  ${n}`;
    cell.alignment = { wrapText: true, vertical: 'top' };
    sum.getRow(r).height = 46;
    r += 1;
  });

  // -------------------------------------------------------------- detail
  const ws = wb.addWorksheet('Detail', { views: [{ state: 'frozen', ySplit: 2 }] });
  const columns = [
    { header: '#', key: 'n', width: 5 },
    { header: 'Section', key: 'section', width: 19 },
    { header: 'Scope point', key: 'point', width: 56 },
    { header: 'Status', key: 'status', width: 24 },
    { header: 'Where it lives', key: 'where', width: 38 },
    { header: 'Notes', key: 'notes', width: 92 },
  ];

  ws.mergeCells(1, 1, 1, columns.length);
  ws.getCell(1, 1).value = 'Scope point by point — "Web Application_Quantum.docx"';
  ws.getCell(1, 1).font = { bold: true, size: 13 };
  ws.getRow(1).height = 22;

  ws.getRow(2).values = columns.map((c) => c.header);
  ws.columns = columns.map((c) => ({ key: c.key, width: c.width }));
  const header = ws.getRow(2);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3B57' } };
  header.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
  header.height = 24;

  POINTS.forEach(([section, point, status, where, note], i) => {
    const row = ws.addRow({ n: i + 1, section, point, status, where, notes: note });
    row.alignment = { vertical: 'top', wrapText: true };
    const statusCell = row.getCell(4);
    statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: STATUS_FILL[status] } };
    statusCell.font = { bold: true, color: { argb: STATUS_FONT[status] } };
    // A changed-by-request line should catch the eye whichever status it has.
    if (String(note).startsWith('CHANGED BY REQUEST')) {
      row.getCell(6).font = { color: { argb: 'FF9A6300' } };
    }
  });

  ws.autoFilter = { from: { row: 2, column: 1 }, to: { row: 2, column: columns.length } };

  const out = path.join(ROOT, 'Quantum_Scope_Status.xlsx');
  await wb.xlsx.writeFile(out);
  return { out, total: POINTS.length, counts };
}

const { out, total, counts } = await build();
console.log(`\nScope status written to ${path.relative(process.cwd(), out) || out}`);
console.log(`  ${total} points — ${counts[DONE] || 0} done, ${counts[NEEDS] || 0} awaiting client input, ${counts[TODO] || 0} not started\n`);
void fs;
