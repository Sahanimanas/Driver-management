import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Page } from '../App.jsx';
import { api, fileUrl } from '../lib/api.js';
import { useAsync, useAuth, Card, Loading, ErrorBanner, Empty, Avatar } from '../lib/ui.jsx';
import { date, inr0 } from '../lib/format.js';
import StatusChip from '../components/StatusChip.jsx';

const STATUSES = ['registered', 'in_screening', 'cleared', 'deployed', 'left', 'rejected'];

export default function Drivers() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [location, setLocation] = useState('');

  const locations = useAsync(() => api.get('/drivers/locations'), []);
  const { data, loading, error, reload } = useAsync(
    () => api.get(`/drivers?search=${encodeURIComponent(query)}&status=${status}&location=${encodeURIComponent(location)}&limit=200`),
    [query, status, location],
  );

  return (
    <Page
      title="Drivers"
      subtitle={data ? `${data.total} registered` : 'Registration and master records'}
      actions={can('supervisor') && (
        <Link className="btn primary" to="/drivers/new">+ Register driver</Link>
      )}
    >
      <form
        className="toolbar"
        onSubmit={(e) => { e.preventDefault(); setQuery(search); }}
      >
        <input
          placeholder="Search name, registration no, client ID, phone or Aadhar…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ minWidth: 340 }}
        />
        <button className="primary">Search</button>
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          {STATUSES.map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
        </select>
        <select value={location} onChange={(e) => setLocation(e.target.value)}>
          <option value="">All locations</option>
          {(locations.data || []).map((l) => <option key={l} value={l}>{l}</option>)}
        </select>
        {(query || status || location) && (
          <button type="button" onClick={() => { setSearch(''); setQuery(''); setStatus(''); setLocation(''); }}>
            Clear
          </button>
        )}
      </form>

      <ErrorBanner error={error} onRetry={reload} />

      <Card tight>
        {!data ? (error ? null : <Loading what="drivers" />) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Driver</th>
                  <th>Registration No</th>
                  <th>Client ID</th>
                  <th>Status</th>
                  <th>Vehicle</th>
                  <th>Location</th>
                  <th>Date of joining</th>
                  <th className="num">Monthly wage</th>
                  <th>DL validity</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.length === 0 && <Empty>No drivers match this filter.</Empty>}
                {data.rows.map((d) => (
                  <tr key={d.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/drivers/${d.id}`)}>
                    <td>
                      <div className="row">
                        <Avatar src={fileUrl(d.photo_id)} name={d.name} />
                        <div className="stack">
                          <b>{d.name}</b>
                          <span className="muted small">{d.phone}</span>
                        </div>
                      </div>
                    </td>
                    <td className="mono">{d.registration_no}</td>
                    <td className="mono">{d.client_id || <span className="muted">—</span>}</td>
                    <td><StatusChip value={d.status} /></td>
                    <td className="mono">{d.vehicle_number || '—'}</td>
                    <td>{d.location || '—'}</td>
                    <td className="nowrap">{d.date_of_joining ? date(d.date_of_joining) : '—'}</td>
                    <td className="num">{d.monthly_wage ? inr0(d.monthly_wage) : '—'}</td>
                    <td className="nowrap">
                      {d.dl_valid_till
                        ? <span className={`chip ${d.dl_valid_till < new Date().toISOString().slice(0, 10) ? 'red' : 'grey'}`}>
                          {date(d.dl_valid_till)}</span>
                        : <span className="muted">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </Page>
  );
}
