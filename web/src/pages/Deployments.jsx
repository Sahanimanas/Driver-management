import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { Page } from '../App.jsx';
import { api, fileUrl } from '../lib/api.js';
import { useAsync, useAuth, useToast, Card, Field, Modal, Loading, ErrorBanner, Empty, Avatar } from '../lib/ui.jsx';
import { date } from '../lib/format.js';
import StatusChip from '../components/StatusChip.jsx';
import DeployModal from '../components/DeployModal.jsx';

const TABS = [
  ['pending', 'Registered, not deployed'],
  ['active', 'Currently deployed'],
  ['ended', 'Left'],
  ['blacklisted', 'Blacklisted'],
];

/**
 * Deployments opens on the drivers who are registered but not yet deployed,
 * each with a Deploy button. The other tabs are the live deployments, the
 * stints that have ended, and the blacklist.
 */
export default function Deployments() {
  const [tab, setTab] = useState('pending');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');

  return (
    <Page
      title="Deployments"
      subtitle="Deploy registered drivers, and keep track of who is placed, who has left and who is blacklisted"
    >
      <div className="tabs">
        {TABS.map(([k, l]) => (
          <button key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>

      {tab !== 'blacklisted' && (
        <form className="toolbar" onSubmit={(e) => { e.preventDefault(); setQuery(search); }}>
          <input value={search} onChange={(e) => setSearch(e.target.value)} style={{ minWidth: 300 }}
            placeholder={tab === 'pending' ? 'Search name, registration ID or phone…' : 'Search driver, client ID or vehicle…'} />
          <button className="primary">Search</button>
          {query && <button type="button" onClick={() => { setSearch(''); setQuery(''); }}>Clear</button>}
        </form>
      )}

      {tab === 'pending' && <NotDeployed query={query} />}
      {(tab === 'active' || tab === 'ended') && <Stints status={tab} query={query} />}
      {tab === 'blacklisted' && <Blacklisted />}
    </Page>
  );
}

// ------------------------------------------------------- not yet deployed
function NotDeployed({ query }) {
  const { can } = useAuth();
  const toast = useToast();
  const [deploying, setDeploying] = useState(null);
  const { data, error, reload } = useAsync(
    () => api.get(`/deployments/undeployed?search=${encodeURIComponent(query)}`), [query],
  );

  const ready = (data || []).filter((r) => r.ready).length;

  return (
    <>
      <ErrorBanner error={error} onRetry={reload} />
      {data && (
        <div className="banner info">
          <span>ℹ</span>
          <div>
            <b>{data.length}</b> registered driver(s) are not deployed — <b>{ready}</b> have cleared the
            trial test, safety orientation and medical and can be deployed as soon as the client issues
            an ID. Drivers who left are here too, ready to rejoin on a new ID.
          </div>
        </div>
      )}
      <Card tight>
        {!data ? (error ? null : <Loading what="drivers" />) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Driver</th><th>Registered on</th><th>Status</th><th>Screening</th>
                  <th>Bank details</th><th>Last left on</th><th className="right">Action</th>
                </tr>
              </thead>
              <tbody>
                {data.length === 0 && <Empty>Every registered driver is deployed.</Empty>}
                {data.map((d) => (
                  <tr key={d.id}>
                    <td>
                      <div className="row">
                        <Avatar src={fileUrl(d.photo_id)} name={d.name} />
                        <div className="stack">
                          <Link to={`/drivers/${d.id}`}><b>{d.name}</b></Link>
                          <span className="muted small mono">{d.registration_no}</span>
                        </div>
                      </div>
                    </td>
                    <td className="nowrap">{date(d.created_at)}</td>
                    <td><StatusChip value={d.status} /></td>
                    <td>
                      {d.screenings_failed > 0
                        ? <span className="chip red">failed</span>
                        : <span className={`chip ${d.ready ? 'green' : 'amber'}`}>
                          {d.screenings_passed} of {d.screenings_total} passed</span>}
                    </td>
                    <td>{d.bank_account_no && d.bank_ifsc
                      ? <span className="chip green">on record</span>
                      : <span className="chip amber">to add</span>}</td>
                    <td className="nowrap">
                      {d.last_left_on
                        ? <>{date(d.last_left_on)} <span className="muted small mono">ID {d.last_client_id}</span></>
                        : <span className="muted">—</span>}
                    </td>
                    <td className="right nowrap">
                      {can('deployments.manage') && (
                        d.ready
                          ? <button className="sm primary" onClick={() => setDeploying(d)}>
                            {d.last_client_id ? 'Rejoin' : 'Deploy'}</button>
                          : <Link className="btn sm" to={`/drivers/${d.id}`}
                            title="Deployment opens once the trial test, safety orientation and medical are passed">
                            Screening pending</Link>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {deploying && (
        <DeployModal
          driverId={deploying.id}
          onClose={() => setDeploying(null)}
          onDone={(msg) => { setDeploying(null); toast.success(msg); reload(); }}
        />
      )}
    </>
  );
}

// ------------------------------------------------------ live / ended stints
function Stints({ status, query }) {
  const { can } = useAuth();
  const toast = useToast();
  const [editing, setEditing] = useState(null);
  const { data, error, reload } = useAsync(
    () => api.get(`/deployments?status=${status}&search=${encodeURIComponent(query)}`),
    [status, query],
  );

  return (
    <>
      <ErrorBanner error={error} onRetry={reload} />
      <Card tight>
        {!data ? (error ? null : <Loading what="deployments" />) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Driver</th><th>Client ID</th><th>Date of joining</th><th>Vehicle</th>
                  <th>Location</th><th>Salary class</th><th>Supervisor</th>
                  {status === 'ended' && <><th>Date of leaving</th><th>Reason</th></>}
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.length === 0 && <Empty>No deployments found.</Empty>}
                {data.map((e) => (
                  <tr key={e.id}>
                    <td>
                      <div className="row">
                        <Avatar src={fileUrl(e.photo_id)} name={e.name} />
                        <div className="stack">
                          <Link to={`/drivers/${e.driver_id}`}><b>{e.name}</b></Link>
                          <span className="muted small mono">{e.registration_no}</span>
                        </div>
                        {e.blacklisted ? <span className="chip red">blacklisted</span> : null}
                      </div>
                    </td>
                    <td className="mono"><b>{e.client_id}</b></td>
                    <td className="nowrap">{date(e.date_of_joining)}</td>
                    <td className="mono">{e.vehicle_number || '—'}</td>
                    <td>{e.location || '—'}</td>
                    <td>{e.salary_class || <span className="muted">—</span>}</td>
                    <td className="small">{e.supervisor_name || <span className="chip amber">not assigned</span>}</td>
                    {status === 'ended' && <>
                      <td className="nowrap">{date(e.date_of_leaving)}</td>
                      <td className="small">{e.exit_reason || '—'}</td>
                    </>}
                    <td className="right">
                      {e.status === 'active' && can('deployments.edit') && (
                        <button className="sm" onClick={() => setEditing(e)}>Edit</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {editing && (
        <EditModal
          employment={editing}
          onClose={() => setEditing(null)}
          onDone={() => { setEditing(null); toast.success('Deployment updated'); reload(); }}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------- blacklist
function Blacklisted() {
  const { data, error, reload } = useAsync(() => api.get('/deployments/blacklisted'), []);
  return (
    <>
      <ErrorBanner error={error} onRetry={reload} />
      <div className="banner warn">
        <span>⛔</span>
        <div>
          Blacklisted drivers cannot be deployed again until Admin / Director lifts the blacklist.
          The date of leaving is the one recorded in the attendance sheet.
        </div>
      </div>
      <Card tight>
        {!data ? (error ? null : <Loading what="the blacklist" />) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Driver</th><th>Last client ID</th><th>Location</th><th>Date of joining</th>
                  <th>Date of leaving</th><th>Blacklisted on</th><th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {data.length === 0 && <Empty>No driver is blacklisted.</Empty>}
                {data.map((d) => (
                  <tr key={d.id}>
                    <td>
                      <div className="row">
                        <Avatar src={fileUrl(d.photo_id)} name={d.name} />
                        <div className="stack">
                          <Link to={`/drivers/${d.id}`}><b>{d.name}</b></Link>
                          <span className="muted small mono">{d.registration_no}</span>
                        </div>
                      </div>
                    </td>
                    <td className="mono">{d.last_client_id || '—'}</td>
                    <td>{d.last_location || '—'}</td>
                    <td className="nowrap">{d.last_joined_on ? date(d.last_joined_on) : '—'}</td>
                    <td className="nowrap"><b>{d.date_of_leaving ? date(d.date_of_leaving) : '—'}</b></td>
                    <td className="nowrap">{date(d.blacklisted_on)}
                      {d.blacklisted_by_name && <div className="muted small">by {d.blacklisted_by_name}</div>}
                    </td>
                    <td className="small">{d.blacklist_reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

/**
 * Editing a live deployment. The scope's second redeployment case — "driver's
 * deployed vehicle and location are changed" — is this screen: the client ID
 * stays, the vehicle and location move.
 */
function EditModal({ employment, onClose, onDone }) {
  const toast = useToast();
  const [form, setForm] = useState({
    vehicle_number: employment.vehicle_number || '',
    location: employment.location || '',
    salary_structure_id: employment.salary_structure_id || '',
    lsa_monthly: employment.lsa_monthly || 0,
    supervisor_id: employment.supervisor_id ? String(employment.supervisor_id) : '',
  });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const structures = useAsync(() => api.get('/salary-master?active=true'), []);
  const locations = useAsync(() => api.get('/locations'), []);
  const locationList = locations.data || [];
  const supervisors = useAsync(() => api.get('/deployments/supervisors'), []);
  // A deployment made before the list existed may sit on a site not on it.
  const offList = form.location && locationList.length
    && !locationList.some((l) => l.name === form.location);

  async function submit() {
    setBusy(true);
    try {
      const payload = { ...form };
      if (!payload.salary_structure_id) delete payload.salary_structure_id;
      if (!payload.supervisor_id) delete payload.supervisor_id;
      if (offList && form.location === employment.location) delete payload.location;
      await api.patch(`/deployments/${employment.id}`, payload);
      onDone();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={`${employment.name} — ID ${employment.client_id}`} onClose={onClose}
      footer={<>
        <button onClick={onClose}>Cancel</button>
        <button className="primary" onClick={submit} disabled={busy}>Save</button>
      </>}>
      <div className="grid c2">
        <Field label="Vehicle No">
          <input value={form.vehicle_number}
            onChange={(e) => setForm((f) => ({ ...f, vehicle_number: e.target.value.toUpperCase() }))} />
        </Field>
        <Field label="Location of deployment">
          {locationList.length ? (
            <select value={form.location} onChange={set('location')}>
              {offList && <option value={form.location}>{form.location} (not on the list)</option>}
              {!form.location && <option value="">— choose the location —</option>}
              {locationList.map((l) => <option key={l.id} value={l.name}>{l.name}</option>)}
            </select>
          ) : <input value={form.location} onChange={set('location')} />}
        </Field>
      </div>
      <Field label="Salary class" hint="from the salary master">
        <select value={form.salary_structure_id} onChange={set('salary_structure_id')}>
          {!form.salary_structure_id && <option value="">— choose the salary class —</option>}
          {(structures.data?.rows || []).map((r) => (
            <option key={r.id} value={r.id}>{r.name}</option>
          ))}
        </select>
      </Field>
      <div className="grid c2">
        <Field label="Supervisor" hint="moving the driver hands them to that supervisor">
          <select value={form.supervisor_id} onChange={set('supervisor_id')}>
            {!form.supervisor_id && <option value="">— choose the supervisor —</option>}
            {(supervisors.data || []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
        <Field label="LSA / month" hint="this driver's own amount, 0 if none">
          <input type="number" min={0} value={form.lsa_monthly} onChange={set('lsa_monthly')} />
        </Field>
      </div>
    </Modal>
  );
}
