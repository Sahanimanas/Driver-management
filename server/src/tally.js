import { xmlEscape } from './util.js';

/**
 * Build a Tally-importable XML payload (Vouchers -> "All Masters" import).
 * Each entry is a single-transaction journal/payment voucher:
 *   Dr <ledger>  (driver / expense head)
 *   Cr <bank or cash ledger>
 *
 * entries: [{ date: 'YYYY-MM-DD', voucherType, narration, ledger, amount,
 *             counterLedger, reference, costCentre }]
 */
export function buildTallyXml({ company = 'Quantum', entries }) {
  const vouchers = entries.map((e) => voucher(company, e)).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Import Data</TALLYREQUEST>
  </HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>Vouchers</REPORTNAME>
        <STATICVARIABLES>
          <SVCURRENTCOMPANY>${xmlEscape(company)}</SVCURRENTCOMPANY>
        </STATICVARIABLES>
      </REQUESTDESC>
      <REQUESTDATA>
${vouchers}
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`;
}

function voucher(company, e) {
  const date = String(e.date || '').replace(/-/g, '');
  const amount = Number(e.amount || 0).toFixed(2);
  return `        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <VOUCHER VCHTYPE="${xmlEscape(e.voucherType || 'Payment')}" ACTION="Create" OBJVIEW="Accounting Voucher View">
            <DATE>${date}</DATE>
            <EFFECTIVEDATE>${date}</EFFECTIVEDATE>
            <VOUCHERTYPENAME>${xmlEscape(e.voucherType || 'Payment')}</VOUCHERTYPENAME>
            <VOUCHERNUMBER>${xmlEscape(e.reference || '')}</VOUCHERNUMBER>
            <NARRATION>${xmlEscape(e.narration || '')}</NARRATION>
            <PARTYLEDGERNAME>${xmlEscape(e.ledger)}</PARTYLEDGERNAME>
            <ALLLEDGERENTRIES.LIST>
              <LEDGERNAME>${xmlEscape(e.ledger)}</LEDGERNAME>
              <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
              <AMOUNT>-${amount}</AMOUNT>
            </ALLLEDGERENTRIES.LIST>
            <ALLLEDGERENTRIES.LIST>
              <LEDGERNAME>${xmlEscape(e.counterLedger || 'Bank Account')}</LEDGERNAME>
              <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
              <AMOUNT>${amount}</AMOUNT>
            </ALLLEDGERENTRIES.LIST>
          </VOUCHER>
        </TALLYMESSAGE>`;
}

/** Ledger name convention so Tally rows reconcile back to a driver. */
export function driverLedger(driver) {
  return `${driver.name} (${driver.registration_no})`;
}
