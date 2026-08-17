import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Page } from '../App.jsx';
import { api, fileUrl } from '../lib/api.js';
import { useAsync, useAuth, useToast, Card, Field, Modal, Loading, ErrorBanner, Empty, Avatar } from '../lib/ui.jsx';
import { date, inr0 } from '../lib/format.js';
import StatusChip from '../components/StatusChip.jsx';

export default function Deployments() {
  const { can } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [status, setStatus] = useState('active');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState(null);

  const { data, loading, error, reload } = useAsync(
    () => api.get(`/deployments?status=${status}&search=${encodeURIComponent(query)}`),
    [status, query],
  );

  const cleared = useAsync(() => api.get('/drivers?status=cleared&limit=200'), []);

  return (
    <Page
      title="Deployments"
      subtitle="Client ID, date of joining, vehicle and location for every placed driver"
    >
      {cleared.data?.rows?.length > 0 && can('supervisor', 'senior_manager') && (
        <div className="banner info">
          <span>✓</span>
          <div style={{ flex: 1 }}>
            <b>{cleared.data.rows.length} driver(s)</b> have cleared the trial test, safety orientation
            and medical, and are waiting for the client to issue an ID.
          </div>
          <Link className="btn sm" to={`/drivers?status=cleared`}>View</Link>
        </div>
      )}

      <form className="toolbar" onSubmit={(e) => { e.preventDefault(); setQuery(search); }}>
        <input placeholder="Search driver, client ID or vehicle…" value={search}
          onChange={(e) => setSearch(e.target.value)} style={{ minWidth: 300 }} />
        <button className="primary">Search</button>
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="active">Currently deployed</option>
          <option value="ended">Ended</option>
          <option value="">All</option>
        </select>
      </form>

      <ErrorBanner error={error} onRetry={reload} />

      <Card tight>
        {!data ? (error ? null : <Loading what="deployments" />) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Driver</th><th>Client ID</th><th>Date of joining</th><th>Vehicle</th>
                  <th>Location</th><th className="num">Monthly wage</th><th>Status</th>
                  <th>Left on</th><th />
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
                      </div>
                    </td>
                    <td className="mono"><b>{e.client_id}</b></td>
                    <td className="nowrap">{date(e.date_of_joining)}</td>
                    <td className="mono">{e.vehicle_number || '—'}</td>
                    <td>{e.location || '—'}</td>
                    <td className="num">{inr0(e.monthly_wage)}</td>
                    <td><StatusChip value={e.status} /></td>
                    <td className="nowrap">{e.date_of_leaving ? date(e.date_of_leaving) : '—'}</td>
                    <td className="right">
                      {e.status === 'active' && can('supervisor', 'senior_manager', 'accounts') && (
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
    </Page>
  );
}

function EditModal({ employment, onClose, onDone }) {
  const toast = useToast();
  const [form, setForm] = useState({
    vehicle_number: employment.vehicle_number || '',
    location: employment.location || '',
    monthly_wage: employment.monthly_wage || 0,
  });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit() {
    setBusy(true);
    try {
      await api.patch(`/deployments/${employment.id}`, form);
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
        <Field label="Vehicle number"><input value={form.vehicle_number} onChange={set('vehicle_number')} /></Field>
        <Field label="Location"><input value={form.location} onChange={set('location')} /></Field>
      </div>
      <Field label="Monthly wage"><input type="number" value={form.monthly_wage} onChange={set('monthly_wage')} /></Field>
    </Modal>
  );
}
