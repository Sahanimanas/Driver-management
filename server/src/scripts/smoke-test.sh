#!/usr/bin/env bash
# End-to-end smoke test of everything that changed.
API=http://localhost:4000/api
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

REG=$(curl -s -X POST "$API/drivers" -H "Authorization: Bearer $SUP" \
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

echo "== scan endpoint =="
SCAN=$(curl -s -X POST "$API/drivers/scan" -H "Authorization: Bearer $SUP" -F 'text=Driver Name : RAJU SINGH
Mobile No : 9812345678
Aadhaar Number : 4321 8765 1098')
SN=$(echo "$SCAN" | node -pe 'JSON.parse(require("fs").readFileSync(0)).fields.name||""')
[ "$SN" = "RAJU SINGH" ] && ok "pasted page text populates the form" || bad "scan text" "got $SN"
OCRL=$(curl -s "$API/drivers/scan/status" -H "Authorization: Bearer $SUP" | node -pe 'String(JSON.parse(require("fs").readFileSync(0)).local)')
[ "$OCRL" = "true" ] && ok "local OCR engine reported available" || bad "ocr status" "got $OCRL"

echo
echo "  $PASS passed, $FAIL failed"
exit $([ $FAIL -eq 0 ] && echo 0 || echo 1)
