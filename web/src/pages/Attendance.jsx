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
  const [uploadOpen, setUploadOpen] = useState(false);

  const locations = useAsync(() => api.get('/drivers/locations'), []);
  const { data, loading, error, reload } = useAsync(
    () => api.get(`/attendance/sheet?period=${period}&location=${encodeURIComponent(location)}&search=${encodeURIComponent(search)}`),
    [period, location, search],
  );

  const editable = can('supervisor');
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
        {editable && (
          <button onClick={() => setUploadOpen(true)}>⭱ Bulk upload</button>
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
                            <span className="mono">{row.registration_no}</span>
                            {row.client_id && <> · <span className="mono">{row.client_id}</span></>}
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
                          // A day that has not happened yet is simply empty; a
                          // day outside the deployment is struck out.
                          return (
                            <td key={day}>
                              <span
                                className={`att-cell ${cell?.future ? 'future' : 'na'}`}
                                title={cell?.future ? 'Not yet — this day has not happened' : 'Outside deployment period'}
                              />
                            </td>
                          );
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
        Cells shown faintly are the default — an unmarked day that has <i>already passed</i> counts as
        <b> P (Driving/Present)</b> for a deployed driver. An empty dashed cell is a day that has not
        happened yet, and a hatched cell falls outside the driver's deployment; neither carries
        attendance, here or in the export. A cell marked <b>*</b> is an unsaved change. Marking
        <b> LE</b> closes the deployment on that date and stops billing.
      </p>

      {bulkFor && (
        <BulkModal
          row={bulkFor} period={period}
          onClose={() => setBulkFor(null)}
          onDone={(n) => { setBulkFor(null); toast.success(`${n} day(s) updated`); reload(); }}
        />
      )}

      {uploadOpen && (
        <BulkUploadModal
          period={period}
          onClose={() => setUploadOpen(false)}
          onDone={() => { setUploadOpen(false); reload(); }}
        />
      )}
    </Page>
  );
}

/**
 * "Pls put provision to upload bulk attendance of drivers if required."
 *
 * Download the month as a sheet, edit it offline, upload it back. The upload
 * is checked first and the changes are shown before anything is written, so a
 * wrong month or a stray column never lands silently on the register.
 */
function BulkUploadModal({ period, onClose, onDone }) {
  const toast = useToast();
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(null);

  async function send(commit) {
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('period', period);
      if (commit) fd.append('commit', 'true');
      const res = await api.upload('/attendance/upload', fd);

      if (commit) {
        toast.success(`${res.saved} attendance day(s) saved from the sheet`);
        if (res.errors?.length) {
          toast.error(`${res.errors.length} row(s) were refused — ${res.errors[0].reason}`);
        }
        onDone();
      } else {
        setPreview(res);
        if (!res.changes) toast.info('The sheet matches what is already on the register.');
      }
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      wide
      title={`Bulk attendance upload — ${periodLabel(period)}`}
      onClose={onClose}
      footer={(
        <>
          <button onClick={onClose}>Cancel</button>
          <button onClick={() => send(false)} disabled={busy || !file}>
            {busy ? <span className="spinner" /> : 'Check the file'}
          </button>
          <button className="primary" onClick={() => send(true)} disabled={busy || !file || !preview?.changes}>
            {preview?.changes ? `Apply ${preview.changes} change(s)` : 'Apply'}
          </button>
        </>
      )}
    >
      <ol className="steps-list">
        <li>
          Download the month, pre-filled with every deployed driver and their current marks.
          <div style={{ marginTop: 6 }}>
            <button onClick={() => api.download(
              `/attendance/template?period=${period}`, `attendance-upload-${period}.xlsx`,
            )}>⭳ Download the template</button>
          </div>
        </li>
        <li>
          Edit the day columns only. Leave a cell blank to leave that day alone, and do not touch the
          <b> Deployment ID</b> column — it is how each row is matched.
        </li>
        <li>
          Upload it back and check the summary before applying.
          <div style={{ marginTop: 6 }}>
            <input type="file" accept=".xlsx,.xls,.csv" onChange={(e) => {
              setFile(e.target.files[0]);
              setPreview(null);
            }} />
          </div>
        </li>
      </ol>

      {preview && (
        <div className={`banner ${preview.changes ? 'success' : ''}`} style={{ marginTop: 12 }}>
          <span>{preview.changes ? '✓' : 'ℹ'}</span>
          <div style={{ flex: 1 }}>
            <b>{preview.message}</b>
            <div className="small muted" style={{ marginTop: 4 }}>
              {preview.marks} cell(s) read across {preview.drivers} driver(s).
            </div>
            {preview.rejected?.length > 0 && (
              <table className="tbl" style={{ marginTop: 8 }}>
                <thead><tr><th>Row</th><th>Driver</th><th>Day</th><th>Why it was skipped</th></tr></thead>
                <tbody>
                  {preview.rejected.slice(0, 8).map((r, i) => (
                    <tr key={i}>
                      <td>{r.row}</td><td>{r.driver}</td><td>{r.day || '—'}</td><td>{r.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      <p className="small muted">
        Codes: {CODES.map((c) => `${c} = ${LABEL[c]}`).join('   ·   ')}
      </p>
    </Modal>
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
