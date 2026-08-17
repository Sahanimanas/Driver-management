import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Page } from '../App.jsx';
import { api } from '../lib/api.js';
import { useAsync, useAuth, useToast, Card, Field, Modal, Loading, ErrorBanner } from '../lib/ui.jsx';
import { periodLabel, shiftPeriod, thisPeriod, today } from '../lib/format.js';

const CODES = ['P', 'T', 'TA', 'L', 'LE'];
const LABEL = { P: 'Driving / Present', T: 'Training', TA: 'In Transit', L: 'Leave', LE: 'Resigned / Left' };
const NEXT = { P: 'L', L: 'T', T: 'TA', TA: 'P', LE: 'P' };

export default function Attendance() {
  const { can } = useAuth();
  const toast = useToast();
  const [period, setPeriod] = useState(thisPeriod());
  const [location, setLocation] = useState('');
  const [search, setSearch] = useState('');
  const [pending, setPending] = useState({}); // "empId|day" -> code
  const [saving, setSaving] = useState(false);
  const [bulkFor, setBulkFor] = useState(null);

  const locations = useAsync(() => api.get('/drivers/locations'), []);
  const { data, loading, error, reload } = useAsync(
    () => api.get(`/attendance/sheet?period=${period}&location=${encodeURIComponent(location)}&search=${encodeURIComponent(search)}`),
    [period, location, search],
  );

  const editable = can('supervisor', 'senior_manager');
  const pendingCount = Object.keys(pending).length;

  const days = data?.days || [];
  const weekend = useMemo(
    () => Object.fromEntries(days.map((d) => [d, [0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay())])),
    [days],
  );

  function cycle(row, day) {
    const cell = row.cells[day];
    if (!editable || !cell?.applicable || cell.locked || day > today()) return;
    const key = `${row.employment_id}|${day}`;
    const current = pending[key] || cell.code;
    setPending((p) => ({ ...p, [key]: NEXT[current] }));
  }

  async function save() {
    setSaving(true);
    try {
      const marks = Object.entries(pending).map(([key, code]) => {
        const [employment_id, day] = key.split('|');
        return { employment_id: Number(employment_id), day, code };
      });
      const res = await api.post('/attendance/mark', { marks });
      if (res.errors?.length) {
        toast.error(`${res.saved} saved, ${res.errors.length} rejected — ${res.errors[0].error}`);
      } else {
        toast.success(`${res.saved} attendance mark(s) saved`);
      }
      setPending({});
      reload();
    } catch (err) {
      toast.error(err);
    } finally {
      setSaving(false);
    }
  }

  const summaryOf = (row) => {
    const counts = { ...row.summary };
    Object.entries(pending).forEach(([key, code]) => {
      const [empId, day] = key.split('|');
      if (Number(empId) !== row.employment_id) return;
      const was = row.cells[day]?.code;
      if (was && was !== code) {
        counts[was] -= 1;
        counts[code] += 1;
      }
    });
    return counts;
  };

  return (
    <Page
      title="Attendance"
      subtitle={`${periodLabel(period)} — click a cell to cycle the code`}
      actions={<>
        {pendingCount > 0 && (
          <>
            <button onClick={() => setPending({})}>Discard {pendingCount}</button>
            <button className="primary" onClick={save} disabled={saving}>
              {saving ? <span className="spinner" /> : `Save ${pendingCount} change${pendingCount === 1 ? '' : 's'}`}
            </button>
          </>
        )}
        <button onClick={() => api.download(`/attendance/export?period=${period}`, `attendance-${period}.xlsx`)}>
          ⭳ Export
        </button>
      </>}
    >
      <div className="toolbar">
        <button onClick={() => setPeriod(shiftPeriod(period, -1))}>‹ Previous</button>
        <input type="month" value={period} onChange={(e) => setPeriod(e.target.value)} style={{ width: 160 }} />
        <button onClick={() => setPeriod(shiftPeriod(period, 1))}
          disabled={period >= thisPeriod()}>Next ›</button>
        <select value={location} onChange={(e) => setLocation(e.target.value)}>
          <option value="">All locations</option>
          {(locations.data || []).map((l) => <option key={l} value={l}>{l}</option>)}
        </select>
        <input placeholder="Filter driver / ID / vehicle" value={search}
          onChange={(e) => setSearch(e.target.value)} style={{ minWidth: 220 }} />
        <div className="spacer" />
        <div className="att-legend">
          {CODES.map((c) => (
            <span className="k" key={c}>
              <span className={`sw att-cell ${c}`} style={{ textAlign: 'center', lineHeight: '16px' }}>{c}</span>
              {LABEL[c]}
            </span>
          ))}
        </div>
      </div>

      {data?.locked && (
        <div className="banner warn">
          <span>🔒</span>
          <div>Payroll for {periodLabel(period)} has been closed — this register is locked.</div>
        </div>
      )}
      {!editable && (
        <div className="banner info">
          <span>ℹ</span>
          <div>Attendance is marked by supervisors. You have read-only access to this register.</div>
        </div>
      )}
      <ErrorBanner error={error} onRetry={reload} />

      <Card tight>
        {!data ? (error ? null : <Loading what="the register" />) : (
          <div className="tbl-wrap" style={{ maxHeight: '70vh' }}>
            <table className="tbl att-grid">
              <thead>
                <tr>
                  <th className="name-cell">Driver ({data.rows.length})</th>
                  {days.map((d) => (
                    <th key={d} className={`day${weekend[d] ? ' we' : ''}`}>{d.slice(-2)}</th>
                  ))}
                  {CODES.map((c) => <th key={c} className="day" title={LABEL[c]}>{c}</th>)}
                  <th className="day" />
                </tr>
              </thead>
              <tbody>
                {data.rows.length === 0 && (
                  <tr><td className="empty" colSpan={days.length + 7}>
                    No drivers were deployed during {periodLabel(period)}.
                  </td></tr>
                )}
                {data.rows.map((row) => {
                  const counts = summaryOf(row);
                  return (
                    <tr key={row.employment_id}>
                      <td className="name-cell">
                        <div className="stack">
                          <Link to={`/drivers/${row.driver_id}`}><b>{row.name}</b></Link>
                          <span className="muted small">
                            <span className="mono">{row.client_id}</span>
                            {row.vehicle_number && ` · ${row.vehicle_number}`}
                            {row.location && ` · ${row.location}`}
                          </span>
                        </div>
                      </td>
                      {days.map((day) => {
                        const cell = row.cells[day];
                        const key = `${row.employment_id}|${day}`;
                        const code = pending[key] || cell?.code;
                        if (!cell?.applicable) {
                          return <td key={day}><span className="att-cell na" title="Outside deployment period" /></td>;
                        }
                        const future = day > today();
                        return (
                          <td key={day}>
                            <button
                              className={`att-cell ${code}${!cell.explicit && !pending[key] ? ' implicit' : ''}${cell.locked ? ' locked' : ''}`}
                              title={`${day} — ${LABEL[code]}${cell.explicit ? '' : ' (default)'}${cell.locked ? ' · locked' : ''}`}
                              disabled={!editable || cell.locked || future}
                              onClick={() => cycle(row, day)}
                            >
                              {pending[key] ? `${code}*` : code}
                            </button>
                          </td>
                        );
                      })}
                      {CODES.map((c) => (
                        <td key={c} style={{ textAlign: 'center', fontWeight: 600 }}>
                          {counts[c] || <span className="muted">·</span>}
                        </td>
                      ))}
                      <td style={{ textAlign: 'center' }}>
                        {editable && !data.locked && (
                          <button className="sm ghost" title="Fill a date range"
                            onClick={() => setBulkFor(row)}>▤</button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <p className="small muted">
        Cells shown faintly are the default — an unmarked day for a deployed driver counts as
        <b> P (Driving/Present)</b>. A cell marked <b>*</b> is an unsaved change. Marking <b>LE</b> closes
        the deployment on that date and stops billing.
      </p>

      {bulkFor && (
        <BulkModal
          row={bulkFor} period={period}
          onClose={() => setBulkFor(null)}
          onDone={(n) => { setBulkFor(null); toast.success(`${n} day(s) updated`); reload(); }}
        />
      )}
    </Page>
  );
}

function BulkModal({ row, period, onClose, onDone }) {
  const toast = useToast();
  const [form, setForm] = useState({
    from: `${period}-01`, to: `${period}-07`, code: 'L', remarks: '',
  });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit() {
    setBusy(true);
    try {
      const res = await api.post('/attendance/bulk-range', { employment_id: row.employment_id, ...form });
      if (res.errors?.length) toast.error(`${res.saved} saved, ${res.errors.length} rejected`);
      onDone(res.saved);
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={`Fill a date range — ${row.name}`} onClose={onClose}
      footer={<>
        <button onClick={onClose}>Cancel</button>
        <button className="primary" onClick={submit} disabled={busy}>Apply</button>
      </>}>
      <div className="grid c3">
        <Field label="From"><input type="date" value={form.from} onChange={set('from')} /></Field>
        <Field label="To"><input type="date" value={form.to} onChange={set('to')} /></Field>
        <Field label="Code">
          <select value={form.code} onChange={set('code')}>
            {CODES.map((c) => <option key={c} value={c}>{c} — {LABEL[c]}</option>)}
          </select>
        </Field>
      </div>
      <Field label="Remarks" hint="optional"><input value={form.remarks} onChange={set('remarks')} /></Field>
      <p className="small muted">Days outside the deployment period, and days in the future, are skipped.</p>
    </Modal>
  );
}
