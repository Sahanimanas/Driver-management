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
| Admin / Director | `director@quantum.test` |
| Finance | `finance@quantum.test` |

There is a second Admin / Director account, `admin@quantum.test`, because
nobody may approve a request they raised themselves.

## Checking it

```bash
npm run test:api          # 34 API checks against a running server
npm run test:extraction   # registration data extraction over testing_docs/
npm run scope-status      # regenerate Quantum_Scope_Status.xlsx
```

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
- The **person who referred the driver** is captured, and the starred fields of
  the scope are enforced — the form will not submit while one is blank unless
  the supervisor explicitly saves an incomplete registration, in which case the
  gap stays visible on the driver profile.
- **Bank details and the UAN may instead be completed at the deployment step**,
  as the scope allows.

### Scanning the client registration page
`Register driver → Scan registration page` takes PDFs, photographs and pasted
text — several files at once, merged into one draft. What happens depends on
what the file actually is:

| Input | How it is read |
| --- | --- |
| PDF with a text layer | Read straight off it. Instant, exact, no OCR. |
| PDF without one (a scan, or "Print to PDF") | Embedded page images are pulled out and read by OCR |
| An image | Read by OCR |
| Pasted text | Parsed as-is — the fallback that always works |

OCR runs in-process, so this works with no external service; set `OCR_API_URL`
to prefer a remote one. A client page that lists many drivers comes back as a
**pick-list** — choose the driver being registered and the form fills in.

Every value is a *suggestion*, tagged with how it was found (`labelled`,
`pattern`, `derived`) and highlighted in the form. Nothing is saved by scanning;
the supervisor checks it and types in whatever came back blank.

See [`testing_docs/README.md`](testing_docs/README.md) — `npm run test:extraction`
runs the extractor over the real client page and asserts the result.

### Screening and deployment
Every registration opens a checklist — trial test, safety orientation, medical.
Deployment is blocked until all three pass. Deployment records the six digit
client ID, date of joining (billing starts here), vehicle number and location.

### Rejoining, and linked IDs
When a driver leaves and returns, the client issues a **new** six digit ID. It
is attached to the same driver record, so the *ID history* tab lists every ID
the person has held and total service is summed across all stints. Ending a
deployment marks that day `LE` in the register and stops billing.

### Salary master
`Salary Master` holds the structures named in the scope — **HZL Drivers** and
**Market Drivers**. A structure is a set of components: earnings that build the
gross and deductions that come off the net, each a fixed amount or a percentage
of basic or of gross, and each either prorated by attendance or paid whole. A
live preview shows what any number of payable days pays, so a change can be
checked before a driver is on it.

Every deployment is linked to a structure, and the wage register is computed
component by component from it. The seeded figures are **placeholders** — replace
them with the structures the client supplies.

### Attendance
A month grid, one row per deployed driver. Codes are `T` Training, `TA` In
Transit, `P` Driving/Present, `L` Leave, `LE` Resigned or Left. **An unmarked
day for a deployed driver counts as `P`** — supervisors only record the
exceptions. Click a cell to cycle the code, or fill a date range in one go.
Days outside a deployment are struck out, future dates are refused, and a
closed payroll locks the month. Exportable as an attendance register.

**Bulk upload** downloads the month pre-filled with every deployed driver, and
takes the edited sheet back. The upload is checked first and reports exactly
what would change and what would be skipped, before anything is written.

### Insurance
A matrix of GMC / GPA / GTL / WC per deployed driver with policy number and
validity. Download the list (whole matrix, or one policy filtered to covered
drivers only), edit in Excel, and upload it back — with a **Check file** dry run
that shows what would change before anything is saved.

### Advances
Supervisor raises on the driver's behalf (driver ID, amount, reason, date) →
Admin / Director approves → Finance pays. Nobody can approve their own request.

While approving, the screen shows **what the driver has already taken this
month and what they have accrued from the attendance actually on record**,
along with the unrecovered balance and what is left after this request — in red
if it takes them past what they have earned.

Approved requests accumulate to the **noon** and **18:30** cut-offs. A run of up
to four requests is paid through internet banking and the UTRs recorded
individually; beyond four the system generates a bank upload sheet. The
**advance register** downloads for any date range, and paid advances are
recovered automatically from the next salary.

### Expenses and petty cash
Supervisors raise purchase requirements and reimbursements against a driver or
generally. Admin / Director approves either way; the ₹3,000 threshold then
decides **who pays** — below it the supervisor pays from petty cash and uploads
the receipt and payment proof, at or above it Finance pays the vendor directly. **An expense cannot
be settled until a supporting document is on record**, and settling a petty cash
expense posts against the supervisor's float. Finance issues and recovers the
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

### Branding and settings
`Settings` (Admin / Director only) carries the application name, tagline, client
name and logo, so the rename and the logo the scope opens with need no rebuild.
The same page states the business rules the server is enforcing — the expense
threshold, the payment cut-offs, the payable attendance codes — so they can be
checked against the scope document.

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

Three roles:

| Role | Can do |
| --- | --- |
| **Supervisor** | Register drivers, record screening, deploy, mark attendance, raise advance and expense requests, settle petty cash |
| **Admin / Director** | Approve every advance and expense, maintain the salary master and branding, manage users — and everything the other two roles can do |
| **Finance** | Advance payment runs, expense settlement, payroll and the wage register, bank upload sheets, bank reconciliation, Tally linkage, petty cash float |

The approval chain is therefore: supervisor raises → Admin / Director approves →
Finance pays. **Nobody can approve a request they raised themselves**, so a
request raised by an Admin / Director must be actioned by a different one.

> The scope document describes two approval levels (Senior Manager, then
> Director). Those collapse into one here because the agreed role list has no
> Senior Manager. The rule the document was protecting — that a request is never
> self-approved — is kept. See `Quantum_Scope_Status.xlsx`.

Databases created before this change migrate themselves on first boot: Senior
Manager and Director both become Admin / Director, Accounts becomes Finance, and
the two approval stages on existing advances and expenses are merged into one.

## Scope status

`Quantum_Scope_Status.xlsx` in the repository root tracks every point of the
scope document: what is done, what is working on placeholder data pending
something from the client, and what has not been started. Regenerate it with
`npm run scope-status`.

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
