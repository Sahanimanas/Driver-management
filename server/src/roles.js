/**
 * Permissions and roles.
 *
 * Every guard in the API names a permission, never a role. A role is a named
 * set of permissions: the three the system ships with are fixed, and Admin /
 * Director can create more of their own (Users & roles -> Roles).
 *
 * No imports, so db.js can seed the built-in roles without a cycle.
 */

export const PERMISSIONS = [
  { key: 'drivers.register', group: 'Drivers', label: 'Register drivers',
    hint: 'Register, scan registration pages, record screening and reference contacts' },
  { key: 'drivers.edit', group: 'Drivers', label: 'Edit driver details and documents',
    hint: 'Including bank details and UAN' },
  { key: 'drivers.blacklist', group: 'Drivers', label: 'Blacklist, or record a client rejection' },
  { key: 'drivers.unblacklist', group: 'Drivers', label: 'Lift a blacklist' },

  { key: 'deployments.manage', group: 'Deployment & attendance', label: 'Deploy drivers and end deployments' },
  { key: 'deployments.edit', group: 'Deployment & attendance', label: 'Edit a live deployment',
    hint: 'Vehicle, location, salary class, supervisor' },
  { key: 'attendance.mark', group: 'Deployment & attendance', label: 'Mark attendance',
    hint: 'Including the bulk upload' },
  { key: 'insurance.manage', group: 'Deployment & attendance', label: 'Update insurance cover' },

  { key: 'advances.raise', group: 'Advances & challans', label: 'Raise advance requests' },
  { key: 'advances.approve', group: 'Advances & challans', label: 'Approve advances' },
  { key: 'advances.pay', group: 'Advances & challans', label: 'Pay advances',
    hint: 'Payment runs, HDFC sheets, marking paid' },
  { key: 'debits.raise', group: 'Advances & challans', label: 'Raise challans / debits' },
  { key: 'debits.approve', group: 'Advances & challans', label: 'Approve challans / debits' },

  { key: 'expenses.raise', group: 'Expenses', label: 'Raise expenses and settle from petty cash' },
  { key: 'expenses.approve', group: 'Expenses', label: 'Approve expenses' },
  { key: 'expenses.settle', group: 'Expenses', label: 'Settle expenses paid by Finance' },
  { key: 'pettycash.manage', group: 'Expenses', label: 'Issue and recover the petty cash float' },

  { key: 'payroll.manage', group: 'Payroll', label: 'Run payroll',
    hint: 'Collate, wage register, bank sheets, record payments, close the month' },
  { key: 'tally.post', group: 'Payroll', label: 'Tally linkage' },
  { key: 'salary_master.manage', group: 'Payroll', label: 'Maintain the salary master' },

  { key: 'messaging.send', group: 'Communication', label: 'Send WhatsApp broadcasts' },

  { key: 'users.manage', group: 'Administration', label: 'Manage users and roles' },
  { key: 'settings.manage', group: 'Administration', label: 'Change settings',
    hint: 'Branding, locations, registration number format' },
];

export const PERMISSION_KEYS = PERMISSIONS.map((p) => p.key);

/**
 * `field`: a field role. Drivers are deployed under people in a field role,
 * and they see only the drivers deployed under them (plus the pool of drivers
 * not yet deployed, so they can register and deploy).
 */
export const BUILTIN_ROLES = [
  {
    key: 'supervisor',
    label: 'Supervisor',
    description:
      'Registers drivers, records screening, deploys, marks attendance, raises advance '
      + 'and expense requests, and settles petty cash. Sees only the drivers deployed under them.',
    field: 1,
    permissions: [
      'drivers.register', 'drivers.edit', 'drivers.blacklist',
      'deployments.manage', 'deployments.edit', 'attendance.mark', 'insurance.manage',
      'advances.raise', 'debits.raise', 'expenses.raise', 'messaging.send',
    ],
  },
  {
    key: 'admin',
    label: 'Admin / Director',
    description:
      'Approves every advance and expense, maintains the salary master and branding, manages '
      + 'users and roles — and can do everything the other roles can.',
    field: 0,
    permissions: PERMISSION_KEYS,
  },
  {
    key: 'finance',
    label: 'Finance',
    description:
      'Advance payment runs, expense settlement, payroll and the wage register, bank upload '
      + 'sheets, bank reconciliation, Tally linkage and the petty cash float.',
    field: 0,
    permissions: [
      'drivers.edit', 'deployments.edit', 'insurance.manage',
      'advances.pay', 'debits.raise', 'expenses.settle', 'pettycash.manage',
      'payroll.manage', 'tally.post',
    ],
  },
];

export const BUILTIN_KEYS = BUILTIN_ROLES.map((r) => r.key);
