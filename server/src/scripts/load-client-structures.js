/**
 * Load the client's salary structures into an existing database.
 *
 *   npm run load-structures               add any that are missing; touch nothing else
 *   npm run load-structures -- --update   also bring existing ones in line with structures.js
 *   npm run load-structures -- --relink   also move ACTIVE deployments on the old placeholder
 *                                         structures (HZL-STD, MKT-STD) onto the client ones
 *
 * Unlike `npm run seed`, this never deletes anything. Drivers, deployments,
 * attendance and payroll stay exactly as they are; payroll lines already
 * collated keep the structure they were worked out on. `--relink` is opt-in
 * because it changes what drivers are paid from the next collation onward.
 */
import { q, tx, audit } from '../db.js';
import { CLIENT_STRUCTURES } from '../payroll/structures.js';
import { installStructure, refreshStructure } from '../payroll/install.js';

const args = new Set(process.argv.slice(2));
const UPDATE = args.has('--update');
const RELINK = args.has('--relink');

// Placeholder shipped with earlier builds -> the client structure that replaces it.
const REPLACES = { 'HZL-STD': 'HZL-LNG', 'MKT-STD': 'SURAT-LNG' };

const admin = q.get("SELECT id FROM users WHERE role = 'admin' AND active = 1 ORDER BY id LIMIT 1");

console.log('\nLoading the client salary structures\n');

tx(() => {
  for (const st of CLIENT_STRUCTURES) {
    const existing = q.get('SELECT id FROM salary_structures WHERE code = ?', st.code);
    if (!existing) {
      const { gross } = installStructure(q, st, admin?.id ?? null);
      console.log(`  added     ${st.code.padEnd(10)} ${st.name}  (monthly gross ${gross})`);
    } else if (UPDATE) {
      const { gross } = refreshStructure(q, existing.id, st);
      console.log(`  updated   ${st.code.padEnd(10)} ${st.name}  (monthly gross ${gross})`);
    } else {
      console.log(`  present   ${st.code.padEnd(10)} already in the salary master — pass --update to refresh it`);
    }
  }

  if (RELINK) {
    for (const [oldCode, newCode] of Object.entries(REPLACES)) {
      const from = q.get('SELECT id FROM salary_structures WHERE code = ?', oldCode);
      const to = q.get('SELECT id, monthly_gross FROM salary_structures WHERE code = ?', newCode);
      if (!from || !to) continue;
      const moved = q.run(
        `UPDATE employments SET salary_structure_id = ?, monthly_wage = ?
          WHERE salary_structure_id = ? AND status = 'active'`,
        to.id, to.monthly_gross, from.id,
      ).changes;
      console.log(`  relinked  ${moved} active deployment(s) from ${oldCode} to ${newCode}`);
    }
  }

  audit(admin?.id ?? null, 'salary_structure', null, 'client_structures_loaded', {
    update: UPDATE, relink: RELINK,
  });
});

console.log('\nDeployments on each structure now:');
q.all(
  `SELECT s.code, s.name,
          (SELECT count(*) FROM employments e WHERE e.salary_structure_id = s.id AND e.status = 'active') AS active
   FROM salary_structures s ORDER BY s.code`,
).forEach((s) => console.log(`  ${s.code.padEnd(10)} ${String(s.active).padStart(3)} active   ${s.name}`));

if (!RELINK && q.get("SELECT 1 FROM salary_structures WHERE code IN ('HZL-STD','MKT-STD')")) {
  console.log('\nDrivers are still on the old placeholder structures. Move them in the app');
  console.log('(Deployments → Edit → Salary structure), or re-run with --relink.\n');
}
