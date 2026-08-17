export const inr = (n) =>
  `₹${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

export const inr0 = (n) => `₹${Math.round(Number(n || 0)).toLocaleString('en-IN')}`;

export function date(d) {
  if (!d) return '—';
  const s = String(d).slice(0, 10);
  const [y, m, day] = s.split('-');
  if (!y || !m || !day) return s;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${day} ${months[Number(m) - 1]} ${y}`;
}

export function dateTime(d) {
  if (!d) return '—';
  return `${date(d)} ${String(d).slice(11, 16)}`.trim();
}

export const today = () => new Date().toISOString().slice(0, 10);
export const thisPeriod = () => today().slice(0, 7);

export function periodLabel(p) {
  if (!p) return '—';
  const [y, m] = p.split('-');
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'];
  return `${months[Number(m) - 1]} ${y}`;
}

export function shiftPeriod(p, delta) {
  const [y, m] = p.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
}

export const titleCase = (s) =>
  String(s || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

export const STATUS_TONE = {
  registered: 'grey', in_screening: 'amber', cleared: 'blue', deployed: 'green',
  left: 'grey', rejected: 'red',
  pending_sm: 'amber', pending_director: 'violet', approved: 'blue',
  paid: 'green', rejected_: 'red', settled: 'green',
  draft: 'grey', attendance_finalized: 'blue', reviewed: 'violet', closed: 'grey',
  pending: 'grey', held: 'red', in_bank: 'violet',
  active: 'green', ended: 'grey', open: 'amber', sent: 'green', sending: 'amber',
  queued: 'grey', failed: 'red', passed: 'green',
};

export const STATUS_LABEL = {
  pending_sm: 'With Senior Manager',
  pending_director: 'With Director',
  approved: 'Approved',
  paid: 'Paid',
  rejected: 'Rejected',
  settled: 'Settled',
  in_screening: 'In Screening',
  attendance_finalized: 'Attendance Finalised',
  in_bank: 'Sent to Bank',
};

