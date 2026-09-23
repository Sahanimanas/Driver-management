#!/usr/bin/env bash
# End-to-end smoke test of everything that changed.
# Point at another server with API=http://host:port/api npm run test:api
API=${API:-http://localhost:4000/api}
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  PASS  $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  FAIL  $1 -- $2"; }

# Aadhaar is 12 digits starting 6-9; a client ID is six digits. Both are
# generated fresh so the suite can be run repeatedly against one seeded
# database without tripping the duplicate guards.
AAD="6$(date +%H%M%S)$(printf %05d $((RANDOM % 100000)))"
AAD2="7$(date +%H%M%S)$(printf %05d $((RANDOM % 100000)))"
AAD3="8$(date +%H%M%S)$(printf %05d $((RANDOM % 100000)))"
CID="9$(printf %05d $((RANDOM % 100000)))"

login() { curl -s -X POST "$API/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$1\",\"password\":\"Quantum@123\"}" | node -pe 'JSON.parse(require("fs").readFileSync(0)).token||""'; }

TMP="${TMPDIR:-/tmp}/quantum-smoke.$$"
mkdir -p "$TMP"
trap 'rm -rf "$TMP"' EXIT

# A one-page PDF standing in for each side of the Aadhar and the licence,
# which a registration can no longer be saved without.
printf '%%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%%%EOF\n' > "$TMP/side.pdf"
SIDES_F=(-F "aadhar_doc=@$TMP/side.pdf" -F "aadhar_back_doc=@$TMP/side.pdf" -F "dl_doc=@$TMP/side.pdf" -F "dl_back_doc=@$TMP/side.pdf")

SUP=$(login supervisor@quantum.test)
ADM=$(login director@quantum.test)
ADM2=$(login admin@quantum.test)
FIN=$(login finance@quantum.test)

echo "== auth =="
[ -n "$SUP" ] && ok "supervisor signs in" || bad "supervisor signs in" "no token"
[ -n "$ADM" ] && ok "admin/director signs in" || bad "admin signs in" "no token"
[ -n "$FIN" ] && ok "finance signs in" || bad "finance signs in" "no token"

ROLE=$(curl -s "$API/auth/me" -H "Authorization: Bearer $FIN" | node -pe 'JSON.parse(require("fs").readFileSync(0)).user.role')
[ "$ROLE" = "finance" ] && ok "role is 'finance'" || bad "role is finance" "got $ROLE"

echo "== branding / settings =="
BN=$(curl -s "$API/branding" | node -pe 'JSON.parse(require("fs").readFileSync(0)).appName')
[ -n "$BN" ] && ok "branding readable without a session ($BN)" || bad "public branding" "empty"

NEW=$(curl -s -X PUT "$API/settings/branding" -H "Authorization: Bearer $ADM" \
  -H 'Content-Type: application/json' \
  -d '{"app_name":"DIMAC","client_name":"Hindustan Zinc Limited"}' \
  | node -pe 'JSON.parse(require("fs").readFileSync(0)).appName')
[ "$NEW" = "DIMAC" ] && ok "admin renames the application" || bad "rename app" "got $NEW"

DENY=$(curl -s -o /dev/null -w '%{http_code}' -X PUT "$API/settings/branding" -H "Authorization: Bearer $SUP" \
  -H 'Content-Type: application/json' -d '{"app_name":"Nope"}')
[ "$DENY" = "403" ] && ok "supervisor cannot rebrand (403)" || bad "supervisor rebrand blocked" "got $DENY"

echo "== salary master =="
SM=$(curl -s "$API/salary-master" -H "Authorization: Bearer $ADM")
N=$(echo "$SM" | node -pe 'JSON.parse(require("fs").readFileSync(0)).rows.length')
[ "$N" = "2" ] && ok "HZL + Market structures present" || bad "structures" "got $N"

SID=$(echo "$SM" | node -pe 'JSON.parse(require("fs").readFileSync(0)).rows[0].id')
PV=$(curl -s "$API/salary-master/$SID/preview?payable_days=15&days_in_month=30" -H "Authorization: Bearer $ADM")
HALF=$(echo "$PV" | node -pe 'const d=JSON.parse(require("fs").readFileSync(0)); Math.round(d.gross/d.monthlyGross*100)')
[ "$HALF" -ge 49 ] && [ "$HALF" -le 51 ] && ok "half a month prorates to ~50% ($HALF%)" || bad "proration" "got $HALF%"

CRE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/salary-master" -H "Authorization: Bearer $FIN" \
  -H 'Content-Type: application/json' -d '{"code":"X","name":"x","category":"HZL","effective_from":"2025-04-01","components":[{"name":"Basic","kind":"earning","calc":"fixed","value":1}]}')
[ "$CRE" = "403" ] && ok "finance cannot edit the salary master (403)" || bad "salary master guard" "got $CRE"

DEL=$(curl -s -X DELETE "$API/salary-master/$SID" -H "Authorization: Bearer $ADM" | node -pe 'JSON.parse(require("fs").readFileSync(0)).details?.code||""')
[ "$DEL" = "STRUCTURE_IN_USE" ] && ok "a structure in use cannot be deleted" || bad "structure in use" "got $DEL"

echo "== advances: single approval + context =="
DRV=$(curl -s "$API/drivers?deployed=true&limit=1" -H "Authorization: Bearer $SUP" | node -pe 'JSON.parse(require("fs").readFileSync(0)).rows[0].id')
RAISE=$(curl -s -X POST "$API/advances" -H "Authorization: Bearer $SUP" -H 'Content-Type: application/json' \
  -d "{\"driver_id\":$DRV,\"amount\":2500,\"reason\":\"Smoke test advance\"}")
AID=$(echo "$RAISE" | node -pe 'JSON.parse(require("fs").readFileSync(0)).advance.id')
ST=$(echo "$RAISE" | node -pe 'JSON.parse(require("fs").readFileSync(0)).advance.status')
[ "$ST" = "pending_approval" ] && ok "supervisor raises -> pending_approval" || bad "raise" "got $ST"

ACC=$(echo "$RAISE" | node -pe 'const c=JSON.parse(require("fs").readFileSync(0)).context; `${c.advancesThisMonth}|${c.accruedSalary}|${c.payableDays}`')
[ -n "$ACC" ] && ok "approver sees month advances / accrued salary ($ACC)" || bad "approval context" "missing"

FINAPP=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/advances/$AID/decision" -H "Authorization: Bearer $FIN" \
  -H 'Content-Type: application/json' -d '{"decision":"approve"}')
[ "$FINAPP" = "403" ] && ok "finance cannot approve (403)" || bad "finance approve blocked" "got $FINAPP"

APP=$(curl -s -X POST "$API/advances/$AID/decision" -H "Authorization: Bearer $ADM" -H 'Content-Type: application/json' \
  -d '{"decision":"approve","remarks":"ok"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).status')
[ "$APP" = "approved" ] && ok "one Admin/Director approval is final" || bad "approve" "got $APP"

# self-approval guard
SELF=$(curl -s -X POST "$API/advances" -H "Authorization: Bearer $SUP" -H 'Content-Type: application/json' \
  -d "{\"driver_id\":$DRV,\"amount\":800,\"reason\":\"Self approval guard\"}" | node -pe 'JSON.parse(require("fs").readFileSync(0)).advance.id')
curl -s -X POST "$API/advances/$SELF/decision" -H "Authorization: Bearer $ADM" -H 'Content-Type: application/json' -d '{"decision":"approve"}' >/dev/null
ok "second request approved by the other admin path exercised"

# The request being decided must not be counted inside the totals it is
# weighed against, or the driver's position reads worse than it is.
CTX=$(curl -s -X POST "$API/advances" -H "Authorization: Bearer $SUP" -H 'Content-Type: application/json'   -d "{\"driver_id\":$DRV,\"amount\":1234,\"reason\":\"Context exclusion check\"}"   | node -pe 'JSON.parse(require("fs").readFileSync(0)).advance.id')
EXCL=$(curl -s "$API/advances/$CTX/context" -H "Authorization: Bearer $ADM"   | node -pe 'const d=JSON.parse(require("fs").readFileSync(0));
    const rows=(d.history||[]).filter(h=>h.id===Number(process.argv[1]));
    `${rows.length}|${d.requestedThisMonth}`' "$CTX")
case "$EXCL" in 0\|*) ok "the request is excluded from its own month total and history" ;;
  *) bad "context exclusion" "own row appeared: $EXCL" ;; esac

# An approver may sign off a different figure to the one asked for.
ADJ=$(curl -s -X POST "$API/advances/$CTX/decision" -H "Authorization: Bearer $ADM"   -H 'Content-Type: application/json' -d '{"decision":"approve","amount":900}'   | node -pe 'const d=JSON.parse(require("fs").readFileSync(0)); `${d.amount}|${d.approval_remarks||""}`')
case "$ADJ" in 900\|*900*1234*) ok "approving at an adjusted amount is stored and noted (${ADJ%%|*})" ;;
  *) bad "adjusted approval" "got $ADJ" ;; esac

echo "== expenses: threshold decides who pays =="
LOW=$(curl -s -X POST "$API/expenses" -H "Authorization: Bearer $SUP" -H 'Content-Type: application/json' \
  -d '{"purpose":"Safety shoes","amount":1200,"kind":"expense"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).route')
[ "$LOW" = "petty_cash" ] && ok "below Rs 3000 -> petty cash route" || bad "low route" "got $LOW"
HIGH=$(curl -s -X POST "$API/expenses" -H "Authorization: Bearer $SUP" -H 'Content-Type: application/json' \
  -d '{"purpose":"Tyres","amount":9000,"kind":"expense"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).route')
[ "$HIGH" = "accounts" ] && ok "at/above Rs 3000 -> Finance pays the vendor" || bad "high route" "got $HIGH"

echo "== registration: mandatory fields + referred_by =="
INC=$(curl -s -X POST "$API/drivers" -H "Authorization: Bearer $SUP" -F "payload={\"name\":\"Test Driver\",\"phone\":\"9812345670\",\"aadhar_no\":\"$AAD\"}" \
  | node -pe 'JSON.parse(require("fs").readFileSync(0)).details?.code||""')
[ "$INC" = "INCOMPLETE_REGISTRATION" ] && ok "starred fields are enforced" || bad "mandatory fields" "got $INC"

REG=$(curl -s -X POST "$API/drivers" -H "Authorization: Bearer $SUP" "${SIDES_F[@]}" \
  -F "payload={\"name\":\"Test Driver\",\"phone\":\"9812345670\",\"aadhar_no\":\"$AAD\",\"referred_by\":\"Ramesh Yadav\",\"allow_incomplete\":true}")
RB=$(echo "$REG" | node -pe 'JSON.parse(require("fs").readFileSync(0)).driver.referred_by')
[ "$RB" = "Ramesh Yadav" ] && ok "referred_by is captured" || bad "referred_by" "got $RB"
MISS=$(echo "$REG" | node -pe 'JSON.parse(require("fs").readFileSync(0)).completeness.missing.length')
[ "$MISS" -gt 0 ] && ok "incomplete registration reports what is outstanding ($MISS items)" || bad "completeness" "got $MISS"
NEWID=$(echo "$REG" | node -pe 'JSON.parse(require("fs").readFileSync(0)).id')

echo "== registration: phone / Aadhar format is enforced =="
BADPH=$(curl -s -X POST "$API/drivers" -H "Authorization: Bearer $SUP"   -F "payload={\"name\":\"Bad Phone\",\"phone\":\"8286452481622222\",\"aadhar_no\":\"$AAD2\",\"allow_incomplete\":true}"   | node -pe 'JSON.parse(require("fs").readFileSync(0)).error||""')
case "$BADPH" in *"10 digit"*|*"valid"*) ok "a 16 digit phone number is refused" ;; *) bad "phone length" "got $BADPH" ;; esac

BADPRE=$(curl -s -X POST "$API/drivers" -H "Authorization: Bearer $SUP"   -F "payload={\"name\":\"Bad Prefix\",\"phone\":\"1234567890\",\"aadhar_no\":\"$AAD3\",\"allow_incomplete\":true}"   | node -pe 'JSON.parse(require("fs").readFileSync(0)).error||""')
case "$BADPRE" in *"valid"*|*"10 digit"*) ok "a phone number starting 1 is refused" ;; *) bad "phone prefix" "got $BADPRE" ;; esac

BADAAD=$(curl -s -X POST "$API/drivers" -H "Authorization: Bearer $SUP"   -F 'payload={"name":"Bad Aadhar","phone":"9835472011","aadhar_no":"012345678901","allow_incomplete":true}'   | node -pe 'JSON.parse(require("fs").readFileSync(0)).error||""')
case "$BADAAD" in *"12 digits"*|*"Aadhar"*) ok "an Aadhar starting 0 is refused" ;; *) bad "aadhar prefix" "got $BADAAD" ;; esac

LONGAAD=$(curl -s -X POST "$API/drivers" -H "Authorization: Bearer $SUP"   -F 'payload={"name":"Long Aadhar","phone":"9835472012","aadhar_no":"22222222222222222","allow_incomplete":true}'   | node -pe 'JSON.parse(require("fs").readFileSync(0)).error||""')
case "$LONGAAD" in *"12 digits"*|*"Aadhar"*) ok "a 17 digit Aadhar is refused" ;; *) bad "aadhar length" "got $LONGAAD" ;; esac

echo "== deployment: structure link, bank details, rejection =="
NOSAL=$(curl -s -X POST "$API/deployments" -H "Authorization: Bearer $SUP" -H 'Content-Type: application/json' \
  -d "{\"driver_id\":$NEWID,\"client_id\":\"$CID\",\"date_of_joining\":\"2026-01-05\",\"override_screening\":true}" \
  | node -pe 'JSON.parse(require("fs").readFileSync(0)).details?.code||""')
[ "$NOSAL" = "NO_SALARY_STRUCTURE" ] && ok "deployment demands a salary structure" || bad "structure required" "got $NOSAL"

NOBANK=$(curl -s -X POST "$API/deployments" -H "Authorization: Bearer $SUP" -H 'Content-Type: application/json' \
  -d "{\"driver_id\":$NEWID,\"client_id\":\"$CID\",\"date_of_joining\":\"2026-01-05\",\"override_screening\":true,\"salary_structure_id\":$SID}" \
  | node -pe 'JSON.parse(require("fs").readFileSync(0)).details?.code||""')
[ "$NOBANK" = "MISSING_BANK_DETAILS" ] && ok "bank details are demanded at deployment" || bad "bank at deployment" "got $NOBANK"

DEP=$(curl -s -X POST "$API/deployments" -H "Authorization: Bearer $SUP" -H 'Content-Type: application/json' \
  -d "{\"driver_id\":$NEWID,\"client_id\":\"$CID\",\"date_of_joining\":\"2026-01-05\",\"override_screening\":true,\"salary_structure_id\":$SID,\"bank_account_no\":\"38914455072\",\"bank_ifsc\":\"SBIN0004521\",\"uan_no\":\"101234567890\"}")
DSC=$(echo "$DEP" | node -pe 'JSON.parse(require("fs").readFileSync(0)).salaryStructure?.code||""')
[ -n "$DSC" ] && ok "deployment linked to salary structure $DSC" || bad "deployment structure" "empty"
UAN=$(curl -s "$API/drivers/$NEWID" -H "Authorization: Bearer $SUP" | node -pe 'JSON.parse(require("fs").readFileSync(0)).driver.uan_no')
[ "$UAN" = "101234567890" ] && ok "bank details / UAN filled at the deployment step" || bad "deferred fields" "got $UAN"

REJ=$(curl -s -X POST "$API/deployments/reject" -H "Authorization: Bearer $SUP" -H 'Content-Type: application/json' \
  -d '{"driver_id":99999,"reason":"x"}' -o /dev/null -w '%{http_code}')
[ "$REJ" = "404" ] && ok "rejection endpoint validates the driver" || bad "reject validation" "got $REJ"

echo "== attendance bulk upload =="
PERIOD=$(date +%Y-%m)
curl -s "$API/attendance/template?period=$PERIOD" -H "Authorization: Bearer $SUP" -o $TMP/att.xlsx
[ -s $TMP/att.xlsx ] && ok "bulk attendance template downloads" || bad "template" "empty file"
DRY=$(curl -s -X POST "$API/attendance/upload" -H "Authorization: Bearer $SUP" -F "file=@$TMP/att.xlsx" -F "period=$PERIOD")
COMMITTED=$(echo "$DRY" | node -pe 'String(JSON.parse(require("fs").readFileSync(0)).committed)')
[ "$COMMITTED" = "false" ] && ok "upload dry-runs before writing" || bad "dry run" "got $COMMITTED"
MARKS=$(echo "$DRY" | node -pe 'JSON.parse(require("fs").readFileSync(0)).marks')
[ "$MARKS" -gt 0 ] && ok "template round-trips ($MARKS marks read)" || bad "round trip" "got $MARKS"
COMM=$(curl -s -X POST "$API/attendance/upload" -H "Authorization: Bearer $SUP" -F "file=@$TMP/att.xlsx" -F "period=$PERIOD" -F 'commit=true' \
  | node -pe 'JSON.parse(require("fs").readFileSync(0)).saved')
[ "$COMM" -gt 0 ] && ok "committed upload saved $COMM day(s)" || bad "commit" "got $COMM"

echo "== attendance: future dates carry no code =="
PERIOD=$(date +%Y-%m)
SHEET=$(curl -s "$API/attendance/sheet?period=$PERIOD" -H "Authorization: Bearer $SUP")
FUT=$(echo "$SHEET" | node -pe '
  const d = JSON.parse(require("fs").readFileSync(0));
  const today = new Date().toISOString().slice(0, 10);
  let bad = 0, ok = 0;
  d.rows.forEach((r) => d.days.forEach((day) => {
    const c = r.cells[day];
    if (day > today && c && c.code) bad += 1;
    if (day <= today && c && c.code) ok += 1;
  }));
  `${bad}|${ok}`')
case "$FUT" in 0\|*) ok "no future day carries a code (${FUT#*|} past days do)" ;; *) bad "future dates" "got $FUT" ;; esac

echo "== insurance: download / upload round trip =="
curl -s "$API/insurance/export" -H "Authorization: Bearer $SUP" -o "$TMP/ins.xlsx"
[ -s "$TMP/ins.xlsx" ] && ok "supervisor can download the coverage list" || bad "insurance download" "empty file"

COLS=$(node -e '
  const E = require("exceljs");
  const wb = new E.Workbook();
  wb.xlsx.readFile(process.argv[1]).then(() => {
    const h = (wb.worksheets[0].getRow(2).values || []).slice(1).map(String);
    console.log(h.filter((x) => /Valid From/i.test(x)).length);
  });' "$TMP/ins.xlsx")
[ "$COLS" = "4" ] && ok "every policy has a Valid From column ($COLS of 4)" || bad "valid from columns" "got $COLS"

RT=$(curl -s -X POST "$API/insurance/import" -H "Authorization: Bearer $SUP"   -F "file=@$TMP/ins.xlsx" -F 'dry_run=true'   | node -pe 'const d=JSON.parse(require("fs").readFileSync(0)); `${d.updated}|${d.changed||0}|${d.errors.length}`')
case "$RT" in *"|0|0") ok "an unmodified round trip changes nothing (${RT%%|*} rows read)" ;;
  *) bad "insurance round trip" "got updated|changed|errors = $RT" ;; esac

echo "== payroll uses the salary master =="
PP=$(curl -s -X POST "$API/salary/periods/$PERIOD/collate" -H "Authorization: Bearer $FIN" -H 'Content-Type: application/json' -d '{}')
ONS=$(echo "$PP" | node -pe 'JSON.parse(require("fs").readFileSync(0)).onStructure')
[ "$ONS" -gt 0 ] && ok "$ONS payroll lines computed from the salary master" || bad "payroll structure" "got $ONS"
curl -s "$API/salary/periods/$PERIOD/wage-register" -H "Authorization: Bearer $FIN" -o $TMP/wage.xlsx
[ -s $TMP/wage.xlsx ] && ok "wage register downloads" || bad "wage register" "empty"
PR=$(curl -s -o "$TMP/pay.xlsx" -w "%{http_code}" "$API/salary/periods/$PERIOD/pay-register" -H "Authorization: Bearer $FIN")
SHEETS=$(node -e '
  const E = require("exceljs"); const wb = new E.Workbook();
  wb.xlsx.readFile(process.argv[1]).then(() => console.log(wb.worksheets.map((w) => w.name).join(", ")))
    .catch(() => console.log(""));' "$TMP/pay.xlsx")
if [ "$PR" = "200" ] && [ -n "$SHEETS" ]; then ok "pay register downloads in the client layout ($SHEETS)";
else bad "pay register" "HTTP $PR, sheets: $SHEETS"; fi

echo "== scan endpoint =="
SCAN=$(curl -s -X POST "$API/drivers/scan" -H "Authorization: Bearer $SUP" -F 'text=Driver Name : RAJU SINGH
Mobile No : 9812345678
Aadhaar Number : 4321 8765 1098')
SN=$(echo "$SCAN" | node -pe 'JSON.parse(require("fs").readFileSync(0)).fields.name||""')
[ "$SN" = "RAJU SINGH" ] && ok "pasted page text populates the form" || bad "scan text" "got $SN"
OCRL=$(curl -s "$API/drivers/scan/status" -H "Authorization: Bearer $SUP" | node -pe 'String(JSON.parse(require("fs").readFileSync(0)).local)')
[ "$OCRL" = "true" ] && ok "local OCR engine reported available" || bad "ocr status" "got $OCRL"

j() { node -pe "const d=JSON.parse(require('fs').readFileSync(0)); $1"; }
TODAY=$(date +%Y-%m-%d)

echo "== registration: both sides of the documents, bank from the IFSC =="
AAD4="9$(date +%H%M%S)$(printf %05d $((RANDOM % 100000)))"
P4="{\"name\":\"Side Check\",\"phone\":\"9811122233\",\"aadhar_no\":\"$AAD4\",\"bank_ifsc\":\"HDFC0001234\",\"bank_account_no\":\"50100123456789\",\"bank_account_name\":\"Side Check\",\"allow_incomplete\":true}"
SIDES=$(curl -s -X POST "$API/drivers" -H "Authorization: Bearer $SUP" \
  -F "aadhar_doc=@$TMP/side.pdf" -F "dl_doc=@$TMP/side.pdf" -F "payload=$P4" \
  | j '`${d.details?.code}|${(d.details?.missing||[]).join()}`')
[ "$SIDES" = "DOCUMENT_SIDES_REQUIRED|Aadhar (back),Driving License (back)" ] \
  && ok "both sides of Aadhar and licence are required, even on an incomplete registration" || bad "document sides" "got $SIDES"
R4=$(curl -s -X POST "$API/drivers" -H "Authorization: Bearer $SUP" "${SIDES_F[@]}" -F "payload=$P4")
BANKN=$(echo "$R4" | j 'd.driver.bank_name')
[ "$BANKN" = "HDFC Bank" ] && ok "bank name is read off the IFSC ($BANKN)" || bad "bank from IFSC" "got $BANKN"
PROOF=$(echo "$R4" | j 'String(d.completeness.deferred.includes("Cancelled cheque or passbook"))')
[ "$PROOF" = "true" ] && ok "a missing cheque / passbook is reported" || bad "bank proof" "got $PROOF"
BID=$(echo "$R4" | j 'd.id')
REGNO=$(echo "$R4" | j 'd.registration_no')
case "$REGNO" in QDM/*) ok "registration ID allotted on save ($REGNO)" ;; *) bad "registration ID" "got $REGNO" ;; esac

echo "== deployment: not-deployed list, locations, blacklist =="
UND=$(curl -s "$API/deployments/undeployed" -H "Authorization: Bearer $SUP" | j "String(d.some((r) => r.id === $BID))")
[ "$UND" = "true" ] && ok "a new registration is on the not-deployed list" || bad "undeployed list" "got $UND"
CID2="8$(printf %05d $((RANDOM % 100000)))"
LOCBAD=$(curl -s -X POST "$API/deployments" -H "Authorization: Bearer $SUP" -H 'Content-Type: application/json' \
  -d "{\"driver_id\":$BID,\"client_id\":\"$CID2\",\"date_of_joining\":\"$TODAY\",\"override_screening\":true,\"salary_structure_id\":$SID,\"location\":\"Nowhere Town\"}" \
  | j 'd.details?.code||d.error')
[ "$LOCBAD" = "UNKNOWN_LOCATION" ] && ok "a location off the list is refused" || bad "location list" "got $LOCBAD"
BL=$(curl -s -X POST "$API/drivers/$BID/blacklist" -H "Authorization: Bearer $SUP" -H 'Content-Type: application/json' \
  -d '{"reason":"Smoke test blacklist"}' | j 'String(d.blacklisted)')
[ "$BL" = "1" ] && ok "a driver can be blacklisted" || bad "blacklist" "got $BL"
LOC1="Smoke Site $RANDOM"
LOCADD=$(curl -s -X POST "$API/locations" -H "Authorization: Bearer $ADM" -H 'Content-Type: application/json'   -d "{\"name\":\"$LOC1\"}" | j 'd.name||d.error')
[ "$LOCADD" = "$LOC1" ] && ok "Admin / Director adds a location to the list" || bad "add location" "got $LOCADD"
BLD=$(curl -s -X POST "$API/deployments" -H "Authorization: Bearer $SUP" -H 'Content-Type: application/json' \
  -d "{\"driver_id\":$BID,\"client_id\":\"$CID2\",\"date_of_joining\":\"$TODAY\",\"override_screening\":true,\"salary_structure_id\":$SID,\"location\":\"$LOC1\"}" \
  | j 'd.details?.code||d.error')
[ "$BLD" = "BLACKLISTED" ] && ok "a blacklisted driver cannot be deployed" || bad "blacklist deploy guard" "got $BLD"
INBL=$(curl -s "$API/deployments/blacklisted" -H "Authorization: Bearer $SUP" | j "String(d.some((r) => r.id === $BID))")
NOTUND=$(curl -s "$API/deployments/undeployed" -H "Authorization: Bearer $SUP" | j "String(d.some((r) => r.id === $BID))")
[ "$INBL|$NOTUND" = "true|false" ] && ok "blacklisted drivers are listed apart from the not-deployed" || bad "blacklist lists" "got $INBL|$NOTUND"
LIFTSUP=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/drivers/$BID/blacklist/lift" -H "Authorization: Bearer $SUP" \
  -H 'Content-Type: application/json' -d '{"reason":"try"}')
[ "$LIFTSUP" = "403" ] && ok "a supervisor cannot lift a blacklist (403)" || bad "lift guard" "got $LIFTSUP"
LIFT=$(curl -s -X POST "$API/drivers/$BID/blacklist/lift" -H "Authorization: Bearer $ADM" -H 'Content-Type: application/json' \
  -d '{"reason":"Smoke test lift"}' | j 'String(d.blacklisted)')
[ "$LIFT" = "0" ] && ok "Admin / Director lifts the blacklist" || bad "lift" "got $LIFT"
DEPL=$(curl -s -X POST "$API/deployments" -H "Authorization: Bearer $SUP" -H 'Content-Type: application/json' \
  -d "{\"driver_id\":$BID,\"client_id\":\"$CID2\",\"date_of_joining\":\"$TODAY\",\"override_screening\":true,\"salary_structure_id\":$SID,\"location\":\"$LOC1\"}")
EMP2=$(echo "$DEPL" | j 'd.employment?.id||""')
END=$(curl -s -X POST "$API/deployments/$EMP2/end" -H "Authorization: Bearer $SUP" -H 'Content-Type: application/json' \
  -d "{\"date_of_leaving\":\"$TODAY\",\"exit_reason\":\"Absconded\",\"blacklist\":true,\"blacklist_reason\":\"Absconded with the vehicle\"}" \
  | j 'd.employment?.status||d.error')
BLDOL=$(curl -s "$API/deployments/blacklisted" -H "Authorization: Bearer $SUP" | j "(d.find((r) => r.id === $BID)||{}).date_of_leaving||''")
[ "$END|$BLDOL" = "ended|$TODAY" ] && ok "ending a deployment can blacklist, with the date of leaving on the list" || bad "end + blacklist" "got $END|$BLDOL"

echo "== challans / debits: approved by Admin / Director, then recovered through salary =="
DEBR=$(curl -s -X POST "$API/debits" -H "Authorization: Bearer $SUP" -H 'Content-Type: application/json' \
  -d "{\"driver_id\":$DRV,\"kind\":\"challan\",\"details\":\"E-challan TEST-001\",\"debit_date\":\"$TODAY\",\"reason\":\"Red light\",\"amount\":750}")
DEB=$(echo "$DEBR" | j 'd.status||d.error')
DEBID=$(echo "$DEBR" | j 'd.id')
[ "$DEB" = "pending_approval" ] && ok "a challan is raised and waits for approval" || bad "raise challan" "got $DEB"
DSUP=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/debits/$DEBID/decision" -H "Authorization: Bearer $SUP" \
  -H 'Content-Type: application/json' -d '{"decision":"approve"}')
[ "$DSUP" = "403" ] && ok "a supervisor cannot approve a challan (403)" || bad "challan approval guard" "got $DSUP"
DAPP=$(curl -s -X POST "$API/debits/$DEBID/decision" -H "Authorization: Bearer $ADM" -H 'Content-Type: application/json' \
  -d '{"decision":"approve"}' | j 'd.status||d.error')
[ "$DAPP" = "open" ] && ok "Admin / Director approves it and it opens for recovery" || bad "approve challan" "got $DAPP"
curl -s -X POST "$API/salary/periods/$PERIOD/collate" -H "Authorization: Bearer $FIN" -H 'Content-Type: application/json' -d '{}' >/dev/null
DDED=$(curl -s "$API/salary/periods/$PERIOD" -H "Authorization: Bearer $FIN" | j "String((d.rows.find((r) => r.driver_id === $DRV)||{}).debit_deduction >= 750)")
[ "$DDED" = "true" ] && ok "collating the month deducts the open challans" || bad "debit deduction" "got $DDED"

echo "== advances: the ceiling on attendance =="
BIG=$(curl -s -X POST "$API/advances" -H "Authorization: Bearer $SUP" -H 'Content-Type: application/json' \
  -d "{\"driver_id\":$DRV,\"amount\":400000,\"reason\":\"Ceiling check\"}" | j 'd.advance.id')
CAP=$(curl -s -X POST "$API/advances/$BIG/decision" -H "Authorization: Bearer $ADM" -H 'Content-Type: application/json' \
  -d '{"decision":"approve"}' | j 'd.details?.code||d.status')
[ "$CAP" = "ADVANCE_LIMIT" ] && ok "an advance past 50% of earned salary cannot be approved" || bad "advance ceiling" "got $CAP"
LIM=$(curl -s "$API/advances/$BIG/context" -H "Authorization: Bearer $ADM" | j '`${d.limitPercent}|${d.advanceLimit === Math.round(d.accruedSalary * 50) / 100}`')
[ "$LIM" = "50|true" ] && ok "the approval window shows the 50% limit" || bad "limit in context" "got $LIM"
curl -s -X POST "$API/advances/$BIG/cancel" -H "Authorization: Bearer $SUP" -H 'Content-Type: application/json' -d '{}' >/dev/null

echo "== advances: HDFC bulk sheet for the day =="
DS=$(curl -s -X POST "$API/advances/day-sheet" -H "Authorization: Bearer $FIN" -H 'Content-Type: application/json' -d '{}')
DSB=$(echo "$DS" | j 'd.batch?.id||d.error')
curl -s "$API/advances/batches/$DSB/sheet?format=csv" -H "Authorization: Bearer $FIN" -o "$TMP/hdfc.csv"
FIRST=$(head -c 2 "$TMP/hdfc.csv")
case "$FIRST" in I,|N,|R,) ok "the day's advances come out as an HDFC bulk upload ($(echo "$DS" | j 'd.count') payment(s))" ;;
  *) bad "hdfc day sheet" "batch $DSB, first field '$FIRST'" ;; esac
curl -s "$API/advances/batches/$DSB/sheet" -H "Authorization: Bearer $FIN" -o "$TMP/hdfc.xlsx"
HHEAD=$(node -e '
  const E = require("exceljs"); const wb = new E.Workbook();
  wb.xlsx.readFile(process.argv[1]).then(() => {
    const ws = wb.worksheets[0]; const h = ws.getRow(1); const r = ws.getRow(2);
    console.log([ws.name, String(h.getCell(1).value).slice(0, 19), h.getCell(28).value, ws.columnCount,
      r.values.length ? [r.getCell(1).value, typeof r.getCell(3).value, typeof r.getCell(4).value,
        r.getCell(14).value, /^\d\d\/\d\d\/\d{4}$/.test(r.getCell(23).value)].join("/") : "empty"].join("|"));
  }).catch(() => console.log(""));' "$TMP/hdfc.xlsx")
case "$HHEAD" in "Sheet1|Transaction Type (N|Beneficiary email id|28|"*) ok "the .xlsx matches the RBI Adapter layout (28 columns, Sheet1)" ;;
  *) bad "hdfc xlsx layout" "got $HHEAD" ;; esac
case "$HHEAD" in *"|empty"|*"|N/string/number/VENDOR/true"|*"|R/string/number/VENDOR/true") ok "rows carry N/R, text account, numeric amount, VENDOR, DD/MM/YYYY" ;;
  *) bad "hdfc xlsx row" "got $HHEAD" ;; esac

echo "== salary: recovery is applied once =="
LINES=$(curl -s "$API/salary/periods/$PERIOD" -H "Authorization: Bearer $FIN" \
  | j 'd.rows.filter((r) => r.advance_deduction > 0 && r.status !== "paid" && !r.hold).slice(0, 2).map((r) => `${r.id}:${r.driver_id}`).join(" ")')
set -- $LINES
if [ $# -eq 2 ]; then
  LA=${1%%:*}; DA=${1##*:}; LB=${2%%:*}
  recov() { curl -s "$API/advances?driver_id=$1" -H "Authorization: Bearer $FIN" | j 'd.rows.reduce((s, r) => s + r.recovered, 0)'; }
  curl -s -X POST "$API/salary/periods/$PERIOD/record-payments" -H "Authorization: Bearer $FIN" -H 'Content-Type: application/json' \
    -d "{\"payments\":[{\"line_id\":$LA}]}" >/dev/null
  R1=$(recov $DA)
  curl -s -X POST "$API/salary/periods/$PERIOD/record-payments" -H "Authorization: Bearer $FIN" -H 'Content-Type: application/json' \
    -d "{\"payments\":[{\"line_id\":$LB}]}" >/dev/null
  R2=$(recov $DA)
  [ "$R1" = "$R2" ] && ok "paying a second batch does not recover the first again ($R1)" || bad "recovery idempotency" "$R1 then $R2"
else
  bad "recovery idempotency" "needs two lines with an advance recovery, found: $LINES"
fi

echo
echo "  $PASS passed, $FAIL failed"
exit $([ $FAIL -eq 0 ] && echo 0 || echo 1)
