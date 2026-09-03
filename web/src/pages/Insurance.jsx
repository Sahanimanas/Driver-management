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

  const editable = can('supervisor', 'finance');

  /**
   * Ticking a box in the grid opens the policy details rather than saving on
   * the spot. Cover is only meaningful alongside a policy number and its
   * validity, and a stray click on a dense grid should not silently change a
   * driver's insurance record.
   */
  function askToToggle(driver, t) {
    setEditing({ driver, focus: t, intent: !driver.policies[t].covered });
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
        {/* Whoever may edit coverage on this page may also do it in bulk. */}
        {editable && (
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
                        <input type="checkbox" style={{ width: 'auto', cursor: editable ? 'pointer' : 'default' }}
                          checked={d.policies[t].covered}
                          disabled={!editable}
                          title={editable
                            ? `${d.policies[t].covered ? 'Covered' : 'Not covered'}${d.policies[t].policy_no ? ` · ${d.policies[t].policy_no}` : ''} — click to edit the policy`
                            : (d.policies[t].policy_no || (d.policies[t].covered ? 'Covered' : 'Not covered'))}
                          onChange={() => askToToggle(d, t)} />
                      </td>
                    ))}
                    <td className="right">
                      {editable && (
                        <button className="sm" onClick={() => setEditing({ driver: d })}>Policies</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {importOpen && <ImportModal onClose={() => setImportOpen(false)} onDone={() => { setImportOpen(false); reload(); }} />}
      {editing && (
        <PolicyModal
          driver={editing.driver}
          focus={editing.focus}
          intent={editing.intent}
          onClose={() => setEditing(null)}
          onDone={() => { setEditing(null); reload(); }}
        />
      )}
    </Page>
  );
}

/**
 * Policy details for one driver.
 *
 * `focus` is the policy whose box was clicked in the grid, and `intent` is the
 * covered state that click was asking for — the modal opens with it already
 * applied, so the tick is not lost, but nothing is saved until Save is pressed.
 */
function PolicyModal({ driver, focus, intent, onClose, onDone }) {
  const toast = useToast();
  const [state, setState] = useState(() => Object.fromEntries(
    TYPES.map((t) => [t, {
      ...driver.policies[t],
      ...(t === focus && intent !== undefined ? { covered: intent } : {}),
    }]),
  ));
  const [busy, setBusy] = useState(false);

  const set = (t, k, v) => setState((s) => ({ ...s, [t]: { ...s[t], [k]: v } }));

  // Turning cover on without a policy number is almost always an oversight.
  const missingPolicy = TYPES.filter((t) => state[t].covered && !String(state[t].policy_no || '').trim());
  const dirty = TYPES.some((t) => ['covered', 'policy_no', 'valid_from', 'valid_to'].some(
    (k) => Boolean(state[t][k] ?? '') !== Boolean(driver.policies[t][k] ?? '')
      || String(state[t][k] ?? '') !== String(driver.policies[t][k] ?? ''),
  ));

  async function save() {
    setBusy(true);
    try {
      await Promise.all(TYPES.map((t) => api.put(`/insurance/${driver.id}/${t}`, state[t])));
      toast.success(`Insurance updated for ${driver.name}`);
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
        {!dirty && <span className="muted small" style={{ marginRight: 'auto' }}>Nothing changed yet</span>}
        <button onClick={onClose}>Cancel</button>
        <button className="primary" onClick={save} disabled={busy || !dirty}>
          {busy ? <span className="spinner" /> : 'Save'}
        </button>
      </>}>
      {focus && (
        <div className="banner info">
          <span>ℹ</span>
          <div>
            <b>{focus}</b> has been {intent ? 'ticked' : 'unticked'} below. Add the policy number and
            validity, then <b>Save</b> — nothing is stored until you do.
          </div>
        </div>
      )}
      {missingPolicy.length > 0 && (
        <div className="banner warn">
          <span>!</span>
          <div>
            {missingPolicy.join(', ')} {missingPolicy.length === 1 ? 'is' : 'are'} marked covered with
            no policy number. You can still save, but the register will show cover that cannot be
            traced to a policy.
          </div>
        </div>
      )}
      <table className="tbl">
        <thead><tr><th>Policy</th><th>Covered</th><th>Policy number</th><th>Valid from</th><th>Valid to</th></tr></thead>
        <tbody>
          {TYPES.map((t) => (
            <tr key={t} style={t === focus ? { background: '#f2f7fd' } : undefined}>
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
        const n = res.changed ?? res.updated;
        toast.success(n
          ? `${n} policy record(s) updated${res.errors.length ? `, ${res.errors.length} row(s) skipped` : ''}`
          : 'Nothing changed — the sheet matches what is already on record.');
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
        <div>
          Download the list first, edit the Yes/No, policy number and the <b>Valid From</b> /
          {' '}<b>Valid To</b> columns, then upload it back. Drivers are matched on
          {' '}<b>Registration No</b> (or <b>Client ID</b>).
          <div style={{ marginTop: 4 }}>
            The sheet is taken as the truth: <b>emptying a cell clears that value</b>. A column you
            delete from the sheet altogether is left alone.
          </div>
        </div>
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
              {preview.changed
                ? <><b>{preview.changed} driver(s)</b> would change, out of {preview.updated} read</>
                : <>Nothing would change — the sheet matches what is already on record ({preview.updated} row(s) read)</>}
              {preview.errors.length ? `. ${preview.errors.length} row(s) could not be matched.` : '.'}
              <div className="small muted">Nothing has been saved yet.</div>
            </div>
          </div>
          {preview.changes.filter((c) => c.changed).length > 0 && (
            <div className="tbl-wrap" style={{ maxHeight: 260 }}>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Driver</th><th>Policy</th><th>Covered</th>
                    <th>Policy no</th><th>Valid from</th><th>Valid to</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.changes.filter((c) => c.changed).map((c, i) => (
                    <tr key={i}>
                      <td>{c.driver}</td>
                      <td><b>{c.type}</b></td>
                      <td>
                        {c.covered
                          ? <span className="chip green">Yes</span>
                          : <span className="chip grey">No</span>}
                        {c.was && c.was.covered !== c.covered && (
                          <div className="muted small">was {c.was.covered ? 'Yes' : 'No'}</div>
                        )}
                      </td>
                      <td className="mono">
                        {c.policy_no || <span className="muted">— cleared</span>}
                        {c.was && c.was.policy_no !== c.policy_no && (
                          <div className="muted small">was {c.was.policy_no || '—'}</div>
                        )}
                      </td>
                      <td className="mono small">{c.valid_from || <span className="muted">—</span>}</td>
                      <td className="mono small">{c.valid_to || <span className="muted">—</span>}</td>
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
