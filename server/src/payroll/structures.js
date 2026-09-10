/**
 * The two salary structures in the client's own pay registers (July 2026),
 * as the salary master holds them.
 *
 * One definition, used twice: the seed loads it into the database, and
 * scripts/test-pay-register.js replays the client's register through it. If
 * either structure changes, that test says so.
 */
export const CLIENT_STRUCTURES = [
  {
    code: 'HZL-LNG',
    name: 'HZL Driver — LNG Tip Trailer',
    category: 'HZL',
    effective_from: '2026-04-01',
    ot_rate_hour: 0,
    service_charge: 2000,
    gst_rate: 18,
    tds_rate: 0,
    register_format: 'hzl',
    role_label: 'Driver - LNG Powered Tip Trailer',
    notes: 'From the client pay register: fixed 21,050 a month, each component '
      + 'prorated by payable days over the days in the month, no statutory deductions. '
      + 'Billed a 2,000 service charge per person on days present, plus 18% IGST.',
    components: [
      { name: 'Basic + VDA', kind: 'earning', calc: 'fixed', value: 15000, prorated: 1, is_basic: 1 },
      { name: 'HRA', kind: 'earning', calc: 'fixed', value: 4500, prorated: 1 },
      { name: 'Mobile Allowance', kind: 'earning', calc: 'fixed', value: 300, prorated: 1 },
      { name: 'Food Allowance', kind: 'earning', calc: 'fixed', value: 1250, prorated: 1 },
    ],
  },
  {
    code: 'SURAT-LNG',
    name: 'Surat Driver — LNG Powered Trailer',
    category: 'MARKET',
    effective_from: '2026-04-01',
    ot_rate_hour: 0,
    service_charge: 2250,
    gst_rate: 18,
    tds_rate: 2,
    register_format: 'surat',
    role_label: 'Driver – LNG Powered Trailer',
    notes: 'From the client pay register: each earned component rounded to the rupee; '
      + 'PF 12% of earned basic capped at a 15,000 wage; PT 200 only above 12,000 gross; '
      + 'attendance bonus only at 30 days or more; LSA set per driver. Employer PF 13% is '
      + 'a company cost. Billed a 2,250 service charge on days present, 18% GST, 2% TDS.',
    components: [
      { name: 'Basic + DA', kind: 'earning', calc: 'fixed', value: 21750, prorated: 1, rounding: 'rupee', is_basic: 1 },
      { name: 'HRA', kind: 'earning', calc: 'fixed', value: 6525, prorated: 1, rounding: 'rupee' },
      { name: 'Personal Allowance', kind: 'earning', calc: 'fixed', value: 5225, prorated: 1, rounding: 'rupee' },
      { name: 'LSA', kind: 'earning', calc: 'fixed', value: 0, prorated: 1, per_driver: 1 },
      { name: 'Mobile Allowance', kind: 'earning', calc: 'fixed', value: 300, prorated: 1, rounding: 'rupee' },
      { name: 'Halt Allowance', kind: 'earning', calc: 'fixed', value: 1500, prorated: 1, rounding: 'rupee' },
      { name: 'Attendance Bonus', kind: 'earning', calc: 'fixed', value: 3000, prorated: 0, condition: 'days_gte:30' },
      { name: 'PF (12%)', kind: 'deduction', calc: 'percent_of_basic', value: 12, basis: 'earned', cap: 15000, rounding: 'rupee' },
      { name: 'Professional Tax', kind: 'deduction', calc: 'fixed', value: 200, prorated: 0, condition: 'gross_gt:12000' },
      { name: 'Employer PF (13%)', kind: 'deduction', calc: 'percent_of_basic', value: 13, basis: 'earned', cap: 15000, rounding: 'rupee', employer: 1 },
    ],
  },
];
