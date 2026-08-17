/**
 * Seed the database with users and a realistic set of drivers so every screen
 * has something to show. Safe to re-run: it clears operational tables first.
 */
import { q, tx, nextCounter } from './db.js';
import { hash } from './auth.js';
import { today, addDays, periodDays } from './util.js';

const USERS = [
  ['Admin', 'admin@quantum.test', 'admin', 'Quantum@123'],
  ['Ramesh Yadav', 'supervisor@quantum.test', 'supervisor', 'Quantum@123'],
  ['Sunita Rao', 'supervisor2@quantum.test', 'supervisor', 'Quantum@123'],
  ['Anil Mehta', 'manager@quantum.test', 'senior_manager', 'Quantum@123'],
  ['Vikram Singh', 'director@quantum.test', 'director', 'Quantum@123'],
  ['Priya Nair', 'accounts@quantum.test', 'accounts', 'Quantum@123'],
];

const FIRST = ['Rajesh', 'Suresh', 'Mahesh', 'Dinesh', 'Naresh', 'Prakash', 'Vinod', 'Sanjay',
  'Manoj', 'Deepak', 'Arun', 'Rakesh', 'Amit', 'Sunil', 'Ajay', 'Ravi', 'Mukesh', 'Satish',
  'Jitendra', 'Pankaj', 'Kailash', 'Bhupendra', 'Devendra', 'Lokesh'];
const LAST = ['Kumar', 'Sharma', 'Verma', 'Yadav', 'Singh', 'Gupta', 'Patel', 'Reddy', 'Nair',
  'Joshi', 'Mishra', 'Chauhan'];
const LOCATIONS = ['Gurugram — DLF Cyber City', 'Noida — Sector 62', 'Mumbai — BKC',
  'Bengaluru — Whitefield', 'Pune — Hinjewadi'];
const BANKS = ['HDFC Bank', 'State Bank of India', 'ICICI Bank', 'Axis Bank', 'Punjab National Bank'];
const REASONS = ['Family medical expense', 'School fees for children', 'House rent',
  'Festival expense', 'Travel to native place', 'Repair of household items'];

let rng = 20260817;
const rand = () => {
  rng = (rng * 1103515245 + 12345) % 2147483648;
  return rng / 2147483648;
};
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const between = (a, b) => a + Math.floor(rand() * (b - a + 1));

function reset() {
  const tables = [
    'campaign_recipients', 'campaigns', 'tally_exports', 'payroll_lines', 'payroll_periods',
    'petty_cash', 'expenses', 'advances', 'payment_batches', 'insurance', 'attendance',
    'employments', 'screenings', 'driver_references', 'drivers', 'attachments',
    'audit_log', 'counters', 'users',
  ];
  tables.forEach((t) => q.run(`DELETE FROM ${t}`));
}

function seedUsers() {
  USERS.forEach(([name, email, role, password]) => {
    q.run(
      'INSERT INTO users(name, email, phone, password_hash, role) VALUES (?,?,?,?,?)',
      name, email, `98${between(10000000, 99999999)}`, hash(password), role,
    );
  });
  return Object.fromEntries(
    q.all('SELECT id, role, email FROM users').map((u) => [u.email.split('@')[0], u.id]),
  );
}

function seedDrivers(users) {
  const now = today();
  const drivers = [];

  for (let i = 0; i < 42; i += 1) {
    const name = `${pick(FIRST)} ${pick(LAST)}`;
    const year = new Date().getFullYear();
    const reg = `QDM/${year}/${String(nextCounter(`registration:${year}`)).padStart(5, '0')}`;
    const dob = `${between(1972, 2000)}-${String(between(1, 12)).padStart(2, '0')}-${String(between(1, 28)).padStart(2, '0')}`;
    const registeredOn = addDays(now, -between(30, 900));

    const id = q.insert(
      `INSERT INTO drivers(registration_no, name, phone, aadhar_no, address, dob_aadhar, dl_no,
        dl_dob, dl_valid_from, dl_valid_till, bank_account_name, bank_account_no, bank_ifsc,
        bank_name, uan_no, status, created_by, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      reg, name, `9${between(100000000, 999999999)}`,
      String(between(100000000000, 999999999999)),
      `H.No ${between(1, 400)}, ${pick(['Sector', 'Ward', 'Colony'])} ${between(1, 60)}, ${pick(LOCATIONS).split(' — ')[0]}`,
      dob,
      `${pick(['DL', 'HR', 'UP', 'MH', 'KA'])}${between(10, 99)}${between(20100000000, 20239999999)}`,
      dob,
      addDays(now, -between(400, 2000)),
      addDays(now, between(-30, 1500)),
      name, String(between(10000000000, 99999999999)),
      `${pick(['HDFC', 'SBIN', 'ICIC', 'UTIB', 'PUNB'])}0${String(between(100000, 999999))}`,
      pick(BANKS), String(between(100000000000, 999999999999)),
      'registered', users.supervisor, registeredOn,
    );

    ['father', 'brother'].forEach((relation, idx) => {
      q.run(
        'INSERT INTO driver_references(driver_id, name, relation, phone) VALUES (?,?,?,?)',
        id, `${pick(FIRST)} ${name.split(' ')[1]}`,
        relation === 'father' ? 'Father' : pick(['Brother', 'Uncle', 'Cousin']),
        `9${between(100000000, 999999999)}`,
      );
      return idx;
    });

    // Screening pipeline: most clear it, a few are still in progress or failed.
    const roll = rand();
    const outcome = roll < 0.8 ? 'passed' : roll < 0.93 ? 'partial' : 'failed';
    ['trial', 'safety', 'medical'].forEach((type, idx) => {
      let status = 'pending';
      if (outcome === 'passed') status = 'passed';
      else if (outcome === 'partial') status = idx === 0 ? 'passed' : 'pending';
      else status = idx === 2 ? 'failed' : 'passed';
      q.run(
        `INSERT INTO screenings(driver_id, type, status, conducted_on, recorded_by)
         VALUES (?,?,?,?,?)`,
        id, type, status, status === 'pending' ? null : addDays(registeredOn, idx + 1), users.supervisor,
      );
    });

    ['GMC', 'GPA', 'GTL', 'WC'].forEach((t) => {
      const covered = outcome === 'passed' && rand() > 0.22 ? 1 : 0;
      q.run(
        `INSERT INTO insurance(driver_id, type, covered, policy_no, valid_from, valid_to, updated_by)
         VALUES (?,?,?,?,?,?,?)`,
        id, t, covered,
        covered ? `${t}/2026/${between(10000, 99999)}` : null,
        covered ? `${new Date().getFullYear()}-04-01` : null,
        covered ? `${new Date().getFullYear() + 1}-03-31` : null,
        users.accounts,
      );
    });

    q.run(
      'UPDATE drivers SET status = ? WHERE id = ?',
      outcome === 'passed' ? 'cleared' : outcome === 'failed' ? 'rejected' : 'in_screening',
      id,
    );
    drivers.push({ id, name, reg, outcome, registeredOn });
  }
  return drivers;
}

function seedDeployments(drivers, users) {
  const now = today();
  let clientId = 400100;
  const deployed = [];

  drivers.filter((d) => d.outcome === 'passed').forEach((d, idx) => {
    const doj = addDays(d.registeredOn, between(5, 20));
    if (doj > now) return;
    const wage = between(17, 26) * 1000;
    const location = pick(LOCATIONS);

    // Roughly one in seven has left and rejoined on a fresh client ID — the
    // linkage that keeps their total service intact.
    const rejoined = idx % 7 === 3;
    if (rejoined) {
      const leftOn = addDays(doj, between(120, 300));
      if (leftOn < now) {
        clientId += 1;
        const first = q.insert(
          `INSERT INTO employments(driver_id, client_id, date_of_joining, date_of_leaving,
            vehicle_number, location, monthly_wage, status, exit_reason, created_by)
           VALUES (?,?,?,?,?,?,?, 'ended', ?, ?)`,
          d.id, String(clientId), doj, leftOn,
          `${pick(['DL', 'HR', 'MH', 'KA'])}${between(10, 99)}${pick(['AB', 'CD', 'EF'])}${between(1000, 9999)}`,
          location, wage, 'Went to native place', users.supervisor,
        );
        clientId += 1;
        const rejoinOn = addDays(leftOn, between(20, 70));
        if (rejoinOn < now) {
          const second = q.insert(
            `INSERT INTO employments(driver_id, client_id, date_of_joining, vehicle_number,
              location, monthly_wage, created_by)
             VALUES (?,?,?,?,?,?,?)`,
            d.id, String(clientId), rejoinOn,
            `${pick(['DL', 'HR', 'MH', 'KA'])}${between(10, 99)}${pick(['AB', 'CD', 'EF'])}${between(1000, 9999)}`,
            location, wage + 1000, users.supervisor,
          );
          q.run("UPDATE drivers SET status = 'deployed' WHERE id = ?", d.id);
          deployed.push({ ...d, empId: second, doj: rejoinOn, wage: wage + 1000, location });
          return;
        }
        q.run("UPDATE drivers SET status = 'left' WHERE id = ?", d.id);
        deployed.push({ ...d, empId: first, doj, wage, location, ended: true, leftOn });
        return;
      }
    }

    clientId += 1;
    const empId = q.insert(
      `INSERT INTO employments(driver_id, client_id, date_of_joining, vehicle_number, location,
        monthly_wage, created_by)
       VALUES (?,?,?,?,?,?,?)`,
      d.id, String(clientId), doj,
      `${pick(['DL', 'HR', 'MH', 'KA'])}${between(10, 99)}${pick(['AB', 'CD', 'EF'])}${between(1000, 9999)}`,
      location, wage, users.supervisor,
    );
    q.run("UPDATE drivers SET status = 'deployed' WHERE id = ?", d.id);
    deployed.push({ ...d, empId, doj, wage, location });
  });

  return deployed;
}

function seedAttendance(deployed, users) {
  const now = today();
  // Two months of exceptions; everything unmarked defaults to P.
  const months = [now.slice(0, 7), addDays(`${now.slice(0, 7)}-01`, -1).slice(0, 7)];

  deployed.forEach((d) => {
    months.forEach((m) => {
      periodDays(m).forEach((day) => {
        if (day > now || day < d.doj) return;
        if (d.ended && day > d.leftOn) return;
        const r = rand();
        let code = null;
        if (r < 0.06) code = 'L';
        else if (r < 0.09) code = 'TA';
        else if (r < 0.11) code = 'T';
        if (!code) return;
        q.run(
          `INSERT INTO attendance(employment_id, day, code, marked_by) VALUES (?,?,?,?)
           ON CONFLICT(employment_id, day) DO NOTHING`,
          d.empId, day, code, users.supervisor,
        );
      });
      if (d.ended && d.leftOn.slice(0, 7) === m) {
        q.run(
          `INSERT INTO attendance(employment_id, day, code, remarks, marked_by) VALUES (?,?, 'LE', ?, ?)
           ON CONFLICT(employment_id, day) DO UPDATE SET code = 'LE'`,
          d.empId, d.leftOn, 'Resigned', users.supervisor,
        );
      }
    });
  });
}

function seedFinance(deployed, users) {
  const now = today();
  const active = deployed.filter((d) => !d.ended);

  // Advances across every stage of the approval chain.
  const stages = [
    { status: 'pending_sm', n: 4 },
    { status: 'pending_director', n: 3 },
    { status: 'approved', n: 6 },
    { status: 'paid', n: 12 },
    { status: 'rejected', n: 2 },
  ];
  stages.forEach(({ status, n }) => {
    for (let i = 0; i < n; i += 1) {
      const d = pick(active);
      if (!d) return;
      const amount = between(2, 15) * 500;
      const requestDate = addDays(now, -between(0, 40));
      const id = q.insert(
        `INSERT INTO advances(driver_id, employment_id, amount, reason, request_date, status,
          requested_by, cutoff, requested_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        d.id, d.empId, amount, pick(REASONS), requestDate, status,
        users.supervisor, rand() > 0.5 ? 'NOON' : 'EVENING', `${requestDate} 10:${between(10, 59)}:00`,
      );
      if (['pending_director', 'approved', 'paid'].includes(status)) {
        q.run(
          "UPDATE advances SET sm_by = ?, sm_at = ?, sm_remarks = 'Verified with supervisor' WHERE id = ?",
          users.manager, `${requestDate} 12:30:00`, id,
        );
      }
      if (['approved', 'paid'].includes(status)) {
        q.run(
          "UPDATE advances SET director_by = ?, director_at = ?, director_remarks = 'Approved' WHERE id = ?",
          users.director, `${addDays(requestDate, 1)} 11:00:00`, id,
        );
      }
      if (status === 'paid') {
        q.run(
          'UPDATE advances SET paid_at = ?, utr = ? WHERE id = ?',
          addDays(requestDate, 1), `HDFCN${between(100000000, 999999999)}`, id,
        );
      }
      if (status === 'rejected') {
        q.run(
          "UPDATE advances SET sm_by = ?, sm_at = ?, sm_remarks = 'Previous advance not yet recovered' WHERE id = ?",
          users.manager, `${requestDate} 15:00:00`, id,
        );
      }
    }
  });

  // Expenses on both sides of the Rs 3000 routing threshold.
  const expenses = [
    ['Safety shoes for new joiners', 'safety_shoe', 2400, 'expense', 'petty_cash', 'settled'],
    ['Medical check-up reimbursement', 'medical', 1800, 'reimbursement', 'petty_cash', 'approved'],
    ['Uniform set — 6 drivers', 'uniform', 5400, 'expense', 'accounts', 'pending_director'],
    ['Cab washing and detailing', 'repair', 900, 'expense', 'petty_cash', 'pending_sm'],
    ['First-aid kits for the fleet', 'other', 3200, 'expense', 'accounts', 'approved'],
    ['Local travel for document collection', 'travel', 650, 'reimbursement', 'petty_cash', 'settled'],
    ['Tyre replacement — emergency', 'repair', 7800, 'expense', 'accounts', 'settled'],
  ];
  expenses.forEach(([purpose, category, amount, kind, route, status]) => {
    const d = pick(active);
    const requestDate = addDays(now, -between(1, 30));
    const id = q.insert(
      `INSERT INTO expenses(driver_id, purpose, category, amount, kind, route, request_date,
        status, requested_by, requested_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      d?.id ?? null, purpose, category, amount, kind, route, requestDate, status,
      users.supervisor, `${requestDate} 09:${between(10, 59)}:00`,
    );
    if (status !== 'pending_sm') {
      q.run("UPDATE expenses SET sm_by = ?, sm_at = ?, sm_remarks = 'Checked' WHERE id = ?",
        users.manager, `${requestDate} 14:00:00`, id);
    }
    if (['approved', 'settled'].includes(status) && amount >= 3000) {
      q.run("UPDATE expenses SET director_by = ?, director_at = ? WHERE id = ?",
        users.director, `${addDays(requestDate, 1)} 10:00:00`, id);
    }
    if (status === 'settled') {
      const settledOn = addDays(requestDate, 2);
      q.run(
        `UPDATE expenses SET settled_at = ?, settled_by = ?, paid_amount = ?, txn_ref = ? WHERE id = ?`,
        settledOn, route === 'petty_cash' ? users.supervisor : users.accounts, amount,
        `TXN${between(10000000, 99999999)}`, id,
      );
      if (route === 'petty_cash') {
        q.run(
          `INSERT INTO petty_cash(supervisor_id, direction, amount, expense_id, note, entry_date, created_by)
           VALUES (?, 'spend', ?, ?, ?, ?, ?)`,
          users.supervisor, amount, id, purpose, settledOn, users.supervisor,
        );
      }
    }
  });

  // Petty cash float issued to both supervisors.
  [users.supervisor, users.supervisor2].forEach((sup) => {
    q.run(
      `INSERT INTO petty_cash(supervisor_id, direction, amount, note, entry_date, created_by)
       VALUES (?, 'issue', ?, 'Monthly petty cash float', ?, ?)`,
      sup, 15000, `${now.slice(0, 7)}-01`, users.accounts,
    );
  });
}

function seedCampaign(users) {
  const id = q.insert(
    `INSERT INTO campaigns(title, body, audience, status, total, sent_count, created_by, sent_at)
     VALUES (?,?,?,'sent',?,?,?, datetime('now'))`,
    'Safety refresher — Saturday',
    'Namaste {{name}}, safety refresher training is on Saturday 9 AM at {{location}}. ' +
      'Please report on time with your ID {{client_id}}. — Quantum',
    JSON.stringify({ deployedOnly: true }), 0, 0, users.manager,
  );
  const recipients = q.all(
    `SELECT d.id, d.phone FROM drivers d JOIN employments e ON e.driver_id = d.id AND e.status = 'active'`,
  );
  recipients.forEach((r) =>
    q.run(
      `INSERT INTO campaign_recipients(campaign_id, driver_id, phone, status, provider_id, sent_at)
       VALUES (?,?,?, 'sent', ?, datetime('now'))`,
      id, r.id, `91${r.phone}`, `sim-${r.id}`,
    ),
  );
  q.run('UPDATE campaigns SET total = ?, sent_count = ? WHERE id = ?', recipients.length, recipients.length, id);
}

console.log('Seeding Quantum Driver Management…');
tx(() => {
  reset();
  const users = seedUsers();
  const drivers = seedDrivers(users);
  const deployed = seedDeployments(drivers, users);
  seedAttendance(deployed, users);
  seedFinance(deployed, users);
  seedCampaign(users);

  console.log(`  users:       ${USERS.length}`);
  console.log(`  drivers:     ${drivers.length}`);
  console.log(`  deployments: ${deployed.length}`);
  console.log(`  advances:    ${q.scalar('SELECT count(*) FROM advances')}`);
  console.log(`  expenses:    ${q.scalar('SELECT count(*) FROM expenses')}`);
  console.log(`  attendance:  ${q.scalar('SELECT count(*) FROM attendance')} exception marks`);
});

console.log('\nSign in with any of these (password: Quantum@123):');
USERS.forEach(([name, email, role]) => console.log(`  ${role.padEnd(15)} ${email.padEnd(28)} ${name}`));
