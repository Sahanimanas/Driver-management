import { computePay } from './engine.js';

/**
 * Putting a salary structure into the salary master.
 *
 * Shared by the seed (a fresh database) and by scripts/load-client-structures.js
 * (an existing one), so a structure lands the same way either route. The query
 * helper is passed in, which keeps this module free of the database itself.
 */

function insertComponents(q, structureId, components) {
  components.forEach((c, i) => {
    q.run(
      `INSERT INTO salary_components(structure_id, seq, name, kind, calc, value, prorated,
         rounding, basis, cap, condition, employer, per_driver, is_basic, notes)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      structureId, i, c.name, c.kind, c.calc, c.value, c.prorated ? 1 : 0,
      c.rounding || 'none', c.basis || 'earned', c.cap || 0, c.condition || null,
      c.employer ? 1 : 0, c.per_driver ? 1 : 0, c.is_basic ? 1 : 0, c.notes || null,
    );
  });
}

/** The headline monthly gross, worked out the same way the salary master does. */
function storeGross(q, id, st) {
  const month = computePay(st, { payableDays: 30, daysInMonth: 30 });
  q.run(
    "UPDATE salary_structures SET monthly_gross = ?, updated_at = datetime('now') WHERE id = ?",
    month.monthlyGross, id,
  );
  return month.monthlyGross;
}

/** Add a structure and its components. Returns { id, gross }. */
export function installStructure(q, st, createdBy = null) {
  const id = q.insert(
    `INSERT INTO salary_structures(code, name, category, effective_from, ot_rate_hour,
       service_charge, gst_rate, tds_rate, register_format, role_label, notes, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    st.code, st.name, st.category, st.effective_from, st.ot_rate_hour || 0,
    st.service_charge || 0, st.gst_rate ?? 18, st.tds_rate || 0,
    st.register_format || 'standard', st.role_label || null, st.notes || null, createdBy,
  );
  insertComponents(q, id, st.components);
  return { id, gross: storeGross(q, id, st) };
}

/**
 * Bring an existing structure in line with a definition: its billing fields
 * and its components are replaced. Deployments linked to it stay linked.
 */
export function refreshStructure(q, id, st) {
  q.run(
    `UPDATE salary_structures SET name = ?, category = ?, effective_from = ?, ot_rate_hour = ?,
       service_charge = ?, gst_rate = ?, tds_rate = ?, register_format = ?, role_label = ?,
       notes = ? WHERE id = ?`,
    st.name, st.category, st.effective_from, st.ot_rate_hour || 0,
    st.service_charge || 0, st.gst_rate ?? 18, st.tds_rate || 0,
    st.register_format || 'standard', st.role_label || null, st.notes || null, id,
  );
  q.run('DELETE FROM salary_components WHERE structure_id = ?', id);
  insertComponents(q, id, st.components);
  return { id, gross: storeGross(q, id, st) };
}
