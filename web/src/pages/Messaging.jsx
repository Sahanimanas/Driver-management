import React, { useState } from 'react';
import { Page } from '../App.jsx';
import { api } from '../lib/api.js';
import {
  useAsync, useAuth, useToast, Card, Field, Modal, Loading, ErrorBanner, Empty, Stat,
} from '../lib/ui.jsx';
import { dateTime, titleCase } from '../lib/format.js';
import StatusChip from '../components/StatusChip.jsx';

const TEMPLATES = [
  ['Safety refresher',
    'Namaste {{name}}, safety refresher training is on Saturday 9 AM at {{location}}. Please report on time with your ID {{client_id}}. — Quantum'],
  ['Salary credited',
    'Namaste {{name}}, your salary for the month has been credited to your bank account. For any query contact your supervisor. — Quantum'],
  ['Document reminder',
    'Namaste {{name}}, please submit a copy of your renewed driving licence to your supervisor this week. — Quantum'],
  ['Attendance reminder',
    'Namaste {{name}}, kindly inform your supervisor in advance if you will be on leave. Vehicle {{vehicle}} at {{location}}. — Quantum'],
];

export default function Messaging() {
  const { can } = useAuth();
  const toast = useToast();
  const [composeOpen, setComposeOpen] = useState(false);
  const [viewing, setViewing] = useState(null);

  const status = useAsync(() => api.get('/messaging/status'), []);
  const { data, loading, error, reload } = useAsync(() => api.get('/messaging/campaigns'), []);

  return (
    <Page title="WhatsApp broadcast" subtitle="Mass communication to drivers"
      actions={can('supervisor', 'senior_manager', 'director') && (
        <button className="primary" onClick={() => setComposeOpen(true)}>+ New broadcast</button>
      )}>
      {status.data && (
        <div className={`banner ${status.data.simulated ? 'warn' : 'success'}`}>
          <span>{status.data.simulated ? '⚠' : '✓'}</span>
          <div>{status.data.note}</div>
        </div>
      )}

      <ErrorBanner error={error} onRetry={reload} />

      <Card title="Broadcasts" tight>
        {!data ? (error ? null : <Loading what="broadcasts" />) : (
          <table className="tbl">
            <thead>
              <tr><th>Title</th><th>Message</th><th className="num">Recipients</th><th className="num">Sent</th>
                <th className="num">Failed</th><th>Status</th><th>By</th><th>When</th><th /></tr>
            </thead>
            <tbody>
              {data.length === 0 && <Empty>No broadcasts sent yet.</Empty>}
              {data.map((c) => (
                <tr key={c.id}>
                  <td><b>{c.title}</b></td>
                  <td className="small muted">{c.body.slice(0, 70)}{c.body.length > 70 ? '…' : ''}</td>
                  <td className="num">{c.total}</td>
                  <td className="num">{c.sent_count}</td>
                  <td className="num">{c.failed_count || '—'}</td>
                  <td><StatusChip value={c.status} /></td>
                  <td className="small">{c.created_by_name}</td>
                  <td className="small muted nowrap">{dateTime(c.sent_at || c.created_at)}</td>
                  <td className="right"><button className="sm" onClick={() => setViewing(c)}>Details</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {composeOpen && <Compose onClose={() => setComposeOpen(false)}
        onDone={(r) => {
          setComposeOpen(false);
          toast.success(`Sent to ${r.sent} driver(s)${r.failed ? `, ${r.failed} failed` : ''}`);
          reload();
        }} />}
      {viewing && <Details campaign={viewing} onClose={() => setViewing(null)} />}
    </Page>
  );
}

function Compose({ onClose, onDone }) {
  const toast = useToast();
  const [form, setForm] = useState({ title: '', body: '' });
  const [audience, setAudience] = useState({ deployedOnly: true });
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);

  const locations = useAsync(() => api.get('/drivers/locations'), []);

  async function checkAudience() {
    try {
      setPreview(await api.post('/messaging/audience/preview', { audience }));
    } catch (err) {
      toast.error(err);
    }
  }

  async function send() {
    setBusy(true);
    try {
      onDone(await api.post('/messaging/campaigns', { ...form, audience }));
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }

  const setAud = (k, v) => {
    setAudience((a) => {
      const next = { ...a };
      if (v === '' || v === false) delete next[k]; else next[k] = v;
      return next;
    });
    setPreview(null);
  };

  return (
    <Modal title="New WhatsApp broadcast" wide onClose={onClose}
      footer={<>
        <button onClick={onClose}>Cancel</button>
        <button onClick={checkAudience}>Check audience</button>
        <button className="primary" onClick={send}
          disabled={busy || !form.title || !form.body || !preview?.reachable}>
          {busy ? <span className="spinner" /> : `Send${preview ? ` to ${preview.reachable}` : ''}`}
        </button>
      </>}>
      <div className="grid c2">
        <div>
          <Field label="Broadcast title" hint="internal reference">
            <input value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} />
          </Field>
          <Field label="Message"
            hint="placeholders: {{name}} {{client_id}} {{vehicle}} {{location}} {{registration_no}}">
            <textarea value={form.body} style={{ minHeight: 130 }}
              onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))} />
          </Field>
          <div className="row wrap" style={{ marginBottom: 12 }}>
            {TEMPLATES.map(([label, body]) => (
              <button key={label} className="sm" onClick={() => setForm((f) => ({ ...f, title: f.title || label, body }))}>
                {label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <h4 style={{ fontSize: 13, marginBottom: 10 }}>Audience</h4>
          <label className="check" style={{ marginBottom: 10 }}>
            <input type="checkbox" checked={!!audience.deployedOnly}
              onChange={(e) => setAud('deployedOnly', e.target.checked)} />
            Currently deployed drivers only
          </label>
          <Field label="Location">
            <select value={audience.location || ''} onChange={(e) => setAud('location', e.target.value)}>
              <option value="">All locations</option>
              {(locations.data || []).map((l) => <option key={l} value={l}>{l}</option>)}
            </select>
          </Field>
          <Field label="Missing a policy" hint="target drivers not covered under…">
            <select value={audience.insuranceMissing || ''} onChange={(e) => setAud('insuranceMissing', e.target.value)}>
              <option value="">Not filtered</option>
              {['GMC', 'GPA', 'GTL', 'WC'].map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </Field>

          {preview && (
            <div className={`banner ${preview.reachable ? 'success' : 'warn'}`}>
              <span>{preview.reachable ? '✓' : '!'}</span>
              <div>
                <b>{preview.reachable}</b> driver(s) will receive this message
                {preview.unreachable.length > 0 && (
                  <div className="small">
                    {preview.unreachable.length} skipped for an invalid mobile number:
                    {' '}{preview.unreachable.slice(0, 3).map((u) => u.name).join(', ')}
                    {preview.unreachable.length > 3 ? '…' : ''}
                  </div>
                )}
              </div>
            </div>
          )}

          {preview?.sample?.length > 0 && form.body && (
            <>
              <h4 style={{ fontSize: 13, margin: '14px 0 6px' }}>Preview for {preview.sample[0].name}</h4>
              <div className="banner info" style={{ display: 'block' }}>
                {form.body
                  .replace(/\{\{\s*name\s*\}\}/g, preview.sample[0].name || '')
                  .replace(/\{\{\s*client_id\s*\}\}/g, preview.sample[0].client_id || '')
                  .replace(/\{\{\s*vehicle\s*\}\}/g, preview.sample[0].vehicle_number || '')
                  .replace(/\{\{\s*location\s*\}\}/g, preview.sample[0].location || '')
                  .replace(/\{\{\s*registration_no\s*\}\}/g, preview.sample[0].registration_no || '')}
              </div>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

function Details({ campaign, onClose }) {
  const { data, loading } = useAsync(() => api.get(`/messaging/campaigns/${campaign.id}`), [campaign.id]);

  return (
    <Modal title={campaign.title} wide onClose={onClose} footer={<button onClick={onClose}>Close</button>}>
      <div className="banner info" style={{ display: 'block', whiteSpace: 'pre-wrap' }}>{campaign.body}</div>
      {loading ? <Loading /> : (
        <>
          <div className="grid c3" style={{ marginBottom: 14 }}>
            <Stat label="Recipients" value={data.campaign.total} />
            <Stat tone="good" label="Delivered" value={data.campaign.sent_count} />
            <Stat tone={data.campaign.failed_count ? 'bad' : undefined} label="Failed" value={data.campaign.failed_count} />
          </div>
          <div className="tbl-wrap" style={{ maxHeight: 320 }}>
            <table className="tbl">
              <thead><tr><th>Driver</th><th>Number</th><th>Status</th><th>Sent</th><th>Error</th></tr></thead>
              <tbody>
                {data.recipients.map((r) => (
                  <tr key={r.id}>
                    <td>{r.name || '—'}</td>
                    <td className="mono">{r.phone}</td>
                    <td><StatusChip value={r.status} /></td>
                    <td className="small muted">{r.sent_at ? dateTime(r.sent_at) : '—'}</td>
                    <td className="small">{r.error || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Modal>
  );
}
