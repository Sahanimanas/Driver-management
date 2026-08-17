import React, { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Page } from '../App.jsx';
import { api, fileUrl } from '../lib/api.js';
import {
  useAsync, useAuth, useToast, Card, Field, Modal, Loading, ErrorBanner, Empty, Avatar,
} from '../lib/ui.jsx';
import { date, dateTime, inr, inr0, titleCase, today } from '../lib/format.js';
import StatusChip from '../components/StatusChip.jsx';

const SCREENINGS = [
  ['trial', 'Trial test'],
  ['safety', 'Safety orientation'],
  ['medical', 'Medical'],
];

export default function DriverProfile() {
  const { id } = useParams();
  const { can } = useAuth();
  const toast = useToast();
  const [tab, setTab] = useState('overview');
  const [deployOpen, setDeployOpen] = useState(false);
  const { data, loading, error, reload } = useAsync(() => api.get(`/drivers/${id}`), [id]);

  if (loading) return <Page title="Driver"><Loading what="driver" /></Page>;
  if (error) return <Page title="Driver"><ErrorBanner error={error} onRetry={reload} /></Page>;

  const { driver, references, screenings, employments, activeEmployment, insurance, longevity,
    advances, expenses, attachments } = data;
  const passed = SCREENINGS.every(([t]) => screenings.find((s) => s.type === t)?.status === 'passed');

  return (
    <Page
      title={driver.name}
      subtitle={<span className="mono">{driver.registration_no}</span>}
      actions={<>
        {can('supervisor', 'senior_manager') && !activeEmployment && passed && (
          <button className="primary" onClick={() => setDeployOpen(true)}>
            {employments.length ? '+ Rejoin with new ID' : '+ Deploy'}
          </button>
        )}
        <Link className="btn" to="/drivers">Back to list</Link>
      </>}
    >
      <div className="grid c4" style={{ marginBottom: 16 }}>
        <div className="stat">
          <div className="row">
            <Avatar src={fileUrl(driver.photo_id)} name={driver.name} large />
            <div className="stack">
              <StatusChip value={driver.status} />
              <span className="muted small">{driver.phone}</span>
            </div>
          </div>
        </div>
        <div className="stat accent">
          <div className="label">Current client ID</div>
          <div className="value mono">{activeEmployment?.client_id || '—'}</div>
          <div className="foot">{activeEmployment
            ? `Billing from ${date(activeEmployment.date_of_joining)}`
            : 'Not currently deployed'}</div>
        </div>
        <div className="stat good">
          <div className="label">Total service</div>
          <div className="value">{longevity.label}</div>
          <div className="foot">{longevity.stints} stint{longevity.stints === 1 ? '' : 's'}, all IDs linked</div>
        </div>
        <div className="stat warn">
          <div className="label">Advance outstanding</div>
          <div className="value">{inr0(advances
            .filter((a) => a.status === 'paid')
            .reduce((s, a) => s + (a.amount - a.recovered), 0))}</div>
          <div className="foot">recovered through salary</div>
        </div>
      </div>

      <div className="tabs">
        {[['overview', 'Overview'], ['screening', 'Screening'], ['ids', 'ID history'],
          ['documents', 'Documents'], ['insurance', 'Insurance'], ['finance', 'Finance']].map(([k, l]) => (
          <button key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>

      {tab === 'overview' && <Overview driver={driver} references={references} employment={activeEmployment} onSaved={reload} />}
      {tab === 'screening' && <Screening driverId={driver.id} screenings={screenings} onSaved={reload} />}
      {tab === 'ids' && <IdHistory employments={employments} longevity={longevity} onChanged={reload} />}
      {tab === 'documents' && <Documents driver={driver} attachments={attachments} onSaved={reload} />}
      {tab === 'insurance' && <InsuranceTab driverId={driver.id} insurance={insurance} onSaved={reload} />}
      {tab === 'finance' && <Finance advances={advances} expenses={expenses} />}

      {deployOpen && (
        <DeployModal
          driver={driver}
          rejoin={employments.length > 0}
          onClose={() => setDeployOpen(false)}
          onDone={(msg) => { setDeployOpen(false); toast.success(msg); reload(); }}
        />
      )}
    </Page>
  );
}

// ------------------------------------------------------------------ tabs
function Overview({ driver, references, employment, onSaved }) {
  const { can } = useAuth();
  const toast = useToast();
  const [edit, setEdit] = useState(false);
  const [form, setForm] = useState(driver);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function save() {
    try {
      await api.patch(`/drivers/${driver.id}`, form);
      toast.success('Driver details updated');
      setEdit(false);
      onSaved();
    } catch (err) {
      toast.error(err);
    }
  }

  return (
    <div className="grid c2">
      <Card
        title="Personal & licence"
        actions={can('supervisor', 'senior_manager', 'accounts') && (
          edit
            ? <><button className="primary sm" onClick={save}>Save</button>
              <button className="sm" onClick={() => { setForm(driver); setEdit(false); }}>Cancel</button></>
            : <button className="sm" onClick={() => setEdit(true)}>Edit</button>
        )}
      >
        {edit ? (
          <>
            <div className="grid c2">
              <Field label="Name"><input value={form.name || ''} onChange={set('name')} /></Field>
              <Field label="Phone"><input value={form.phone || ''} onChange={set('phone')} /></Field>
              <Field label="Date of birth (Aadhar)"><input type="date" value={form.dob_aadhar || ''} onChange={set('dob_aadhar')} /></Field>
              <Field label="Date of birth (licence)"><input type="date" value={form.dl_dob || ''} onChange={set('dl_dob')} /></Field>
              <Field label="Licence number"><input value={form.dl_no || ''} onChange={set('dl_no')} /></Field>
              <Field label="Licence valid till"><input type="date" value={form.dl_valid_till || ''} onChange={set('dl_valid_till')} /></Field>
              <Field label="UAN"><input value={form.uan_no || ''} onChange={set('uan_no')} /></Field>
            </div>
            <Field label="Address"><textarea value={form.address || ''} onChange={set('address')} /></Field>
          </>
        ) : (
          <dl className="kv">
            <dt>Phone</dt><dd>{driver.phone}</dd>
            <dt>Aadhar</dt><dd className="mono">{driver.aadhar_no}</dd>
            <dt>Date of birth</dt><dd>{date(driver.dob_aadhar)}
              {driver.dl_dob && driver.dl_dob !== driver.dob_aadhar &&
                <span className="chip red" style={{ marginLeft: 6 }}>licence shows {date(driver.dl_dob)}</span>}
            </dd>
            <dt>Address</dt><dd>{driver.address || '—'}</dd>
            <dt>Licence no</dt><dd className="mono">{driver.dl_no || '—'}</dd>
            <dt>Licence validity</dt>
            <dd>{driver.dl_valid_till
              ? <span className={`chip ${driver.dl_valid_till < today() ? 'red' : 'green'}`}>{date(driver.dl_valid_till)}</span>
              : '—'}</dd>
            <dt>UAN</dt><dd className="mono">{driver.uan_no || '—'}</dd>
            <dt>Registered on</dt><dd>{date(driver.created_at)}</dd>
            {driver.remarks && <><dt>Remarks</dt><dd>{driver.remarks}</dd></>}
          </dl>
        )}
      </Card>

      <div>
        <Card title="Bank account">
          <dl className="kv">
            <dt>Account holder</dt><dd>{driver.bank_account_name || '—'}</dd>
            <dt>Account number</dt><dd className="mono">{driver.bank_account_no || <span className="chip red">missing</span>}</dd>
            <dt>IFSC</dt><dd className="mono">{driver.bank_ifsc || <span className="chip red">missing</span>}</dd>
            <dt>Bank</dt><dd>{driver.bank_name || '—'}</dd>
          </dl>
        </Card>

        <Card title="Reference contacts">
          <table className="tbl">
            <tbody>
              {references.length === 0 && <Empty>No reference contacts recorded.</Empty>}
              {references.map((r) => (
                <tr key={r.id}>
                  <td><b>{r.name}</b></td>
                  <td className="muted">{r.relation}</td>
                  <td className="mono right">{r.phone}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>

        {employment && (
          <Card title="Current deployment">
            <dl className="kv">
              <dt>Client ID</dt><dd className="mono"><b>{employment.client_id}</b></dd>
              <dt>Date of joining</dt><dd>{date(employment.date_of_joining)} <span className="muted small">billing starts</span></dd>
              <dt>Vehicle</dt><dd className="mono">{employment.vehicle_number || '—'}</dd>
              <dt>Location</dt><dd>{employment.location || '—'}</dd>
              <dt>Monthly wage</dt><dd>{inr(employment.monthly_wage)}</dd>
            </dl>
          </Card>
        )}
      </div>
    </div>
  );
}

function Screening({ driverId, screenings, onSaved }) {
  const { can } = useAuth();
  const toast = useToast();
  const [busy, setBusy] = useState('');

  async function record(type, status) {
    setBusy(type);
    try {
      const res = await api.post(`/drivers/${driverId}/screenings`, { type, status, conducted_on: today() });
      toast.success(res.readyForDeployment
        ? 'All three cleared — the driver can now be issued a client ID.'
        : `${titleCase(type)} marked ${status}.`);
      onSaved();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy('');
    }
  }

  return (
    <Card title="Screening pipeline">
      <p className="small muted" style={{ marginTop: 0 }}>
        A registered driver undergoes the trial test, then safety orientation, then medical.
        Only when all three are passed does the client issue a six digit ID with a date of joining.
      </p>
      <table className="tbl">
        <thead>
          <tr><th>Stage</th><th>Status</th><th>Conducted on</th><th>Remarks</th>
            {can('supervisor', 'senior_manager') && <th className="right">Record</th>}</tr>
        </thead>
        <tbody>
          {SCREENINGS.map(([type, label]) => {
            const s = screenings.find((x) => x.type === type) || { status: 'pending' };
            return (
              <tr key={type}>
                <td><b>{label}</b></td>
                <td><StatusChip value={s.status === 'pending' ? 'pending' : s.status === 'passed' ? 'passed' : 'failed'} /></td>
                <td>{date(s.conducted_on)}</td>
                <td className="muted">{s.remarks || '—'}</td>
                {can('supervisor', 'senior_manager') && (
                  <td className="right nowrap">
                    <button className="sm good" disabled={busy === type} onClick={() => record(type, 'passed')}>Pass</button>{' '}
                    <button className="sm danger" disabled={busy === type} onClick={() => record(type, 'failed')}>Fail</button>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}

function IdHistory({ employments, longevity, onChanged }) {
  const { can } = useAuth();
  const toast = useToast();
  const [ending, setEnding] = useState(null);

  return (
    <>
      <div className="banner info">
        <span>🔗</span>
        <div>
          Every client ID this driver has held is listed below. When a driver leaves and rejoins the
          client issues a fresh ID — it is linked here to the same person, so total service
          (<b>{longevity.label}</b> over {longevity.stints} stint{longevity.stints === 1 ? '' : 's'})
          stays intact and the driver is never registered twice.
        </div>
      </div>

      <Card tight>
        <table className="tbl">
          <thead>
            <tr><th>Client ID</th><th>Joined</th><th>Left</th><th>Vehicle</th><th>Location</th>
              <th className="num">Monthly wage</th><th>Status</th><th>Reason</th><th /></tr>
          </thead>
          <tbody>
            {employments.length === 0 && <Empty>This driver has not been deployed yet.</Empty>}
            {employments.map((e) => (
              <tr key={e.id}>
                <td className="mono"><b>{e.client_id}</b></td>
                <td>{date(e.date_of_joining)}</td>
                <td>{e.date_of_leaving ? date(e.date_of_leaving) : <span className="muted">—</span>}</td>
                <td className="mono">{e.vehicle_number || '—'}</td>
                <td>{e.location || '—'}</td>
                <td className="num">{inr0(e.monthly_wage)}</td>
                <td><StatusChip value={e.status} /></td>
                <td className="muted small">{e.exit_reason || '—'}</td>
                <td className="right">
                  {e.status === 'active' && can('supervisor', 'senior_manager') && (
                    <button className="sm" onClick={() => setEnding(e)}>End deployment</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      {ending && (
        <EndModal
          employment={ending}
          onClose={() => setEnding(null)}
          onDone={(service) => {
            setEnding(null);
            toast.success(`Deployment closed. Total service on record: ${service.label}.`);
            onChanged();
          }}
        />
      )}
    </>
  );
}

function EndModal({ employment, onClose, onDone }) {
  const toast = useToast();
  const [form, setForm] = useState({ date_of_leaving: today(), exit_reason: '' });
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      const res = await api.post(`/deployments/${employment.id}/end`, form);
      onDone(res.totalService);
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={`End deployment — ID ${employment.client_id}`} onClose={onClose}
      footer={<>
        <button onClick={onClose}>Cancel</button>
        <button className="danger" onClick={submit} disabled={busy}>End deployment</button>
      </>}>
      <Field label="Last working day">
        <input type="date" value={form.date_of_leaving}
          onChange={(e) => setForm((f) => ({ ...f, date_of_leaving: e.target.value }))} />
      </Field>
      <Field label="Reason">
        <input value={form.exit_reason} placeholder="Resigned, absconded, removed…"
          onChange={(e) => setForm((f) => ({ ...f, exit_reason: e.target.value }))} />
      </Field>
      <div className="banner info">
        <span>ℹ</span>
        <div>The last working day is marked <b>LE</b> in the attendance register and billing stops.
          If the driver returns later, deploy them again with the new client ID — their service history
          stays linked to this record.</div>
      </div>
    </Modal>
  );
}

function DeployModal({ driver, rejoin, onClose, onDone }) {
  const toast = useToast();
  const [form, setForm] = useState({
    client_id: '', date_of_joining: today(), vehicle_number: '', location: '', monthly_wage: 20000,
  });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit() {
    setBusy(true);
    try {
      const res = await api.post('/deployments', { driver_id: driver.id, ...form });
      onDone(res.message);
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={rejoin ? `Rejoin — new client ID for ${driver.name}` : `Deploy ${driver.name}`}
      onClose={onClose}
      footer={<>
        <button onClick={onClose}>Cancel</button>
        <button className="primary" onClick={submit} disabled={busy || !/^\d{6}$/.test(form.client_id)}>
          {busy ? <span className="spinner" /> : 'Deploy'}
        </button>
      </>}
    >
      {rejoin && (
        <div className="banner info">
          <span>🔗</span>
          <div>This new ID will be linked to the existing record for {driver.name}, so their earlier
            service continues to count towards longevity.</div>
        </div>
      )}
      <div className="grid c2">
        <Field label="Client ID" hint="six digits, issued by the client">
          <input value={form.client_id} onChange={set('client_id')} placeholder="400123" maxLength={6} />
        </Field>
        <Field label="Date of joining" hint="billing starts from this date">
          <input type="date" value={form.date_of_joining} onChange={set('date_of_joining')} />
        </Field>
        <Field label="Vehicle number">
          <input value={form.vehicle_number} onChange={set('vehicle_number')} placeholder="DL01AB1234" />
        </Field>
        <Field label="Location">
          <input value={form.location} onChange={set('location')} placeholder="Site where the driver is placed" />
        </Field>
      </div>
      <Field label="Monthly wage" hint="used for the wage register">
        <input type="number" value={form.monthly_wage} onChange={set('monthly_wage')} />
      </Field>
    </Modal>
  );
}

function Documents({ driver, attachments, onSaved }) {
  const { can } = useAuth();
  const toast = useToast();
  const [busy, setBusy] = useState('');

  async function upload(kind, file) {
    if (!file) return;
    setBusy(kind);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('kind', kind);
      await api.upload(`/drivers/${driver.id}/documents`, fd);
      toast.success('Document uploaded');
      onSaved();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy('');
    }
  }

  const slots = [
    ['photo', 'Photograph', driver.photo_id],
    ['aadhar', 'Aadhar copy', driver.aadhar_doc_id],
    ['dl', 'Driving licence copy', driver.dl_doc_id],
  ];

  return (
    <>
      <div className="grid c3">
        {slots.map(([kind, label, attId]) => (
          <Card key={kind} title={label}>
            {attId ? (
              <div className="doc-thumb">
                <a href={fileUrl(attId)} target="_blank" rel="noreferrer">
                  <img src={fileUrl(attId)} alt={label}
                    onError={(e) => { e.target.style.display = 'none'; }} />
                </a>
                <div className="cap">
                  <span className="chip green">on record</span>
                  <div className="spacer" style={{ flex: 1 }} />
                  <a className="small" href={fileUrl(attId, { download: true })}>Download</a>
                </div>
              </div>
            ) : (
              <div className="banner warn" style={{ marginBottom: 10 }}>
                <span>!</span><div>Not uploaded yet.</div>
              </div>
            )}
            {can('supervisor', 'senior_manager', 'accounts') && (
              <label className="field" style={{ marginTop: 10, marginBottom: 0 }}>
                <span>{attId ? 'Replace' : 'Upload'} {busy === kind && <span className="spinner" />}</span>
                <input type="file" accept="image/*,application/pdf"
                  onChange={(e) => upload(kind, e.target.files[0])} />
              </label>
            )}
          </Card>
        ))}
      </div>

      <Card title="All files on this driver" tight>
        <table className="tbl">
          <thead><tr><th>Kind</th><th>File</th><th>Uploaded</th><th className="right">Open</th></tr></thead>
          <tbody>
            {attachments.length === 0 && <Empty>No documents uploaded.</Empty>}
            {attachments.map((a) => (
              <tr key={a.id}>
                <td><span className="chip grey">{a.kind}</span></td>
                <td>{a.filename}</td>
                <td className="muted">{dateTime(a.uploaded_at)}</td>
                <td className="right">
                  <a className="btn sm" href={fileUrl(a.id)} target="_blank" rel="noreferrer">View</a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}

function InsuranceTab({ driverId, insurance, onSaved }) {
  const { can } = useAuth();
  const toast = useToast();
  const TYPES = [['GMC', 'Group Medical Cover'], ['GPA', 'Group Personal Accident'],
    ['GTL', 'Group Term Life'], ['WC', 'Workmen Compensation']];

  async function toggle(type, current) {
    try {
      await api.put(`/insurance/${driverId}/${type}`, {
        covered: !current.covered,
        policy_no: current.policy_no,
        valid_from: current.valid_from,
        valid_to: current.valid_to,
      });
      toast.success(`${type} coverage ${!current.covered ? 'added' : 'removed'}`);
      onSaved();
    } catch (err) {
      toast.error(err);
    }
  }

  return (
    <Card title="Insurance coverage" tight>
      <table className="tbl">
        <thead><tr><th>Policy</th><th>Covered</th><th>Policy number</th><th>Valid to</th></tr></thead>
        <tbody>
          {TYPES.map(([type, label]) => {
            const row = insurance.find((i) => i.type === type) || { covered: 0 };
            return (
              <tr key={type}>
                <td><b>{type}</b> <span className="muted small">{label}</span></td>
                <td>
                  {can('supervisor', 'senior_manager', 'accounts') ? (
                    <label className="check">
                      <input type="checkbox" checked={!!row.covered} onChange={() => toggle(type, row)} />
                      {row.covered ? 'Covered' : 'Not covered'}
                    </label>
                  ) : <StatusChip value={row.covered ? 'passed' : 'failed'} label={row.covered ? 'Covered' : 'Not covered'} />}
                </td>
                <td className="mono">{row.policy_no || '—'}</td>
                <td>{date(row.valid_to)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}

function Finance({ advances, expenses }) {
  return (
    <div className="grid c2">
      <Card title="Advance requests" tight>
        <table className="tbl">
          <thead><tr><th>Date</th><th className="num">Amount</th><th>Reason</th><th>Status</th><th className="num">Outstanding</th></tr></thead>
          <tbody>
            {advances.length === 0 && <Empty>No advance requests.</Empty>}
            {advances.map((a) => (
              <tr key={a.id}>
                <td className="nowrap">{date(a.request_date)}</td>
                <td className="num">{inr(a.amount)}</td>
                <td>{a.reason}</td>
                <td><StatusChip value={a.status} /></td>
                <td className="num">{a.status === 'paid' ? inr(a.amount - a.recovered) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card title="Expenses against this driver" tight>
        <table className="tbl">
          <thead><tr><th>Date</th><th>Purpose</th><th className="num">Amount</th><th>Status</th></tr></thead>
          <tbody>
            {expenses.length === 0 && <Empty>No expenses recorded.</Empty>}
            {expenses.map((x) => (
              <tr key={x.id}>
                <td className="nowrap">{date(x.request_date)}</td>
                <td>{x.purpose}</td>
                <td className="num">{inr(x.amount)}</td>
                <td><StatusChip value={x.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
