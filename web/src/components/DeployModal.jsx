import React, { useState } from 'react';
import { api, fileUrl } from '../lib/api.js';
import { useAsync, useToast, Field, Modal, Loading, ErrorBanner, Avatar } from '../lib/ui.jsx';
import { date, today } from '../lib/format.js';
import StatusChip from './StatusChip.jsx';

const SCREENINGS = [['trial', 'Trial test'], ['safety', 'Safety orientation'], ['medical', 'Medical']];

/**
 * The deployment screen. It opens on the registered driver's details, and asks
 * for what the client's ID letter adds:
 *
 *   Client ID*  ·  Vehicle No  ·  Location (from the list)  ·  Date of joining*
 *   Salary class* -- the structure off the salary master, by name only; the
 *   amounts belong to the salary master, not to this screen.
 *
 * The bank account and UAN are asked for here only if registration left them
 * out, since the scope allows them to be completed at this step.
 */
export default function DeployModal({ driverId, onClose, onDone }) {
  const toast = useToast();
  const profile = useAsync(() => api.get(`/drivers/${driverId}`), [driverId]);
  const structures = useAsync(() => api.get('/salary-master?active=true'), []);
  const locations = useAsync(() => api.get('/locations'), []);

  const [form, setForm] = useState({
    client_id: '', vehicle_number: '', location: '', date_of_joining: today(), salary_structure_id: '',
    bank_account_name: '', bank_account_no: '', bank_ifsc: '', uan_no: '',
  });
  const [allowMissingBank, setAllowMissingBank] = useState(false);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const data = profile.data;
  const driver = data?.driver;
  const screenings = data?.screenings || [];
  const pending = SCREENINGS.filter(([t]) => screenings.find((s) => s.type === t)?.status !== 'passed');
  const rejoin = (data?.employments || []).length > 0;

  const needsBank = driver && (!driver.bank_account_no || !driver.bank_ifsc);
  const needsUan = driver && !driver.uan_no;
  const bankEntered = form.bank_account_no.trim() && form.bank_ifsc.trim();
  const locationList = locations.data || [];

  const ready = driver
    && !pending.length
    && /^\d{6}$/.test(form.client_id)
    && form.date_of_joining
    && form.salary_structure_id
    && (locationList.length === 0 || form.location)
    && (!needsBank || bankEntered || allowMissingBank);

  async function submit() {
    setBusy(true);
    try {
      const payload = { driver_id: driverId };
      ['client_id', 'vehicle_number', 'location', 'date_of_joining', 'salary_structure_id'].forEach((k) => {
        if (form[k]) payload[k] = form[k];
      });
      if (needsBank) {
        ['bank_account_name', 'bank_account_no', 'bank_ifsc'].forEach((k) => {
          if (form[k].trim()) payload[k] = form[k].trim();
        });
        if (allowMissingBank && !bankEntered) payload.allow_missing_bank = true;
      }
      if (needsUan && form.uan_no.trim()) payload.uan_no = form.uan_no.trim();
      const res = await api.post('/deployments', payload);
      onDone(res.message);
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      wide
      title={driver ? (rejoin ? `Rejoin — new client ID for ${driver.name}` : `Deploy ${driver.name}`) : 'Deploy driver'}
      onClose={onClose}
      footer={<>
        <button onClick={onClose}>Cancel</button>
        <button className="primary" onClick={submit} disabled={busy || !ready}>
          {busy ? <span className="spinner" /> : 'Deploy'}
        </button>
      </>}
    >
      <ErrorBanner error={profile.error} onRetry={profile.reload} />
      {!data ? (profile.error ? null : <Loading what="the driver" />) : (
        <>
          {/* The registered driver's details, for checking before the ID is entered. */}
          <div className="deploy-driver">
            <Avatar src={fileUrl(driver.photo_id)} name={driver.name} large />
            <dl className="kv" style={{ flex: 1, margin: 0 }}>
              <dt>Name</dt><dd><b>{driver.name}</b> <StatusChip value={driver.status} /></dd>
              <dt>Registration ID</dt><dd className="mono">{driver.registration_no}</dd>
              <dt>Phone</dt><dd>{driver.phone}</dd>
              <dt>Licence</dt>
              <dd className="mono">{driver.dl_no || '—'}
                {driver.dl_valid_till && (
                  <span className={`chip ${driver.dl_valid_till < today() ? 'red' : 'grey'}`} style={{ marginLeft: 6 }}>
                    valid till {date(driver.dl_valid_till)}
                  </span>
                )}
              </dd>
              <dt>Bank</dt>
              <dd>{driver.bank_account_no
                ? <span className="mono">{driver.bank_ifsc} · …{String(driver.bank_account_no).slice(-4)}</span>
                : <span className="chip red">not on record</span>}</dd>
            </dl>
          </div>

          {rejoin && (
            <div className="banner info">
              <span>🔗</span>
              <div>This new ID is linked to {driver.name}'s existing record, so earlier service keeps
                counting towards longevity.</div>
            </div>
          )}

          {pending.length > 0 && (
            <div className="banner error">
              <span>!</span>
              <div>
                <b>Screening is not complete:</b> {pending.map(([, l]) => l).join(', ')} still to pass.
                A driver can be deployed only after all three are passed — record them on the
                driver's Screening tab.
              </div>
            </div>
          )}

          <div className="grid c2">
            <Field label="Client ID" required hint="six digits, issued by the client">
              <input value={form.client_id} placeholder="400123" maxLength={6} inputMode="numeric"
                onChange={(e) => setForm((f) => ({ ...f, client_id: e.target.value.replace(/\D/g, '').slice(0, 6) }))} />
            </Field>
            <Field label="Vehicle No">
              <input value={form.vehicle_number} placeholder="DL01AB1234"
                onChange={(e) => setForm((f) => ({ ...f, vehicle_number: e.target.value.toUpperCase() }))} />
            </Field>
            <Field label="Location of deployment" required={locationList.length > 0}>
              {locationList.length ? (
                <select value={form.location} onChange={set('location')}>
                  <option value="">— choose the location —</option>
                  {locationList.map((l) => <option key={l.id} value={l.name}>{l.name}</option>)}
                </select>
              ) : (
                <input value={form.location} onChange={set('location')}
                  placeholder="No list set up yet — Admin / Director adds it in Settings" />
              )}
            </Field>
            <Field label="Date of joining" required hint="the deployed driver's start date">
              <input type="date" value={form.date_of_joining} onChange={set('date_of_joining')} />
            </Field>
          </div>
          <Field label="Salary class" required hint="linked to the salary structure in the salary master">
            <select value={form.salary_structure_id} onChange={set('salary_structure_id')}>
              <option value="">— choose the salary class —</option>
              {(structures.data?.rows || []).map((r) => (
                <option key={r.id} value={r.id}>{r.name}</option>
              ))}
            </select>
          </Field>

          {(needsBank || needsUan) && (
            <>
              <h4 style={{ margin: '16px 0 8px', fontSize: 13 }}>
                Not captured at registration
                <span className="muted small" style={{ fontWeight: 400 }}> — may be completed here</span>
              </h4>
              {needsBank && (
                <div className="grid c3">
                  <Field label="Account holder name">
                    <input value={form.bank_account_name} onChange={set('bank_account_name')}
                      placeholder={driver.name} />
                  </Field>
                  <Field label="Bank account number">
                    <input value={form.bank_account_no} inputMode="numeric" maxLength={18}
                      onChange={(e) => setForm((f) => ({ ...f, bank_account_no: e.target.value.replace(/\D/g, '').slice(0, 18) }))} />
                  </Field>
                  <Field label="IFSC code">
                    <input value={form.bank_ifsc} placeholder="SBIN0004521" maxLength={11}
                      onChange={(e) => setForm((f) => ({
                        ...f, bank_ifsc: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 11),
                      }))} />
                  </Field>
                </div>
              )}
              {needsUan && (
                <Field label="UAN number" hint="12 digits, optional">
                  <input value={form.uan_no} inputMode="numeric" maxLength={12}
                    onChange={(e) => setForm((f) => ({ ...f, uan_no: e.target.value.replace(/\D/g, '').slice(0, 12) }))} />
                </Field>
              )}
              {needsBank && !bankEntered && (
                <div className="banner warn">
                  <span>!</span>
                  <div>
                    The account number and IFSC are needed before this driver can be paid through the bank.
                    <label className="check" style={{ marginTop: 6 }}>
                      <input type="checkbox" checked={allowMissingBank}
                        onChange={(e) => setAllowMissingBank(e.target.checked)} />
                      Deploy now and add the bank details before the first payment
                    </label>
                  </div>
                </div>
              )}
            </>
          )}
        </>
      )}
    </Modal>
  );
}
