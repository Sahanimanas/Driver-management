import React, { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Page } from '../App.jsx';
import { api } from '../lib/api.js';
import { useAsync, useAuth, useToast, Card, Field, Modal, Loading, ErrorBanner, Empty, Stat } from '../lib/ui.jsx';

const TYPES = ['GMC', 'GPA', 'GTL', 'WC'];
const LABEL = {
  GMC: 'Group Medical Cover', GPA: 'Group Personal Accident',
  GTL: 'Group Term Life', WC: 'Workmen Compensation',
};

export default function Insurance() {
  const { can } = useAuth();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState('');
  const [importOpen, setImportOpen] = useState(false);
  const [editing, setEditing] = useState(null);

  const type = params.get('type') || '';
  const covered = params.get('covered') || '';

  const { data, loading, error, reload } = useAsync(
    () => api.get(`/insurance?search=${encodeURIComponent(search)}&type=${type}&covered=${covered}`),
    [search, type, covered],
  );

  const editable = can('supervisor', 'senior_manager', 'accounts');

  async function toggle(driverId, t, current) {
    try {
      await api.put(`/insurance/${driverId}/${t}`, {
        covered: !current.covered, policy_no: current.policy_no,
        valid_from: current.valid_from, valid_to: current.valid_to,
      });
      reload();
    } catch (err) {
      toast.error(err);
    }
  }

  const setParam = (k, v) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v); else next.delete(k);
    setParams(next);
  };

  return (
    <Page
      title="Insurance"
      subtitle="GMC, GPA, GTL and WC coverage for deployed drivers"
      actions={<>
        <button onClick={() => api.download(
          `/insurance/export?type=${type}&covered=${covered}`,
          `insurance-${type || 'all'}.xlsx`,
        )}>⭳ Download list</button>
        {can('senior_manager', 'accounts') && (
          <button className="primary" onClick={() => setImportOpen(true)}>⭱ Upload excel</button>
        )}
      </>}
    >
      {data && (
        <div className="grid c4" style={{ marginBottom: 16 }}>
          {TYPES.map((t) => (
            <Stat key={t} tone={data.summary[t] === data.total ? 'good' : 'warn'}
              label={`${t} — ${LABEL[t]}`}
              value={`${data.summary[t]} / ${data.total}`}
              foot={data.total ? `${Math.round((data.summary[t] / data.total) * 100)}% covered` : '—'} />
          ))}
        </div>
      )}

      <div className="toolbar">
        <input placeholder="Search driver, registration no or client ID…" value={search}
          onChange={(e) => setSearch(e.target.value)} style={{ minWidth: 300 }} />
        <select value={type} onChange={(e) => setParam('type', e.target.value)}>
          <option value="">Filter by policy…</option>
          {TYPES.map((t) => <option key={t} value={t}>{t} — {LABEL[t]}</option>)}
        </select>
        {type && (
          <select value={covered} onChange={(e) => setParam('covered', e.target.value)}>
            <option value="">Covered or not</option>
            <option value="true">Covered only</option>
            <option value="false">Not covered only</option>
          </select>
        )}
      </div>

      <ErrorBanner error={error} onRetry={reload} />

      <Card tight>
        {!data ? (error ? null : <Loading what="coverage" />) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Driver</th><th>Client ID</th><th>Location</th>
                  {TYPES.map((t) => <th key={t} style={{ textAlign: 'center' }}>{t}</th>)}
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.rows.length === 0 && <Empty>No drivers match this filter.</Empty>}
                {data.rows.map((d) => (
                  <tr key={d.id}>
                    <td>
                      <Link to={`/drivers/${d.id}`}><b>{d.name}</b></Link>
                      <div className="muted small mono">{d.registration_no}</div>
                    </td>
                    <td className="mono">{d.client_id || '—'}</td>
                    <td>{d.location || '—'}</td>
                    {TYPES.map((t) => (
                      <td key={t} style={{ textAlign: 'center' }}>
                        <input type="checkbox" style={{ width: 'auto' }}
                          checked={d.policies[t].covered}
                          disabled={!editable}
                          title={d.policies[t].policy_no || (d.policies[t].covered ? 'Covered' : 'Not covered')}
                          onChange={() => toggle(d.id, t, d.policies[t])} />
                      </td>
                    ))}
                    <td className="right">
                      {editable && <button className="sm" onClick={() => setEditing(d)}>Policies</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {importOpen && <ImportModal onClose={() => setImportOpen(false)} onDone={() => { setImportOpen(false); reload(); }} />}
      {editing && <PolicyModal driver={editing} onClose={() => setEditing(null)}
        onDone={() => { setEditing(null); reload(); }} />}
    </Page>
  );
}

function PolicyModal({ driver, onClose, onDone }) {
  const toast = useToast();
  const [state, setState] = useState(() => Object.fromEntries(
    TYPES.map((t) => [t, { ...driver.policies[t] }]),
  ));
  const [busy, setBusy] = useState(false);

  const set = (t, k, v) => setState((s) => ({ ...s, [t]: { ...s[t], [k]: v } }));

  async function save() {
    setBusy(true);
    try {
      await Promise.all(TYPES.map((t) => api.put(`/insurance/${driver.id}/${t}`, state[t])));
      toast.success('Policies updated');
      onDone();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={`Insurance — ${driver.name}`} wide onClose={onClose}
      footer={<>
        <button onClick={onClose}>Cancel</button>
        <button className="primary" onClick={save} disabled={busy}>Save all</button>
      </>}>
      <table className="tbl">
        <thead><tr><th>Policy</th><th>Covered</th><th>Policy number</th><th>Valid from</th><th>Valid to</th></tr></thead>
        <tbody>
          {TYPES.map((t) => (
            <tr key={t}>
              <td><b>{t}</b><div className="muted small">{LABEL[t]}</div></td>
              <td>
                <input type="checkbox" style={{ width: 'auto' }} checked={!!state[t].covered}
                  onChange={(e) => set(t, 'covered', e.target.checked)} />
              </td>
              <td><input value={state[t].policy_no || ''} onChange={(e) => set(t, 'policy_no', e.target.value)} /></td>
              <td><input type="date" value={state[t].valid_from || ''} onChange={(e) => set(t, 'valid_from', e.target.value)} /></td>
              <td><input type="date" value={state[t].valid_to || ''} onChange={(e) => set(t, 'valid_to', e.target.value)} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  );
}

function ImportModal({ onClose, onDone }) {
  const toast = useToast();
  const [file, setFile] = useState(null);
  const [type, setType] = useState('');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(null);

  async function run(dryRun) {
    if (!file) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      if (type) fd.append('type', type);
      fd.append('dry_run', String(dryRun));
      const res = await api.upload('/insurance/import', fd);
      if (dryRun) {
        setPreview(res);
      } else {
        toast.success(`${res.updated} driver(s) updated${res.errors.length ? `, ${res.errors.length} row(s) skipped` : ''}`);
        onDone();
      }
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Upload insurance list" wide onClose={onClose}
      footer={<>
        <button onClick={onClose}>Cancel</button>
        <button onClick={() => run(true)} disabled={!file || busy}>Check file</button>
        <button className="primary" onClick={() => run(false)} disabled={!file || busy}>
          {busy ? <span className="spinner" /> : 'Apply update'}
        </button>
      </>}>
      <div className="banner info">
        <span>ℹ</span>
        <div>Download the list first, edit the Yes/No, policy number and validity columns, then upload
          it back. Drivers are matched on <b>Registration No</b> (or <b>Client ID</b>).</div>
      </div>

      <div className="grid c2">
        <Field label="Excel file"><input type="file" accept=".xlsx,.xls,.csv"
          onChange={(e) => { setFile(e.target.files[0]); setPreview(null); }} /></Field>
        <Field label="Single-policy sheet?" hint="leave blank for the full matrix">
          <select value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">Full matrix (GMC / GPA / GTL / WC columns)</option>
            {TYPES.map((t) => <option key={t} value={t}>{t} only — with a “Covered” column</option>)}
          </select>
        </Field>
      </div>

      {preview && (
        <>
          <div className={`banner ${preview.errors.length ? 'warn' : 'success'}`}>
            <span>{preview.errors.length ? '!' : '✓'}</span>
            <div>
              {preview.updated} row(s) would be updated
              {preview.errors.length ? `, ${preview.errors.length} could not be matched.` : '.'}
              <div className="small muted">Nothing has been saved yet.</div>
            </div>
          </div>
          {preview.changes.length > 0 && (
            <div className="tbl-wrap" style={{ maxHeight: 240 }}>
              <table className="tbl">
                <thead><tr><th>Driver</th><th>Policy</th><th>Covered</th><th>Policy no</th></tr></thead>
                <tbody>
                  {preview.changes.map((c, i) => (
                    <tr key={i}>
                      <td>{c.driver}</td><td>{c.type}</td>
                      <td>{c.covered ? <span className="chip green">Yes</span> : <span className="chip grey">No</span>}</td>
                      <td className="mono">{c.policy_no || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {preview.errors.length > 0 && (
            <div className="small muted" style={{ marginTop: 8 }}>
              Unmatched rows: {preview.errors.slice(0, 5).map((e) => `row ${e.row} (${e.error})`).join('; ')}
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
