import React, { useMemo, useState } from 'react';
import { Page } from '../App.jsx';
import { api } from '../lib/api.js';
import {
  useAsync, useAuth, useToast, Card, Field, Modal, Loading, ErrorBanner, Empty, Stat,
} from '../lib/ui.jsx';
import { inr } from '../lib/format.js';

/**
 * The salary master — "to cover all types of salaries which needs to be given
 * to drivers: HZL Drivers / Market Drivers".
 *
 * A structure is a list of components. The preview panel is the important part
 * of the screen: it shows what the structure actually pays at a given number of
 * payable days, so a change can be checked before any driver is on it.
 */

const CALC_LABEL = {
  fixed: 'Fixed amount',
  percent_of_basic: '% of Basic',
  percent_of_gross: '% of Gross',
};

const BLANK_COMPONENT = {
  name: '', kind: 'earning', calc: 'fixed', value: '', prorated: true,
  rounding: 'none', basis: 'earned', cap: '', condition: '',
  employer: false, per_driver: false, is_basic: false,
};

/** "Only if", as a choice and a number rather than a code to type. */
function ConditionInput({ value, kind, onChange }) {
  const [op, n = ''] = value ? value.split(':') : ['', ''];
  const options = [
    ['', 'Always'],
    ['days_gte', 'If payable days ≥'],
    // Gross is only known once the earnings are added up, so only a
    // deduction can depend on it.
    ...(kind === 'deduction' || op.startsWith('gross') ? [['gross_gt', 'If gross >'], ['gross_lte', 'If gross ≤']] : []),
  ];
  return (
    <>
      <select value={op} onChange={(e) => onChange(e.target.value ? `${e.target.value}:${n}` : '')}>
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
      {op && (
        <input type="number" min={0} value={n} placeholder={op === 'days_gte' ? '30' : '12000'}
          style={{ marginTop: 4 }} onChange={(e) => onChange(`${op}:${e.target.value}`)} />
      )}
    </>
  );
}

/** The basic is the earning whose name starts with "Basic" (Basic, Basic + DA ...). */
const isBasicName = (name) => /^\s*basic/i.test(String(name || ''));

/** An earning named LSA is paid per driver: the amount is on each driver's deployment. */
const isLsaName = (name) => /^\s*lsa\b/i.test(String(name || ''));

/** Mark the first earning named Basic as the basic, and only that one. */
function withBasic(components) {
  const at = components.findIndex((c) => c.kind === 'earning' && isBasicName(c.name));
  if (at < 0) return components;
  return components.map((c, i) => ({ ...c, is_basic: i === at }));
}

const FORMAT_LABEL = {
  standard: 'Standard',
  hzl: 'HZL register',
  surat: 'Surat register',
};

/** The rules on a component, in words, for the structure card. */
function ruleText(c) {
  const out = [];
  if (c.rounding === 'rupee') out.push('rounded to ₹');
  if (Number(c.cap) > 0) out.push(`capped at ${inr(c.cap)}`);
  if (c.condition) {
    const [k, n] = c.condition.split(':');
    out.push({ days_gte: `only at ${n}+ days`, gross_gt: `only if gross > ${n}`, gross_lte: `only if gross ≤ ${n}` }[k]
      || c.condition);
  }
  if (c.employer) out.push('employer cost');
  return out.join(' · ');
}

export default function SalaryMaster() {
  const { can } = useAuth();
  const toast = useToast();
  const canEdit = can('salary_master.manage');
  const [editing, setEditing] = useState(null);
  const [creating, setCreating] = useState(false);

  const { data, loading, error, reload } = useAsync(() => api.get('/salary-master'), []);
  const rows = data?.rows || [];

  const totals = useMemo(() => ({
    structures: rows.length,
    hzl: rows.filter((r) => r.category === 'HZL').length,
    market: rows.filter((r) => r.category === 'MARKET').length,
    linked: rows.reduce((s, r) => s + r.deployments, 0),
  }), [rows]);

  async function remove(row) {
    if (!window.confirm(`Delete the salary structure ${row.code}? This cannot be undone.`)) return;
    try {
      await api.del(`/salary-master/${row.id}`);
      toast.success(`${row.code} deleted`);
      reload();
    } catch (err) {
      toast.error(err);
    }
  }

  async function toggleActive(row) {
    try {
      await api.patch(`/salary-master/${row.id}`, { active: row.active ? 0 : 1 });
      toast.success(`${row.code} ${row.active ? 'deactivated' : 'reactivated'}`);
      reload();
    } catch (err) {
      toast.error(err);
    }
  }

  return (
    <Page
      title="Salary master"
      subtitle="The salary structures a deployment can be linked to"
      actions={(
        <>
          <button onClick={() => api.download('/salary-master/export/all', 'salary-master.xlsx')}>
            Download
          </button>
          {canEdit && (
            <button className="primary" onClick={() => setCreating(true)}>+ New structure</button>
          )}
        </>
      )}
    >
      <ErrorBanner error={error} onRetry={reload} />

      <div className="grid c4" style={{ marginBottom: 16 }}>
        <Stat tone="accent" label="Structures" value={totals.structures} />
        <Stat label="HZL Drivers" value={totals.hzl} />
        <Stat label="Market Drivers" value={totals.market} />
        <Stat label="Deployments linked" value={totals.linked} tone={totals.linked ? "good" : "warn"} />
      </div>

      {!canEdit && (
        <div className="banner">
          <span>ℹ</span>
          <div>
            The salary master is maintained by Admin / Director. You can read every structure and
            download it, but not change one.
          </div>
        </div>
      )}

      {loading && !data ? <Loading what="the salary master" /> : (
        <div className="grid c2">
          {rows.length === 0 && (
            <Card><div className="muted">
              No salary structures yet. The scope names two — HZL Drivers and Market Drivers —
              and a deployment must be linked to one of them.
            </div></Card>
          )}
          {rows.map((row) => (
            <StructureCard
              key={row.id}
              row={row}
              canEdit={canEdit}
              onEdit={() => setEditing(row)}
              onDelete={() => remove(row)}
              onToggle={() => toggleActive(row)}
            />
          ))}
        </div>
      )}

      {(creating || editing) && (
        <StructureModal
          structure={editing}
          categoryLabels={data?.categoryLabels}
          onClose={() => { setCreating(false); setEditing(null); }}
          onDone={() => { setCreating(false); setEditing(null); reload(); }}
        />
      )}
    </Page>
  );
}

function StructureCard({ row, canEdit, onEdit, onDelete, onToggle }) {
  const [days, setDays] = useState(30);
  const { data: preview } = useAsync(
    () => api.get(`/salary-master/${row.id}/preview?payable_days=${days}&days_in_month=30`),
    [row.id, days, row.monthly_gross],
  );

  const earnings = row.components.filter((c) => c.kind === 'earning');
  const deductions = row.components.filter((c) => c.kind === 'deduction' && !c.employer);
  const employer = row.components.filter((c) => c.kind === 'deduction' && c.employer);
  const line = (c) => (
    <tr key={c.id}>
      <td>
        {c.name}
        {ruleText(c) && <div className="small muted">{ruleText(c)}</div>}
      </td>
      <td className="small muted">{CALC_LABEL[c.calc]}</td>
      <td className="right mono">{c.calc === 'fixed' ? inr(c.value) : `${c.value}%`}</td>
      <td className="small muted">{c.prorated ? 'Yes' : 'No'}</td>
    </tr>
  );
  const heading = (text) => (
    <tr><td colSpan={4} className="small muted" style={{ paddingTop: 10 }}><b>{text}</b></td></tr>
  );

  return (
    <Card
      title={<>{row.name} <span className="mono small muted">{row.code}</span></>}
      actions={canEdit && (
        <>
          <button className="sm" onClick={onEdit}>Edit</button>{' '}
          <button className="sm" onClick={onToggle}>{row.active ? 'Deactivate' : 'Activate'}</button>{' '}
          <button className="sm" onClick={onDelete}>Delete</button>
        </>
      )}
    >
      <div className="row wrap" style={{ marginBottom: 10 }}>
        <span className={`chip ${row.category === 'HZL' ? 'blue' : 'amber'}`}>
          {row.category === 'HZL' ? 'HZL Drivers' : 'Market Drivers'}
        </span>
        {row.active ? <span className="chip green">Active</span> : <span className="chip grey">Inactive</span>}
        <span className="chip">{row.deployments} deployment{row.deployments === 1 ? '' : 's'}</span>
        <span className="small muted">Effective {row.effective_from}</span>
      </div>
      {(row.service_charge > 0 || row.register_format !== 'standard') && (
        <div className="small muted" style={{ marginBottom: 10 }}>
          Billing: service charge <b>{inr(row.service_charge)}</b>/person/month on days present
          {' '}· GST {row.gst_rate}%{row.tds_rate > 0 && <> · TDS {row.tds_rate}%</>}
          {' '}· {FORMAT_LABEL[row.register_format] || row.register_format}
        </div>
      )}

      <table className="tbl">
        <thead>
          <tr><th>Component</th><th>Calculated as</th><th className="right">Value</th><th>Prorated</th></tr>
        </thead>
        <tbody>
          {earnings.map(line)}
          {deductions.length > 0 && heading('Deductions')}
          {deductions.map(line)}
          {employer.length > 0 && heading('Employer contributions (company cost, not deducted)')}
          {employer.map(line)}
        </tbody>
      </table>

      <div className="banner" style={{ marginTop: 12 }}>
        <span>₹</span>
        <div style={{ flex: 1 }}>
          <div className="row" style={{ alignItems: 'center' }}>
            <span className="small">At</span>
            <input
              type="number" min={0} max={31} value={days} style={{ width: 64 }}
              onChange={(e) => setDays(Math.max(0, Math.min(31, Number(e.target.value))))}
            />
            <span className="small">payable days of 30:</span>
          </div>
          {preview ? (
            <div className="small" style={{ marginTop: 6 }}>
              Gross <b>{inr(preview.gross)}</b>
              {preview.statutoryDeduction > 0 && <> · deductions <b>{inr(preview.statutoryDeduction)}</b></>}
              {' '}· net <b>{inr(preview.net)}</b>
              {' '}· full month <b>{inr(preview.monthlyGross)}</b>
              {' '}· rate/day <b>{inr(preview.ratePerDay)}</b>
            </div>
          ) : <div className="small muted" style={{ marginTop: 6 }}>calculating…</div>}
        </div>
      </div>

      {row.notes && <div className="small muted" style={{ marginTop: 10 }}>{row.notes}</div>}
    </Card>
  );
}

function StructureModal({ structure, onClose, onDone }) {
  const toast = useToast();
  const [form, setForm] = useState({
    code: structure?.code || '',
    name: structure?.name || '',
    category: structure?.category || 'HZL',
    effective_from: structure?.effective_from || new Date().toISOString().slice(0, 10),
    ot_rate_hour: structure?.ot_rate_hour ?? 0,
    service_charge: structure?.service_charge ?? 0,
    gst_rate: structure?.gst_rate ?? 18,
    tds_rate: structure?.tds_rate ?? 0,
    register_format: structure?.register_format || 'standard',
    role_label: structure?.role_label || '',
    notes: structure?.notes || '',
  });
  const [components, setComponents] = useState(
    structure?.components?.length
      ? structure.components.map((c) => ({
        ...BLANK_COMPONENT,
        ...c,
        prorated: Boolean(c.prorated),
        employer: Boolean(c.employer),
        per_driver: Boolean(c.per_driver),
        is_basic: Boolean(c.is_basic),
        cap: c.cap || '',
        condition: c.condition || '',
      }))
      : [{ ...BLANK_COMPONENT, name: 'Basic', is_basic: true }],
  );
  const [busy, setBusy] = useState(false);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const setC = (i, k, v) => setComponents((cs) => cs.map((c, j) => (j === i ? { ...c, [k]: v } : c)));
  const addC = () => setComponents((cs) => [...cs, { ...BLANK_COMPONENT }]);
  const delC = (i) => setComponents((cs) => cs.filter((_, j) => j !== i));

  // Roughly the server's arithmetic for a full month, so the total moves as you
  // type; the card preview is exact.
  const monthlyGross = useMemo(() => {
    const basicC = components.find((c) => c.kind === 'earning' && isBasicName(c.name));
    const basic = Number(basicC?.value || 0);
    let gross = 0;
    // LSA is set per driver, so it is not part of the structure's own gross.
    components.filter((c) => c.kind === 'earning' && !isLsaName(c.name)).forEach((c) => {
      if (c.calc === 'fixed') gross += Number(c.value || 0);
      else if (c.calc === 'percent_of_basic') gross += (basic * Number(c.value || 0)) / 100;
    });
    // Each % of gross is taken of the other earnings, as the pay engine does.
    const base = gross;
    components.filter((c) => c.kind === 'earning' && c.calc === 'percent_of_gross').forEach((c) => {
      gross += (base * Number(c.value || 0)) / 100;
    });
    return Math.round(gross * 100) / 100;
  }, [components]);

  async function submit() {
    setBusy(true);
    try {
      const payload = {
        ...form,
        ot_rate_hour: Number(form.ot_rate_hour) || 0,
        service_charge: Number(form.service_charge) || 0,
        gst_rate: Number(form.gst_rate) || 0,
        tds_rate: Number(form.tds_rate) || 0,
        components: withBasic(components.filter((c) => c.name.trim()))
          .map((c, i) => ({
            ...c,
            seq: i,
            value: Number(c.value) || 0,
            cap: Number(c.cap) || 0,
            condition: c.condition.trim(),
            // LSA differs from driver to driver; every other amount is the
            // structure's own. A % of Basic is always of the basic earned.
            per_driver: c.kind === 'earning' && isLsaName(c.name),
            basis: 'earned',
          })),
      };
      if (structure) await api.patch(`/salary-master/${structure.id}`, payload);
      else await api.post('/salary-master', payload);
      toast.success(structure ? `${form.code} updated` : `${form.code} created`);
      onDone();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      wide
      title={structure ? `Edit ${structure.code}` : 'New salary structure'}
      onClose={onClose}
      footer={(
        <>
          <span className="muted small" style={{ marginRight: 'auto' }}>
            Full month gross: <b>{inr(monthlyGross)}</b>
          </span>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={submit} disabled={busy}>
            {busy ? <span className="spinner" /> : 'Save'}
          </button>
        </>
      )}
    >
      <div className="grid c2">
        <Field label="Code" hint="short, unique">
          <input
            value={form.code}
            onChange={(e) => setForm((f) => ({ ...f, code: e.target.value.toUpperCase() }))}
            disabled={!!structure}
            placeholder="HZL-STD"
          />
        </Field>
        <Field label="Name">
          <input value={form.name} onChange={set('name')} placeholder="HZL Driver — Standard" />
        </Field>
        <Field label="Category">
          <select value={form.category} onChange={set('category')}>
            <option value="HZL">HZL Drivers</option>
            <option value="MARKET">Market Drivers</option>
          </select>
        </Field>
        <Field label="Effective from">
          <input type="date" value={form.effective_from} onChange={set('effective_from')} />
        </Field>
        <Field label="Overtime rate / hour" hint="recorded only — overtime hours are not captured yet">
          <input type="number" min={0} value={form.ot_rate_hour} onChange={set('ot_rate_hour')} />
        </Field>
        <Field label="Designation on the register" hint="e.g. LNG Tip Trailer Driver">
          <input value={form.role_label} onChange={set('role_label')} />
        </Field>
      </div>

      <h4 style={{ margin: '18px 0 8px' }}>Billing to the client</h4>
      <div className="grid c4">
        <Field label="Service charge" hint="per person / month, on days present">
          <input type="number" min={0} value={form.service_charge} onChange={set('service_charge')} />
        </Field>
        <Field label="GST %">
          <input type="number" min={0} max={100} step="0.01" value={form.gst_rate} onChange={set('gst_rate')} />
        </Field>
        <Field label="TDS %" hint="deducted by the client">
          <input type="number" min={0} max={100} step="0.01" value={form.tds_rate} onChange={set('tds_rate')} />
        </Field>
        <Field label="Pay register layout">
          <select value={form.register_format} onChange={set('register_format')}>
            {Object.entries(FORMAT_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </Field>
      </div>

      <h4 style={{ margin: '18px 0 8px' }}>Components</h4>
      <table className="tbl">
        <thead>
          <tr>
            {['Name', 'Type', 'Calculated as', 'Value', 'Prorated', 'Round', 'Cap', 'Only if', 'Employer'].map((h) => (
              <th key={h} style={{ width: { Name: '20%', Value: 100, Cap: 90, 'Only if': 140 }[h] }}>{h}</th>
            ))}
            <th />
          </tr>
        </thead>
        <tbody>
          {components.map((c, i) => (
            <tr key={i}>
              <td><input value={c.name} onChange={(e) => setC(i, 'name', e.target.value)} placeholder="Basic" /></td>
              <td>
                <select value={c.kind} onChange={(e) => setC(i, 'kind', e.target.value)}>
                  <option value="earning">Earning</option>
                  <option value="deduction">Deduction</option>
                </select>
              </td>
              <td>
                <select value={c.calc} onChange={(e) => setC(i, 'calc', e.target.value)}>
                  <option value="fixed">Fixed amount</option>
                  <option value="percent_of_basic">% of Basic</option>
                  <option value="percent_of_gross">% of Gross</option>
                </select>
              </td>
              <td>
                <input type="number" min={0} step="0.01" value={c.value}
                  onChange={(e) => setC(i, 'value', e.target.value)} />
              </td>
              <td style={{ textAlign: 'center' }}>
                <input type="checkbox" checked={c.prorated}
                  onChange={(e) => setC(i, 'prorated', e.target.checked)} />
              </td>
              <td>
                <select value={c.rounding} onChange={(e) => setC(i, 'rounding', e.target.value)}>
                  <option value="none">Paise</option>
                  <option value="rupee">Rupee</option>
                </select>
              </td>
              <td>
                <input type="number" min={0} value={c.cap} placeholder="—"
                  onChange={(e) => setC(i, 'cap', e.target.value)} />
              </td>
              <td>
                <ConditionInput value={c.condition} kind={c.kind}
                  onChange={(v) => setC(i, 'condition', v)} />
              </td>
              <td style={{ textAlign: 'center' }}>
                {c.kind === 'deduction' && (
                  <input type="checkbox" checked={c.employer}
                    onChange={(e) => setC(i, 'employer', e.target.checked)} />
                )}
              </td>
              <td className="right">
                <button className="sm" onClick={() => delC(i)} disabled={components.length === 1}>✕</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button className="sm" style={{ marginTop: 8 }} onClick={addC}>+ Add component</button>

      <div className="muted small" style={{ marginTop: 10, marginBottom: 12 }}>
        % of Basic is taken of the earning named Basic. An earning named LSA is paid per
        driver — its amount is set on each driver's deployment, not here.
      </div>

      <Field label="Notes">
        <textarea rows={2} value={form.notes} onChange={set('notes')} />
      </Field>
    </Modal>
  );
}
