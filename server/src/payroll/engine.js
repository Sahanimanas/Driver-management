/**
 * The pay engine.
 *
 * Turns a salary structure and a month's attendance into the lines of the pay
 * register. Pure: no database, no clock, so it can be checked row for row
 * against the client's own registers (see scripts/test-pay-register.js).
 *
 * The rules it has to express come straight from those registers:
 *
 *   HZL    every component x payable days / total days, unrounded; no
 *          statutory deductions. Payable = present + weekly off + holiday +
 *          approved leave.
 *
 *   Surat  every earned component rounded to the rupee, as the register's
 *          =ROUND(fixed*days/month,0) does; PF at 12% of *earned* basic,
 *          capped at a 15,000 wage; PT of 200 only when gross exceeds 12,000;
 *          an attendance bonus paid only at 30 days or more; an LSA whose
 *          monthly amount is set per driver; employer PF at 13% on the same
 *          capped base, which is a cost to the company and never deducted.
 *
 * A component therefore carries, besides its amount:
 *   rounding   'rupee' to round like Excel's ROUND(x,0); anything else keeps paise
 *   basis      for percentages of basic: 'earned' (this month's) or 'fixed'
 *   cap        a ceiling on the base a percentage is taken of (PF: 15,000)
 *   condition  'days_gte:30' | 'gross_gt:12000' | 'gross_lte:N' — paid only if true
 *   employer   a contribution the company pays on top; not a deduction
 *   per_driver the monthly figure comes from the deployment (LSA), not the structure
 */

/** Excel's ROUND(x, 0): half away from zero, tolerant of float noise. */
export const excelRound = (x) => Math.sign(x) * Math.round(Math.abs(x) + 1e-9);

/**
 * A deployment with no salary structure is paid its flat monthly wage. Routing
 * it through the engine too means every line of a register is computed one way.
 */
export const flatStructure = (monthlyWage) => ({
  code: 'FLAT',
  service_charge: 0, gst_rate: 0, tds_rate: 0,
  components: [{
    name: 'Monthly wage', kind: 'earning', calc: 'fixed',
    value: Number(monthlyWage) || 0, prorated: 1, is_basic: 1,
  }],
});

/** Two decimal places, for presentation and storage. */
export const round2 = (x) => Math.round((Number(x) + Number.EPSILON) * 100) / 100;

const num = (v) => (v === null || v === undefined || v === '' ? 0 : Number(v));

function passes(condition, ctx) {
  if (!condition) return true;
  const [op, raw] = String(condition).split(':');
  const limit = Number(raw);
  switch (op) {
    case 'days_gte': return ctx.payableDays >= limit;
    case 'gross_gt': return ctx.gross > limit;
    case 'gross_lte': return ctx.gross <= limit;
    default: return true;
  }
}

const isBasic = (c) => Boolean(c.is_basic) || /^basic/i.test(String(c.name || ''));

/**
 * @param {object} structure  { components[], service_charge?, gst_rate?, tds_rate? }
 * @param {object} month
 * @param {number} month.payableDays   days the driver is paid for
 * @param {number} month.daysInMonth   the divisor the client uses (calendar days)
 * @param {number} [month.presentDays] days actually present, for the service charge
 * @param {number} [month.lsaMonthly]  this driver's LSA entitlement, if any
 */
export function computePay(structure, month) {
  const components = structure.components || [];
  const daysInMonth = num(month.daysInMonth) || 1;
  const payableDays = Math.max(0, num(month.payableDays));
  const presentDays = month.presentDays === undefined ? payableDays : num(month.presentDays);
  const factor = Math.min(1, payableDays / daysInMonth);

  // ---- earnings -----------------------------------------------------------
  // An earning's full-month figure: a fixed amount, a % of the full basic, or a
  // % of the full gross of the other earnings. Attendance is applied after.
  const earningComponents = components.filter((c) => c.kind === 'earning');
  const basicComponent = earningComponents.find(isBasic);
  const fullBasicValue = basicComponent && basicComponent.calc === 'fixed'
    ? (basicComponent.per_driver ? num(month.lsaMonthly) : num(basicComponent.value))
    : 0;
  const fullOf = (c, otherGross) => {
    if (c.per_driver) return num(month.lsaMonthly);
    if (c.calc === 'percent_of_basic') return (fullBasicValue * num(c.value)) / 100;
    if (c.calc === 'percent_of_gross') return (otherGross * num(c.value)) / 100;
    return num(c.value);
  };
  const fullBeforeGrossPercent = earningComponents
    .filter((c) => c.calc !== 'percent_of_gross')
    .reduce((s, c) => s + fullOf(c, 0), 0);

  const earnings = earningComponents
    .map((c) => {
      const full = fullOf(c, fullBeforeGrossPercent);
      let amount = c.prorated ? full * factor : full;
      if (c.rounding === 'rupee') amount = excelRound(amount);
      // Earnings may only be conditioned on attendance; gross isn't known yet.
      if (!passes(c.condition, { payableDays, gross: 0 })) amount = 0;
      return {
        name: c.name, full, amount, basic: isBasic(c),
        calc: c.calc, prorated: Boolean(c.prorated), rounding: c.rounding || 'none',
      };
    });

  const gross = earnings.reduce((s, e) => s + e.amount, 0);
  const basicLine = earnings.find((e) => e.basic);
  const earnedBasic = basicLine ? basicLine.amount : 0;
  const fixedBasic = basicLine ? basicLine.full : 0;
  const fullGross = earnings.reduce((s, e) => s + e.full, 0);

  // ---- deductions and employer contributions ------------------------------
  const deductions = [];
  const employer = [];
  components
    .filter((c) => c.kind === 'deduction')
    .forEach((c) => {
      let amount;
      if (c.calc === 'fixed') {
        amount = c.prorated ? num(c.value) * factor : num(c.value);
      } else {
        let base;
        if (c.calc === 'percent_of_basic') {
          base = c.basis === 'fixed' ? fixedBasic * (c.prorated ? factor : 1) : earnedBasic;
        } else {
          base = gross;   // percent_of_gross, on what was actually earned
        }
        if (num(c.cap) > 0) base = Math.min(base, num(c.cap));
        amount = (base * num(c.value)) / 100;
      }
      if (c.rounding === 'rupee') amount = excelRound(amount);
      if (!passes(c.condition, { payableDays, gross })) amount = 0;

      const line = { name: c.name, amount, calc: c.calc, value: num(c.value) };
      (c.employer ? employer : deductions).push(line);
    });

  const totalDeduction = deductions.reduce((s, d) => s + d.amount, 0);
  const employerCost = employer.reduce((s, d) => s + d.amount, 0);
  const net = gross - totalDeduction;
  const ctc = gross + employerCost;

  // ---- what the client is billed ------------------------------------------
  // Service charge accrues per day actually present, as both registers do.
  const serviceCharge = (num(structure.service_charge) / daysInMonth) * presentDays;
  const taxable = ctc + serviceCharge;
  const gst = (taxable * num(structure.gst_rate)) / 100;
  const invoice = taxable + gst;
  const tds = (taxable * num(structure.tds_rate)) / 100;

  return {
    factor,
    payableDays,
    daysInMonth,
    // `amount` is what a person reads; `raw` is what a register cell holds, so
    // its SUM() lands exactly where the client's does.
    earnings: earnings.map((e) => ({ ...e, raw: e.amount, amount: round2(e.amount) })),
    deductions: deductions.map((d) => ({ ...d, raw: d.amount, amount: round2(d.amount) })),
    employer: employer.map((d) => ({ ...d, raw: d.amount, amount: round2(d.amount) })),
    gross: round2(gross),
    totalDeduction: round2(totalDeduction),
    net: round2(net),
    employerCost: round2(employerCost),
    ctc: round2(ctc),
    monthlyGross: round2(fullGross),
    ratePerDay: round2(fullGross / daysInMonth),
    billing: {
      serviceCharge: round2(serviceCharge),
      taxable: round2(taxable),
      gst: round2(gst),
      invoice: round2(invoice),
      tds: round2(tds),
      netToVendor: round2(invoice - tds),
    },
    // Unrounded figures, for totals. The client's register sums full-precision
    // values and rounds only for display; summing the rounded per-driver
    // amounts instead drifts by a few paise across a register of fifty drivers.
    exact: {
      gross, totalDeduction, net, employerCost, ctc,
      billing: { serviceCharge, taxable, gst, invoice, tds, netToVendor: invoice - tds },
    },
  };
}
