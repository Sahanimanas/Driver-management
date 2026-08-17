# Quantum — Driver Attendance & Management

A React + Express web application implementing the scope in
`Web Application_Quantum.docx`: driver registration, screening, deployment,
attendance, insurance, advances, expenses, salary, Tally linkage and WhatsApp
broadcasts.

## Running it

```bash
npm run install:all     # installs server + web dependencies
npm run seed            # creates the database with demo data
npm run dev             # API on :4000, web on :5173
```

Open http://localhost:5173 and sign in with any demo account
(password `Quantum@123`):

| Role | Email |
| --- | --- |
| Supervisor | `supervisor@quantum.test` |
| Senior Manager | `manager@quantum.test` |
| Director | `director@quantum.test` |
| Accounts | `accounts@quantum.test` |
| Administrator | `admin@quantum.test` |

For a single-origin production run: `npm run build && npm start` serves the
built app and the API together on port 4000.

Configuration is optional — see `server/.env.example`. Everything works out of
the box; WhatsApp runs in simulation mode and page-scanning falls back to
pasted text until you supply credentials.

## Stack

- **Server** — Express 4, SQLite via Node's built-in `node:sqlite` (no native
  build step), JWT auth with bcrypt, multer uploads, ExcelJS for every
  register/sheet.
- **Web** — React 18, Vite, React Router. No UI framework; the styling is one
  hand-written stylesheet.
- **Data** — `server/data/quantum.db`, uploads under `server/data/uploads/`.

## How the scope maps to the app

### Registration
`Drivers → Register driver` captures name, photo, phone, Aadhar, address, date
of birth, driving licence with validity, copies of the Aadhar and licence, two
reference contacts, bank details and UAN. A registration number
(`QDM/YYYY/00001`) is allotted on save.

- The Aadhar date of birth is checked against the date of birth on the licence.
  A mismatch is blocked unless it is explicitly recorded as an exception.
- A repeated Aadhar number is refused with a link to the existing record, so a
  returning driver is never registered twice.
- **Scan the registration page** uploads the client's page and pre-fills the
  form. With `OCR_API_URL` configured the image is read automatically;
  otherwise paste the page text and labelled fields are extracted. Pre-filled
  fields are highlighted for verification.

### Screening and deployment
Every registration opens a checklist — trial test, safety orientation, medical.
Deployment is blocked until all three pass. Deployment records the six digit
client ID, date of joining (billing starts here), vehicle number and location.

### Rejoining, and linked IDs
When a driver leaves and returns, the client issues a **new** six digit ID. It
is attached to the same driver record, so the *ID history* tab lists every ID
the person has held and total service is summed across all stints. Ending a
deployment marks that day `LE` in the register and stops billing.

### Attendance
A month grid, one row per deployed driver. Codes are `T` Training, `TA` In
Transit, `P` Driving/Present, `L` Leave, `LE` Resigned or Left. **An unmarked
day for a deployed driver counts as `P`** — supervisors only record the
exceptions. Click a cell to cycle the code, or fill a date range in one go.
Days outside a deployment are struck out, future dates are refused, and a
closed payroll locks the month. Exportable as an attendance register.

### Insurance
A matrix of GMC / GPA / GTL / WC per deployed driver with policy number and
validity. Download the list (whole matrix, or one policy filtered to covered
drivers only), edit in Excel, and upload it back — with a **Check file** dry run
that shows what would change before anything is saved.

### Advances
Supervisor raises on the driver's behalf (driver ID, amount, reason, date) →
Senior Manager → Director → accounts pay. A request raised by a Senior Manager
skips to the Director; nobody can approve their own request.

Approved requests accumulate to the **noon** and **18:30** cut-offs. A run of up
to four requests is paid through internet banking and the UTRs recorded
individually; beyond four the system generates a bank upload sheet. The
**advance register** downloads for any date range, and paid advances are
recovered automatically from the next salary.

### Expenses and petty cash
Supervisors raise purchase requirements and reimbursements against a driver or
generally. Below ₹3,000 the Senior Manager is the final approver, the supervisor
pays from petty cash and uploads the receipt and payment proof; at ₹3,000 and
above the Director also approves and accounts pay directly. **An expense cannot
be settled until a supporting document is on record**, and settling a petty cash
expense posts against the supervisor's float. Accounts issue and recover the
float; balances per supervisor are on the Petty cash tab.

### Salary
1. **Collate** the month from the attendance on record — payable days are
   `P + T + TA`; `L` and `LE` are not billed. Outstanding advances are pulled in
   as a recovery.
2. **Finalise** the attendance with the client.
3. **Wage register** downloads for invoicing.
4. **HDFC e-Net sheet** for the bulk payment upload — held drivers and drivers
   with incomplete bank details are excluded and listed.
5. **Record payments** by hand, or **upload the bank statement** and payments
   are matched by reference, then account number, then a unique amount.
6. **Close** the month, which locks the attendance register.

The payment sheet is fully editable before paying: correct attendance days,
adjust deductions, or put a driver on hold with a reason.

### Tally linkage
Weekly posting of advances, expenses and salary. Each run produces a
Tally-importable XML voucher file plus a matching spreadsheet for checking.
Ledgers are named `Driver Name (Registration No)` so entries reconcile to a
driver, and posted advances are flagged so a weekly run never double-posts.

### WhatsApp broadcasts
Compose with `{{name}}`, `{{client_id}}`, `{{vehicle}}`, `{{location}}`
placeholders, target by deployment status, location or missing insurance, and
preview the audience and the rendered message before sending. Delivery is per
recipient with failures recorded. Set `WHATSAPP_TOKEN` and
`WHATSAPP_PHONE_NUMBER_ID` to send through the Meta Cloud API; without them the
flow runs in simulation mode.

## Roles

| Role | Can do |
| --- | --- |
| Supervisor | Register drivers, record screening, deploy, mark attendance, raise advance and expense requests, settle petty cash |
| Senior Manager | First approval on advances; final approval on expenses below the threshold; everything a supervisor can do |
| Director | Final approval on advances and on expenses at or above the threshold |
| Accounts | Payment runs, salary, bank sheets, bank reconciliation, Tally linkage, petty cash float |
| Administrator | All of the above plus user management |

## Notes on the implementation

- Driver documents are personal identity records, so they are **not** served
  from a static folder. Every file goes through an authenticated
  `/api/files/:id` route.
- Every state change writes to an audit log (`GET /api/audit`).
- Money is stored to two decimals and all approval, payment and payroll
  mutations run inside transactions.
- `server/src/seed.js` is safe to re-run; it clears operational tables and
  rebuilds the demo data, including drivers who left and rejoined on a second
  client ID.
