import React, { useState } from 'react';
import { api } from '../lib/api.js';
import { useAsync, useToast, Field, Modal } from '../lib/ui.jsx';
import { today } from '../lib/format.js';

/**
 * Raise a challan or debit against a driver. It becomes a recovery on their
 * next salary. Opened from a driver's profile the driver is fixed; opened
 * from the Challans & Debits list the driver is searched for.
 */
export default function DebitModal({ driver: fixed, onClose, onDone }) {
  const toast = useToast();
  const [driver, setDriver] = useState(fixed || null);
  const [search, setSearch] = useState('');
  const [form, setForm] = useState({
    kind: 'challan', details: '', debit_date: today(), reason: '', amount: '',
  });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const results = useAsync(
    () => (!fixed && search.length >= 2
      ? api.get(`/drivers?search=${encodeURIComponent(search)}&limit=8`)
      : Promise.resolve({ rows: [] })),
    [search],
  );

  const ready = driver && form.details.trim() && form.reason.trim() && Number(form.amount) > 0 && form.debit_date;

  async function submit() {
    setBusy(true);
    try {
      await api.post('/debits', { driver_id: driver.id, ...form });
      onDone();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Raise a challan / debit" onClose={onClose}
      footer={<>
        <button onClick={onClose}>Cancel</button>
        <button className="primary" disabled={busy || !ready} onClick={submit}>
          {busy ? <span className="spinner" /> : 'Send for approval'}
        </button>
      </>}>
      <div className="banner info">
        <span>ℹ</span>
        <div>It goes to Admin / Director for approval. Once approved, the amount is recovered from
          the driver's salary — after any advance recovery — and whatever one month's pay cannot
          cover is carried to the next.</div>
      </div>

      {driver ? (
        <div className="banner success">
          <span>✓</span>
          <div style={{ flex: 1 }}>
            <b>{driver.name}</b> · <span className="mono">{driver.registration_no}</span>
            {driver.client_id && <> · ID <span className="mono">{driver.client_id}</span></>}
          </div>
          {!fixed && <button className="sm" onClick={() => setDriver(null)}>Change</button>}
        </div>
      ) : (
        <>
          <Field label="Driver" required>
            <input value={search} onChange={(e) => setSearch(e.target.value)} autoFocus
              placeholder="Type a name, registration ID or client ID…" />
          </Field>
          {results.data?.rows?.length > 0 && (
            <table className="tbl" style={{ marginBottom: 14 }}>
              <tbody>
                {results.data.rows.map((d) => (
                  <tr key={d.id} style={{ cursor: 'pointer' }} onClick={() => setDriver(d)}>
                    <td><b>{d.name}</b></td>
                    <td className="mono">{d.registration_no}</td>
                    <td className="mono">{d.client_id || '—'}</td>
                    <td className="right"><button className="sm">Select</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}

      <div className="grid c2">
        <Field label="Type" required>
          <select value={form.kind} onChange={set('kind')}>
            <option value="challan">Challan</option>
            <option value="debit">Debit</option>
          </select>
        </Field>
        <Field label="Date of challan / debit" required>
          <input type="date" value={form.debit_date} max={today()} onChange={set('debit_date')} />
        </Field>
      </div>
      <Field label="Challan / debit details" required hint="challan number, vehicle, issuing authority…">
        <input value={form.details} onChange={set('details')} maxLength={200}
          placeholder={form.kind === 'challan' ? 'E-challan DL-TRF-2026-01234, vehicle DL01AB1234' : 'Workshop invoice W-341'} />
      </Field>
      <Field label="Reason" required>
        <input value={form.reason} onChange={set('reason')} maxLength={200}
          placeholder={form.kind === 'challan' ? 'Jumping a red light' : 'Damage to the rear bumper'} />
      </Field>
      <Field label="Amount (INR)" required>
        <input type="number" min={1} value={form.amount} onChange={set('amount')} />
      </Field>
    </Modal>
  );
}
