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

const BLANK_COMPONENT = { name: '', kind: 'earning', calc: 'fixed', value: '', prorated: true };

export default function SalaryMaster() {
  const { user } = useAuth();
  const toast = useToast();
  const canEdit = user.role === 'admin';
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
  const deductions = row.components.filter((c) => c.kind === 'deduction');

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

      <table className="tbl">
        <thead>
          <tr><th>Component</th><th>Basis</th><th className="right">Value</th><th>Prorated</th></tr>
        </thead>
        <tbody>
          {earnings.map((c) => (
            <tr key={c.id}>
              <td>{c.name}</td>
              <td className="small muted">{CALC_LABEL[c.calc]}</td>
              <td className="right mono">{c.calc === 'fixed' ? inr(c.value) : `${c.value}%`}</td>
              <td className="small muted">{c.prorated ? 'Yes' : 'No'}</td>
            </tr>
          ))}
          {deductions.length > 0 && (
            <tr><td colSpan={4} className="small muted" style={{ paddingTop: 10 }}><b>Deductions</b></td></tr>
          )}
          {deductions.map((c) => (
            <tr key={c.id}>
              <td>{c.name}</td>
              <td className="small muted">{CALC_LABEL[c.calc]}</td>
              <td className="right mono">{c.calc === 'fixed' ? inr(c.value) : `${c.value}%`}</td>
              <td className="small muted">{c.prorated ? 'Yes' : 'No'}</td>
            </tr>
          ))}
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
    notes: structure?.notes || '',
  });
  const [components, setComponents] = useState(
    structure?.components?.length
      ? structure.components.map((c) => ({ ...c, prorated: Boolean(c.prorated) }))
      : [{ ...BLANK_COMPONENT, name: 'Basic' }],
  );
  const [busy, setBusy] = useState(false);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const setC = (i, k, v) => setComponents((cs) => cs.map((c, j) => (j === i ? { ...c, [k]: v } : c)));
  const addC = () => setComponents((cs) => [...cs, { ...BLANK_COMPONENT }]);
  const delC = (i) => setComponents((cs) => cs.filter((_, j) => j !== i));

  // The same arithmetic the server does, so the total moves as you type.
  const monthlyGross = useMemo(() => {
    const basic = Number(components.find((c) => /^basic/i.test(c.name))?.value || 0);
    let gross = 0;
    components.filter((c) => c.kind === 'earning').forEach((c) => {
      if (c.calc === 'fixed') gross += Number(c.value || 0);
      else if (c.calc === 'percent_of_basic') gross += (basic * Number(c.value || 0)) / 100;
    });
    components.filter((c) => c.kind === 'earning' && c.calc === 'percent_of_gross').forEach((c) => {
      gross += (gross * Number(c.value || 0)) / 100;
    });
    return Math.round(gross * 100) / 100;
  }, [components]);

  async function submit() {
    setBusy(true);
    try {
      const payload = {
        ...form,
        ot_rate_hour: Number(form.ot_rate_hour) || 0,
        components: components
          .filter((c) => c.name.trim())
          .map((c, i) => ({ ...c, seq: i, value: Number(c.value) || 0 })),
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
        <Field label="Overtime rate / hour">
          <input type="number" min={0} value={form.ot_rate_hour} onChange={set('ot_rate_hour')} />
        </Field>
      </div>

      <h4 style={{ margin: '18px 0 8px' }}>Components</h4>
      <table className="tbl">
        <thead>
          <tr>
            <th style={{ width: '30%' }}>Name</th>
            <th>Type</th>
            <th>Basis</th>
            <th style={{ width: 110 }}>Value</th>
            <th>Prorated</th>
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
              <td className="right">
                <button className="sm" onClick={() => delC(i)} disabled={components.length === 1}>✕</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button className="sm" style={{ marginTop: 8 }} onClick={addC}>+ Add component</button>

      <div className="banner" style={{ marginTop: 14 }}>
        <span>ℹ</span>
        <div>
          A prorated component is scaled by payable days ÷ days in the month; the rest are paid
          whole. Payable days are P + T + TA — leave and left days are not paid.
        </div>
      </div>

      <Field label="Notes">
        <textarea rows={2} value={form.notes} onChange={set('notes')} />
      </Field>
    </Modal>
  );
}
