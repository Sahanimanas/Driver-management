import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { Page } from '../App.jsx';
import { api } from '../lib/api.js';
import {
  useAsync, useAuth, useToast, Card, Field, Modal, Loading, ErrorBanner, Empty, Stat,
} from '../lib/ui.jsx';
import { date, inr, inr0, periodLabel, shiftPeriod, thisPeriod, today } from '../lib/format.js';
import StatusChip from '../components/StatusChip.jsx';

export default function Salary() {
  const { can } = useAuth();
  const toast = useToast();
  const [period, setPeriod] = useState(shiftPeriod(thisPeriod(), -1));
  const [busy, setBusy] = useState('');
  const [editing, setEditing] = useState(null);
  const [reconcileOpen, setReconcileOpen] = useState(false);
  const [payOpen, setPayOpen] = useState(false);

  const { data, loading, error, reload } = useAsync(() => api.get(`/salary/periods/${period}`), [period]);
  const periods = useAsync(() => api.get('/salary/periods'), []);
  const manage = can('finance');

  async function act(kind, fn, message) {
    setBusy(kind);
    try {
      const res = await fn();
      toast.success(typeof message === 'function' ? message(res) : message);
      reload();
      periods.reload();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy('');
    }
  }

  const p = data?.period;
  const totals = data?.totals;

  return (
    <Page
      title="Salary"
      subtitle={`${periodLabel(period)} — collate attendance, review, pay, reconcile`}
      actions={<>
        <button onClick={() => setPeriod(shiftPeriod(period, -1))}>‹</button>
        <input type="month" value={period} onChange={(e) => setPeriod(e.target.value)} style={{ width: 150 }} />
        <button onClick={() => setPeriod(shiftPeriod(period, 1))} disabled={period >= thisPeriod()}>›</button>
      </>}
    >
      <div className="grid c4" style={{ marginBottom: 16 }}>
        <Stat tone="accent" label="Status"
          value={p ? <StatusChip value={p.status} /> : <span className="muted">not started</span>}
          foot={p?.client_confirmed ? 'attendance confirmed with client' : 'attendance not yet confirmed'} />
        <Stat label="Drivers" value={totals?.count ?? '—'} foot={totals ? `${totals.paid} paid, ${totals.held} on hold` : ''} />
        <Stat tone="good" label="Net payable" value={totals ? inr0(totals.net) : '—'}
          foot={totals ? `gross ${inr0(totals.gross)}` : ''} />
        <Stat tone="warn" label="Advance recovery" value={totals ? inr0(totals.advance) : '—'}
          foot={totals ? `held back ${inr0(totals.heldAmount)}` : ''} />
      </div>

      {manage && (
        <Card title="Workflow">
          <div className="row wrap">
            <button className="primary" disabled={busy === 'collate'}
              onClick={() => act('collate',
                () => api.post(`/salary/periods/${period}/collate`),
                (r) => `Collated ${r.lines} driver(s) — gross ${inr0(r.gross)}`)}>
              1 · Collate attendance
            </button>
            <button disabled={!p || busy === 'finalize'}
              onClick={() => act('finalize',
                () => api.post(`/salary/periods/${period}/finalize-attendance`, { client_confirmed: true }),
                'Attendance finalised with the client')}>
              2 · Finalise with client
            </button>
            <button disabled={!p}
              onClick={() => api.download(`/salary/periods/${period}/wage-register`, `wage-register-${period}.xlsx`)}>
              3 · ⭳ Wage register (for invoicing)
            </button>
            <button disabled={!p} className="primary"
              onClick={() => api.download(`/salary/periods/${period}/enet-sheet`, `hdfc-enet-${period}.xlsx`)}>
              4 · ⭳ HDFC e-Net payment sheet
            </button>
            <button disabled={!p} onClick={() => setPayOpen(true)}>5 · Record payments</button>
            <button disabled={!p} onClick={() => setReconcileOpen(true)}>5b · ⭱ Upload bank statement</button>
            <button disabled={!p || p.status === 'closed'}
              onClick={() => act('close', () => api.post(`/salary/periods/${period}/close`, {}),
                'Payroll closed and the attendance register locked')}>
              6 · Close month
            </button>
          </div>
          <p className="small muted" style={{ marginBottom: 0, marginTop: 10 }}>
            Payable days = Present (P) + Training (T) + In Transit (TA). Leave (L) and Left (LE) are not
            billed. Outstanding paid advances are pulled in automatically as a recovery.
          </p>
        </Card>
      )}

      <ErrorBanner error={error} onRetry={reload} />

      <Card title="Driver payment sheet" tight
        actions={p && <span className="muted small">Edit attendance days, hold a driver, or adjust deductions before paying.</span>}>
        {loading ? <Loading what="the payment sheet" /> : !p ? (
          <div className="loading">
            No payroll has been collated for {periodLabel(period)}.
            {manage && ' Use “Collate attendance” above to build it.'}
          </div>
        ) : (
          <div className="tbl-wrap" style={{ maxHeight: '60vh' }}>
            <table className="tbl">
              <thead>
                <tr>
                  <th>Driver</th><th>Client ID</th><th>Location</th>
                  <th className="num">P</th><th className="num">T</th><th className="num">TA</th><th className="num">L</th>
                  <th className="num">Payable days</th><th className="num">Rate</th><th className="num">Gross</th>
                  <th className="num">Advance</th><th className="num">Other</th><th className="num">Net</th>
                  <th>Status</th><th className="right">Action</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.length === 0 && <Empty>No lines in this payroll.</Empty>}
                {data.rows.map((r) => (
                  <tr key={r.id} style={r.hold ? { background: '#fdf6f5' } : undefined}>
                    <td>
                      <Link to={`/drivers/${r.driver_id}`}><b>{r.name}</b></Link>
                      <div className="muted small mono">{r.registration_no}</div>
                    </td>
                    <td className="mono">{r.client_id}</td>
                    <td className="small">{r.location || '—'}</td>
                    <td className="num">{r.present_days}</td>
                    <td className="num">{r.training_days}</td>
                    <td className="num">{r.transit_days}</td>
                    <td className="num">{r.leave_days}</td>
                    <td className="num"><b>{r.payable_days}</b></td>
                    <td className="num">{inr(r.rate_per_day)}</td>
                    <td className="num">{inr(r.gross)}</td>
                    <td className="num">{r.advance_deduction ? inr(r.advance_deduction) : '—'}</td>
                    <td className="num">{r.other_deduction ? inr(r.other_deduction) : '—'}</td>
                    <td className="num"><b>{inr(r.net_payable)}</b></td>
                    <td>
                      {r.hold
                        ? <span className="chip red" title={r.hold_reason}>Hold</span>
                        : <StatusChip value={r.status} />}
                    </td>
                    <td className="right">
                      {manage && r.status !== 'paid' && p.status !== 'closed' && (
                        <button className="sm" onClick={() => setEditing(r)}>Edit</button>
                      )}
                      {r.status === 'paid' && <span className="mono small muted">{r.utr || 'paid'}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
              {data.rows.length > 0 && (
                <tfoot>
                  <tr>
                    <td colSpan={9}><b>Totals</b></td>
                    <td className="num"><b>{inr(totals.gross)}</b></td>
                    <td className="num"><b>{inr(totals.advance)}</b></td>
                    <td className="num"><b>{inr(totals.other)}</b></td>
                    <td className="num"><b>{inr(totals.net)}</b></td>
                    <td colSpan={2} className="small muted">excludes {totals.held} held</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        )}
      </Card>

      <Card title="All payroll periods" tight>
        <table className="tbl">
          <thead><tr><th>Period</th><th>Status</th><th className="num">Drivers</th>
            <th className="num">Net</th><th>Finalised by</th></tr></thead>
          <tbody>
            {(periods.data || []).length === 0 && <Empty>No payroll periods yet.</Empty>}
            {(periods.data || []).map((x) => (
              <tr key={x.id} style={{ cursor: 'pointer' }} onClick={() => setPeriod(x.period)}>
                <td><b>{periodLabel(x.period)}</b></td>
                <td><StatusChip value={x.status} /></td>
                <td className="num">{x.line_count}</td>
                <td className="num">{inr0(x.net_total)}</td>
                <td className="small muted">{x.finalized_by_name || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      {editing && <LineModal line={editing} onClose={() => setEditing(null)}
        onDone={() => { setEditing(null); toast.success('Payment line updated'); reload(); }} />}
      {reconcileOpen && <ReconcileModal period={period} onClose={() => setReconcileOpen(false)}
        onDone={() => { setReconcileOpen(false); reload(); }} />}
      {payOpen && data?.rows && <RecordPayModal period={period} rows={data.rows.filter((r) => !r.hold && r.status !== 'paid')}
        onClose={() => setPayOpen(false)}
        onDone={(n) => { setPayOpen(false); toast.success(`${n} payment(s) recorded`); reload(); }} />}
    </Page>
  );
}

function LineModal({ line, onClose, onDone }) {
  const toast = useToast();
  const [form, setForm] = useState({
    present_days: line.present_days, training_days: line.training_days,
    transit_days: line.transit_days, leave_days: line.leave_days,
    rate_per_day: line.rate_per_day, advance_deduction: line.advance_deduction,
    other_deduction: line.other_deduction, hold: !!line.hold, hold_reason: line.hold_reason || '',
  });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const payable = Number(form.present_days) + Number(form.training_days) + Number(form.transit_days);
  const gross = payable * Number(form.rate_per_day);
  const net = gross - Number(form.advance_deduction) - Number(form.other_deduction);

  async function submit() {
    setBusy(true);
    try {
      await api.patch(`/salary/lines/${line.id}`, form);
      onDone();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={`${line.name} — payment line (${line.client_id})`} wide onClose={onClose}
      footer={<>
        <button onClick={onClose}>Cancel</button>
        <button className="primary" onClick={submit} disabled={busy || net < 0}>Save</button>
      </>}>
      <div className="grid c4">
        <Field label="Present (P)"><input type="number" value={form.present_days} onChange={set('present_days')} /></Field>
        <Field label="Training (T)"><input type="number" value={form.training_days} onChange={set('training_days')} /></Field>
        <Field label="In transit (TA)"><input type="number" value={form.transit_days} onChange={set('transit_days')} /></Field>
        <Field label="Leave (L)"><input type="number" value={form.leave_days} onChange={set('leave_days')} /></Field>
      </div>
      <div className="grid c3">
        <Field label="Rate per day"><input type="number" value={form.rate_per_day} onChange={set('rate_per_day')} /></Field>
        <Field label="Advance recovery"><input type="number" value={form.advance_deduction} onChange={set('advance_deduction')} /></Field>
        <Field label="Other deduction"><input type="number" value={form.other_deduction} onChange={set('other_deduction')} /></Field>
      </div>

      <div className="banner info">
        <span>=</span>
        <div>
          Payable days <b>{payable}</b> × rate <b>{inr(form.rate_per_day)}</b> = gross <b>{inr(gross)}</b>,
          net after deductions <b>{inr(net)}</b>
          {net < 0 && <span className="chip red" style={{ marginLeft: 8 }}>deductions exceed gross</span>}
        </div>
      </div>

      <label className="check" style={{ marginBottom: 10 }}>
        <input type="checkbox" checked={form.hold}
          onChange={(e) => setForm((f) => ({ ...f, hold: e.target.checked }))} />
        Hold this driver's payment
      </label>
      {form.hold && (
        <Field label="Reason for hold">
          <input value={form.hold_reason} onChange={set('hold_reason')}
            placeholder="Documents pending, disciplinary, disputed attendance…" />
        </Field>
      )}
    </Modal>
  );
}

function RecordPayModal({ period, rows, onClose, onDone }) {
  const toast = useToast();
  const [utrs, setUtrs] = useState({});
  const [paidOn, setPaidOn] = useState(today());
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      const res = await api.post(`/salary/periods/${period}/record-payments`, {
        payments: rows.map((r) => ({ line_id: r.id, utr: utrs[r.id] || null, paid_on: paidOn })),
      });
      onDone(res.applied);
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={`Record salary payments — ${periodLabel(period)}`} wide onClose={onClose}
      footer={<>
        <button onClick={onClose}>Cancel</button>
        <button className="primary" onClick={submit} disabled={busy || rows.length === 0}>
          Mark {rows.length} driver(s) paid
        </button>
      </>}>
      <Field label="Payment date"><input type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} /></Field>
      <div className="tbl-wrap" style={{ maxHeight: 340 }}>
        <table className="tbl">
          <thead><tr><th>Driver</th><th className="num">Net payable</th><th>UTR</th></tr></thead>
          <tbody>
            {rows.length === 0 && <Empty>Every unheld driver has already been paid.</Empty>}
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{r.name}</td>
                <td className="num">{inr(r.net_payable)}</td>
                <td><input value={utrs[r.id] || ''} placeholder="optional"
                  onChange={(e) => setUtrs((u) => ({ ...u, [r.id]: e.target.value }))} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Modal>
  );
}

function ReconcileModal({ period, onClose, onDone }) {
  const toast = useToast();
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  async function submit() {
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await api.upload(`/salary/periods/${period}/bank-statement`, fd);
      setResult(res);
      toast.success(`${res.matched} payment(s) matched, ${res.unmatched} could not be matched`);
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={`Update payments from the bank statement — ${periodLabel(period)}`} wide onClose={onClose}
      footer={<>
        <button onClick={onClose}>Close</button>
        {!result && <button className="primary" onClick={submit} disabled={!file || busy}>
          {busy ? <span className="spinner" /> : 'Reconcile'}
        </button>}
        {result && <button className="primary" onClick={onDone}>Done</button>}
      </>}>
      <div className="banner info">
        <span>ℹ</span>
        <div>Upload the bank statement export. Rows are matched to drivers by the
          <span className="mono"> SAL-{period}-…</span> reference, then by beneficiary account number,
          then by a unique matching amount.</div>
      </div>
      <Field label="Bank statement (xlsx / csv)">
        <input type="file" accept=".xlsx,.xls,.csv" onChange={(e) => { setFile(e.target.files[0]); setResult(null); }} />
      </Field>

      {result && (
        <>
          <div className={`banner ${result.unmatched ? 'warn' : 'success'}`}>
            <span>{result.unmatched ? '!' : '✓'}</span>
            <div>{result.matched} payment(s) applied. {result.unmatched} row(s) could not be matched.</div>
          </div>
          {result.details.matched.length > 0 && (
            <table className="tbl">
              <thead><tr><th>Driver</th><th className="num">Amount</th><th>UTR</th></tr></thead>
              <tbody>
                {result.details.matched.slice(0, 20).map((m, i) => (
                  <tr key={i}><td>{m.driver}</td><td className="num">{inr(m.amount)}</td>
                    <td className="mono small">{m.utr || '—'}</td></tr>
                ))}
              </tbody>
            </table>
          )}
          {result.details.unmatched.length > 0 && (
            <>
              <h4 style={{ margin: '14px 0 8px', fontSize: 13 }}>Unmatched rows</h4>
              <table className="tbl">
                <thead><tr><th>Row</th><th>Reference</th><th>Account</th><th className="num">Amount</th></tr></thead>
                <tbody>
                  {result.details.unmatched.slice(0, 20).map((u, i) => (
                    <tr key={i}><td>{u.row}</td><td className="small">{u.ref || '—'}</td>
                      <td className="mono small">{u.account || '—'}</td><td className="num">{inr(u.amount)}</td></tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </>
      )}
    </Modal>
  );
}
