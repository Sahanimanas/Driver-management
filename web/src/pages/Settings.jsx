import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Page } from '../App.jsx';
import { api } from '../lib/api.js';
import {
  useAsync, useAuth, useToast, brandingChanged, Card, Field, Loading, ErrorBanner,
} from '../lib/ui.jsx';
import { inr } from '../lib/format.js';

/**
 * Settings.
 *
 * The scope opens with "change the name of ... will share logo", so the trading
 * name, the tagline and the logo are editable here rather than being baked into
 * the build. The rest of the page is a read-only statement of the business
 * rules the server is enforcing, so they can be checked against the document.
 */
export default function Settings() {
  const { can } = useAuth();
  const toast = useToast();
  const fileRef = useRef(null);
  const { data, loading, error, reload } = useAsync(() => api.get('/settings'), []);

  const [form, setForm] = useState({ app_name: '', app_tagline: '', client_name: '' });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!data) return;
    setForm({
      app_name: data.branding.appName || '',
      app_tagline: data.branding.tagline || '',
      client_name: data.branding.clientName || '',
    });
  }, [data]);

  if (!can('settings.manage')) {
    return (
      <Page title="Settings">
        <div className="banner error">
          <span>⚠</span>
          <div>Your role does not include changing settings.</div>
        </div>
      </Page>
    );
  }

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function save() {
    setBusy(true);
    try {
      await api.put('/settings/branding', form);
      brandingChanged();
      toast.success('Branding updated');
      reload();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }

  async function uploadLogo(file) {
    if (!file) return;
    const fd = new FormData();
    fd.append('file', file);
    try {
      await api.upload('/settings/logo', fd);
      brandingChanged();
      toast.success('Logo uploaded');
      reload();
    } catch (err) {
      toast.error(err);
    }
  }

  async function removeLogo() {
    try {
      await api.del('/settings/logo');
      brandingChanged();
      toast.success('Logo removed');
      reload();
    } catch (err) {
      toast.error(err);
    }
  }

  if (loading && !data) return <Page title="Settings"><Loading what="settings" /></Page>;

  const rules = data?.rules;

  return (
    <Page title="Settings" subtitle="Branding, roles and the rules the system enforces">
      <ErrorBanner error={error} onRetry={reload} />

      <Card title="Branding">
        <div className="banner">
          <span>ℹ</span>
          <div>
            The scope opens with a rename and a logo still to be supplied by the client. Both are
            set here — nothing needs rebuilding when they arrive.
          </div>
        </div>

        <div className="grid c2" style={{ marginTop: 12 }}>
          <Field label="Application name" hint="shown in the sidebar and the browser tab">
            <input value={form.app_name} onChange={set('app_name')} maxLength={40} placeholder="Quantum" />
          </Field>
          <Field label="Tagline">
            <input value={form.app_tagline} onChange={set('app_tagline')} maxLength={80}
              placeholder="Driver Attendance & Management" />
          </Field>
          <Field label="Client name" hint="appears on registers and exports">
            <input value={form.client_name} onChange={set('client_name')} maxLength={80}
              placeholder="e.g. Hindustan Zinc Limited" />
          </Field>
        </div>

        <Field label="Logo" hint="PNG, JPG or WebP">
          <div className="row wrap">
            {data?.branding?.logoUrl
              ? <img src={data.branding.logoUrl} alt="Current logo"
                  style={{ maxHeight: 40, maxWidth: 160, objectFit: 'contain' }} />
              : <span className="muted small">No logo uploaded yet.</span>}
            <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }}
              onChange={(e) => { uploadLogo(e.target.files?.[0]); e.target.value = ''; }} />
            <button className="sm" onClick={() => fileRef.current?.click()}>
              {data?.branding?.logoId ? 'Replace' : 'Upload'}
            </button>
            {data?.branding?.logoId && <button className="sm" onClick={removeLogo}>Remove</button>}
          </div>
        </Field>

        <div className="row" style={{ marginTop: 12 }}>
          <button className="primary" onClick={save} disabled={busy}>
            {busy ? <span className="spinner" /> : 'Save branding'}
          </button>
        </div>
      </Card>

      <Locations />

      <Card title="Roles" actions={<Link className="btn sm" to="/users">Manage roles</Link>}>
        <table className="tbl">
          <tbody>
            {(data?.roles || []).map((r) => (
              <tr key={r.key}>
                <td style={{ width: 180 }}><b>{r.label}</b></td>
                <td className="muted">{r.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card title="Rules in force">
        <table className="tbl">
          <tbody>
            <tr>
              <td style={{ width: 320 }}>Expense settled directly by Finance at or above</td>
              <td><b>{inr(rules?.expenseDirectorThreshold)}</b>
                <span className="muted small"> — below this the supervisor pays from petty cash</span></td>
            </tr>
            <tr>
              <td>Advance run paid by internet banking up to</td>
              <td><b>{rules?.netbankingMaxRequests} requests</b>
                <span className="muted small"> — beyond that a bank upload sheet is generated</span></td>
            </tr>
            <tr>
              <td>Advances in a month may not exceed</td>
              <td><b>{rules?.advanceLimitPercent}%</b>
                <span className="muted small"> of the salary earned on the attendance so far</span></td>
            </tr>
            <tr>
              <td>Advance accumulation cut-offs</td>
              <td><b>{rules?.cutoffs?.NOON}</b> and <b>{rules?.cutoffs?.EVENING}</b></td>
            </tr>
            <tr>
              <td>Payable attendance codes</td>
              <td>
                <b>P, T, TA</b>
                <span className="muted small"> — L (leave) and LE (left) are not paid</span>
              </td>
            </tr>
            <tr>
              <td>Approval chain</td>
              <td>
                Supervisor raises → <b>Admin / Director</b> approves → <b>Finance</b> pays.
                <span className="muted small"> An approver may also approve a request they raised.</span>
              </td>
            </tr>
            <tr>
              <td>WhatsApp broadcasts</td>
              <td>
                {data?.whatsapp?.enabled
                  ? <span className="chip green">Live — Meta Cloud API</span>
                  : <span className="chip amber">Simulation mode — no credentials configured</span>}
              </td>
            </tr>
          </tbody>
        </table>
        <div className="muted small" style={{ marginTop: 10 }}>
          These come from the server configuration (<span className="mono">server/.env</span>) and are
          shown here so they can be checked against the scope document.
        </div>
      </Card>
    </Page>
  );
}

/**
 * The deployment locations. A deployment picks its location from this list,
 * so a site is spelt one way everywhere. A site that is no longer used is
 * retired rather than deleted, because old deployments still name it.
 */
function Locations() {
  const toast = useToast();
  const { data, error, reload } = useAsync(() => api.get('/locations?all=true'), []);
  const [name, setName] = useState('');
  const [editing, setEditing] = useState(null);

  async function run(fn, message) {
    try {
      await fn();
      toast.success(message);
      reload();
      return true;
    } catch (err) {
      toast.error(err);
      return false;
    }
  }

  return (
    <Card title="Locations of deployment">
      <ErrorBanner error={error} onRetry={reload} />
      <form className="row wrap" style={{ marginBottom: 12 }} onSubmit={(e) => {
        e.preventDefault();
        run(() => api.post('/locations', { name }), `${name.trim()} added`).then((done) => done && setName(''));
      }}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Udaipur — Zawar Mines"
          maxLength={60} style={{ flex: 1, minWidth: 240 }} />
        <button className="primary" disabled={name.trim().length < 2}>+ Add location</button>
      </form>
      {!data ? (error ? null : <Loading what="locations" />) : (
        <table className="tbl">
          <thead><tr><th>Location</th><th className="num">Deployed now</th><th>Status</th><th /></tr></thead>
          <tbody>
            {data.length === 0 && (
              <tr><td colSpan={4} className="empty">
                No locations yet — until one is added, the deployment screen takes any location typed in.
              </td></tr>
            )}
            {data.map((l) => (
              <tr key={l.id}>
                <td>
                  {editing?.id === l.id ? (
                    <input value={editing.name} autoFocus maxLength={60}
                      onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
                  ) : <b>{l.name}</b>}
                </td>
                <td className="num">{l.deployed}</td>
                <td>{l.active ? <span className="chip green">in use</span> : <span className="chip grey">retired</span>}</td>
                <td className="right nowrap">
                  {editing?.id === l.id ? (
                    <>
                      <button className="sm primary" onClick={() => run(
                        () => api.patch(`/locations/${l.id}`, { name: editing.name }), 'Location renamed',
                      ).then((done) => done && setEditing(null))}>Save</button>{' '}
                      <button className="sm" onClick={() => setEditing(null)}>Cancel</button>
                    </>
                  ) : (
                    <>
                      <button className="sm" onClick={() => setEditing({ id: l.id, name: l.name })}>Rename</button>{' '}
                      <button className="sm" onClick={() => run(
                        () => api.patch(`/locations/${l.id}`, { active: !l.active }),
                        l.active ? `${l.name} retired` : `${l.name} back in use`,
                      )}>{l.active ? 'Retire' : 'Restore'}</button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="muted small" style={{ marginTop: 10 }}>
        Renaming a location renames it on the drivers deployed there too.
      </div>
    </Card>
  );
}
