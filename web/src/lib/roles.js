/**
 * The three roles the system runs on. Kept in one place so the sidebar, the
 * user admin screen and every guard in the pages agree on the wording.
 *
 *   supervisor  the field role
 *   admin       Admin / Director — approves, and owns the masters
 *   finance     pays: advances, expenses, payroll, bank, Tally
 */
export const ROLES = ['supervisor', 'admin', 'finance'];

export const ROLE_LABEL = {
  supervisor: 'Supervisor',
  admin: 'Admin / Director',
  finance: 'Finance',
};

export const ROLE_DESCRIPTION = {
  supervisor:
    'Registers drivers, records screening, deploys, marks attendance, raises advance '
    + 'and expense requests, and settles petty cash.',
  admin:
    'Approves every advance and expense, maintains the salary master and branding, manages '
    + 'users — and can do everything the other two roles can.',
  finance:
    'Advance payment runs, expense settlement, payroll and the wage register, bank upload '
    + 'sheets, bank reconciliation, Tally linkage and the petty cash float.',
};

/** Admin passes every role check. */
export const hasRole = (user, ...roles) =>
  Boolean(user && (user.role === 'admin' || roles.includes(user.role)));
