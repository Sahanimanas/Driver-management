import React, { useEffect, useRef, useState } from 'react';
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
  const { user } = useAuth();
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

  if (user.role !== 'admin') {
    return (
      <Page title="Settings">
        <div className="banner error">
          <span>⚠</span>
          <div>Settings are limited to Admin / Director.</div>
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

      <Card title="Roles">
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
                <span className="muted small"> Nobody can approve a request they raised.</span>
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
