import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { Page } from '../App.jsx';
import { api } from '../lib/api.js';
import {
  useAsync, useAuth, useToast, Card, Field, Modal, Loading, ErrorBanner, Empty, Stat,
} from '../lib/ui.jsx';
import { date, dateTime, inr, inr0, today } from '../lib/format.js';
import StatusChip, { ApprovalSteps } from '../components/StatusChip.jsx';

export default function Advances() {
  const { can, user } = useAuth();
  const [tab, setTab] = useState(
    can('accounts') && user.role === 'accounts' ? 'payments' : 'requests',
  );

  return (
    <Page title="Salary advances" subtitle="Raised by supervisors, approved by management, paid by accounts">
      <div className="tabs">
        <button className={tab === 'requests' ? 'active' : ''} onClick={() => setTab('requests')}>Requests</button>
        {can('accounts') && (
          <>
            <button className={tab === 'payments' ? 'active' : ''} onClick={() => setTab('payments')}>Payment runs</button>
            <button className={tab === 'batches' ? 'active' : ''} onClick={() => setTab('batches')}>Past runs</button>
          </>
        )}
        <button className={tab === 'register' ? 'active' : ''} onClick={() => setTab('register')}>Advance register</button>
      </div>

      {tab === 'requests' && <Requests />}
      {tab === 'payments' && <Payments />}
      {tab === 'batches' && <Batches />}
      {tab === 'register' && <Register />}
    </Page>
  );
}

// ---------------------------------------------------------------- requests
function Requests() {
  const { can, user } = useAuth();
  const toast = useToast();
  const [status, setStatus] = useState('pending_sm,pending_director,approved');
  const [newOpen, setNewOpen] = useState(false);
  const [acting, setActing] = useState(null);

  const { data, loading, error, reload } = useAsync(
    () => api.get(`/advances?status=${status}`), [status],
  );
  const inbox = useAsync(() => api.get('/advances/inbox'), []);

  return (
    <>
      <div className="grid c4" style={{ marginBottom: 16 }}>
        <Stat tone="amber" label="With Senior Manager" value={inbox.data?.pending_sm ?? '—'} />
        <Stat tone="accent" label="With Director" value={inbox.data?.pending_director ?? '—'} />
        <Stat tone="good" label="Approved, to pay" value={inbox.data?.approved_unpaid ?? '—'} />
        <Stat label="Filtered total" value={data ? inr0(data.totals.amount) : '—'}
          foot={data ? `${data.totals.count} request(s)` : ''} />
      </div>

      <div className="toolbar">
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="pending_sm,pending_director,approved">Open requests</option>
          <option value="pending_sm">With Senior Manager</option>
          <option value="pending_director">With Director</option>
          <option value="approved">Approved, awaiting payment</option>
          <option value="paid">Paid</option>
          <option value="rejected">Rejected</option>
          <option value="">All</option>
        </select>
        <div className="spacer" />
        {can('supervisor', 'senior_manager') && (
          <button className="primary" onClick={() => setNewOpen(true)}>+ Raise request</button>
        )}
      </div>

      <ErrorBanner error={error} onRetry={reload} />

      <Card tight>
        {!data ? (error ? null : <Loading what="requests" />) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Driver</th><th>Client ID</th><th className="num">Amount</th><th>Reason</th>
                  <th>Requested</th><th>Raised by</th><th>Progress</th><th className="right">Action</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.length === 0 && <Empty>No requests in this view.</Empty>}
                {data.rows.map((a) => (
                  <tr key={a.id}>
                    <td>
                      <Link to={`/drivers/${a.driver_id}`}><b>{a.driver_name}</b></Link>
                      <div className="muted small mono">{a.registration_no}</div>
                    </td>
                    <td className="mono">{a.client_id || '—'}</td>
                    <td className="num"><b>{inr(a.amount)}</b></td>
                    <td>{a.reason}</td>
                    <td className="nowrap">{date(a.request_date)}
                      <div className="muted small">{a.cutoff === 'NOON' ? 'before noon' : 'evening run'}</div>
                    </td>
                    <td className="small">{a.requested_by_name}</td>
                    <td><ApprovalSteps status={a.status} /></td>
                    <td className="right nowrap">
                      {(a.actions.canApproveSm || a.actions.canApproveDirector) && (
                        <>
                          <button className="sm good" onClick={() => setActing({ a, decision: 'approve' })}>Approve</button>{' '}
                          <button className="sm danger" onClick={() => setActing({ a, decision: 'reject' })}>Reject</button>
                        </>
                      )}
                      {a.status === 'paid' && <span className="chip green">UTR {a.utr || 'recorded'}</span>}
                      {a.actions.canCancel && !a.actions.canApproveSm && !a.actions.canApproveDirector && (
                        <button className="sm" onClick={async () => {
                          try {
                            await api.post(`/advances/${a.id}/cancel`, {});
                            toast.success('Request withdrawn');
                            reload();
                          } catch (err) { toast.error(err); }
                        }}>Withdraw</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {newOpen && <NewRequest onClose={() => setNewOpen(false)}
        onDone={(msg) => { setNewOpen(false); toast.success(msg); reload(); inbox.reload(); }} />}
      {acting && <DecisionModal {...acting} onClose={() => setActing(null)}
        onDone={() => { setActing(null); reload(); inbox.reload(); }} />}
    </>
  );
}

function NewRequest({ onClose, onDone }) {
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [driver, setDriver] = useState(null);
  const [form, setForm] = useState({ amount: '', reason: '', request_date: today() });
  const [busy, setBusy] = useState(false);

  const results = useAsync(
    () => (search.length >= 2 ? api.get(`/drivers?search=${encodeURIComponent(search)}&deployed=true&limit=8`) : Promise.resolve({ rows: [] })),
    [search],
  );

  async function submit() {
    setBusy(true);
    try {
      const res = await api.post('/advances', { driver_id: driver.id, ...form });
      onDone(`Request for ${inr(form.amount)} sent to the ${res.nextApprover}.`);
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Raise an advance request" onClose={onClose}
      footer={<>
        <button onClick={onClose}>Cancel</button>
        <button className="primary" disabled={busy || !driver || !form.amount || !form.reason} onClick={submit}>
          {busy ? <span className="spinner" /> : 'Submit for approval'}
        </button>
      </>}>
      <div className="banner info">
        <span>ℹ</span>
        <div>Raise the request on the driver's behalf once you are satisfied it is genuine. It goes to
          the Senior Manager, then the Director, before accounts release payment.</div>
      </div>

      {driver ? (
        <div className="banner success">
          <span>✓</span>
          <div style={{ flex: 1 }}>
            <b>{driver.name}</b> · <span className="mono">{driver.client_id}</span> · {driver.location}
          </div>
          <button className="sm" onClick={() => setDriver(null)}>Change</button>
        </div>
      ) : (
        <>
          <Field label="Driver" hint="deployed drivers only">
            <input value={search} onChange={(e) => setSearch(e.target.value)} autoFocus
              placeholder="Type a name or client ID…" />
          </Field>
          {results.data?.rows?.length > 0 && (
            <table className="tbl" style={{ marginBottom: 14 }}>
              <tbody>
                {results.data.rows.map((d) => (
                  <tr key={d.id} style={{ cursor: 'pointer' }} onClick={() => setDriver(d)}>
                    <td><b>{d.name}</b></td>
                    <td className="mono">{d.client_id}</td>
                    <td className="muted">{d.location}</td>
                    <td className="right"><button className="sm">Select</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}

      <div className="grid c2">
        <Field label="Amount (INR)">
          <input type="number" value={form.amount}
            onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))} />
        </Field>
        <Field label="Date of request">
          <input type="date" value={form.request_date}
            onChange={(e) => setForm((f) => ({ ...f, request_date: e.target.value }))} />
        </Field>
      </div>
      <Field label="Reason for request">
        <textarea value={form.reason} placeholder="Medical expense, school fees, house rent…"
          onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))} />
      </Field>
    </Modal>
  );
}

function DecisionModal({ a, decision, onClose, onDone }) {
  const toast = useToast();
  const [remarks, setRemarks] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      await api.post(`/advances/${a.id}/decision`, { decision, remarks });
      toast.success(decision === 'approve' ? 'Request approved' : 'Request rejected');
      onDone();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={`${decision === 'approve' ? 'Approve' : 'Reject'} — ${a.driver_name}`} onClose={onClose}
      footer={<>
        <button onClick={onClose}>Cancel</button>
        <button className={decision === 'approve' ? 'good' : 'danger'} onClick={submit} disabled={busy}>
          {busy ? <span className="spinner" /> : decision === 'approve' ? 'Approve' : 'Reject'}
        </button>
      </>}>
      <dl className="kv">
        <dt>Driver</dt><dd><b>{a.driver_name}</b> · <span className="mono">{a.client_id}</span></dd>
        <dt>Amount</dt><dd><b>{inr(a.amount)}</b></dd>
        <dt>Reason</dt><dd>{a.reason}</dd>
        <dt>Requested on</dt><dd>{date(a.request_date)} by {a.requested_by_name}</dd>
        {a.sm_by_name && <><dt>Senior Manager</dt><dd>{a.sm_by_name} — {a.sm_remarks || 'approved'}</dd></>}
      </dl>
      <Field label="Remarks" hint="optional">
        <textarea value={remarks} onChange={(e) => setRemarks(e.target.value)} style={{ minHeight: 60 }} />
      </Field>
    </Modal>
  );
}

// ---------------------------------------------------------------- payments
function Payments() {
  const toast = useToast();
  const [selected, setSelected] = useState({});
  const [busy, setBusy] = useState(false);
  const { data, loading, error, reload } = useAsync(() => api.get('/advances/payable'), []);

  const chosen = Object.entries(selected).filter(([, v]) => v).map(([k]) => Number(k));
  const chosenItems = (data?.groups || []).flatMap((g) => g.items).filter((i) => chosen.includes(i.id));
  const chosenTotal = chosenItems.reduce((s, i) => s + i.amount, 0);
  const method = chosen.length <= (data?.netbankingMaxRequests ?? 4) ? 'netbanking' : 'sheet';

  async function createBatch() {
    setBusy(true);
    try {
      const res = await api.post('/advances/batches', { advance_ids: chosen });
      toast.success(res.note);
      setSelected({});
      reload();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <Loading what="payable requests" />;
  if (error) return <ErrorBanner error={error} onRetry={reload} />;

  return (
    <>
      <div className="banner info">
        <span>🕛</span>
        <div>
          Requests accumulate to the <b>noon</b> and <b>18:30</b> cut-offs. A run of up to
          <b> {data.netbankingMaxRequests}</b> requests is paid through internet banking; beyond that
          the system generates a bank upload sheet.
        </div>
      </div>

      {data.groups.length === 0 && (
        <Card><p className="muted" style={{ margin: 0 }}>Nothing is approved and waiting for payment.</p></Card>
      )}

      {data.groups.map((g) => (
        <Card key={`${g.date}|${g.cutoff}`}
          title={`${date(g.date)} — ${g.cutoff === 'NOON' ? `up to noon (${g.cutoffTime})` : `evening run (${g.cutoffTime})`}`}
          actions={<>
            <span className="chip grey">{g.count} request(s)</span>
            <span className="chip blue">{inr(g.total)}</span>
            <span className={`chip ${g.suggestedMethod === 'netbanking' ? 'green' : 'violet'}`}>
              {g.suggestedMethod === 'netbanking' ? 'internet banking' : 'bank sheet'}
            </span>
            <button className="sm" onClick={() => setSelected((s) => {
              const next = { ...s };
              g.items.forEach((i) => { next[i.id] = true; });
              return next;
            })}>Select all</button>
          </>}
          tight
        >
          <table className="tbl">
            <thead>
              <tr><th style={{ width: 34 }} /><th>Driver</th><th>Client ID</th><th className="num">Amount</th>
                <th>Reason</th><th>Bank</th><th>Approved</th></tr>
            </thead>
            <tbody>
              {g.items.map((i) => (
                <tr key={i.id}>
                  <td>
                    <input type="checkbox" style={{ width: 'auto' }} checked={!!selected[i.id]}
                      onChange={(e) => setSelected((s) => ({ ...s, [i.id]: e.target.checked }))} />
                  </td>
                  <td><Link to={`/drivers/${i.driver_id}`}>{i.driver_name}</Link></td>
                  <td className="mono">{i.client_id}</td>
                  <td className="num"><b>{inr(i.amount)}</b></td>
                  <td>{i.reason}</td>
                  <td className="small">
                    {i.bank_account_no
                      ? <span className="mono">{i.bank_ifsc} · …{String(i.bank_account_no).slice(-4)}</span>
                      : <span className="chip red">bank details missing</span>}
                  </td>
                  <td className="small muted">{dateTime(i.director_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ))}

      {chosen.length > 0 && (
        <Card>
          <div className="row wrap">
            <b>{chosen.length} request(s) selected — {inr(chosenTotal)}</b>
            <span className={`chip ${method === 'netbanking' ? 'green' : 'violet'}`}>
              {method === 'netbanking'
                ? 'will be paid through internet banking'
                : 'will be paid by uploading a bank sheet'}
            </span>
            <div className="spacer" style={{ flex: 1 }} />
            <button onClick={() => setSelected({})}>Clear</button>
            <button className="primary" onClick={createBatch} disabled={busy}>
              {busy ? <span className="spinner" /> : 'Create payment run'}
            </button>
          </div>
        </Card>
      )}
    </>
  );
}

function Batches() {
  const toast = useToast();
  const [paying, setPaying] = useState(null);
  const { data, loading, error, reload } = useAsync(() => api.get('/advances/batches'), []);

  if (loading) return <Loading what="payment runs" />;
  if (error) return <ErrorBanner error={error} onRetry={reload} />;

  return (
    <>
      <Card tight>
        <table className="tbl">
          <thead>
            <tr><th>Run</th><th>Date</th><th>Cut-off</th><th>Method</th><th className="num">Requests</th>
              <th className="num">Total</th><th>Status</th><th className="right">Action</th></tr>
          </thead>
          <tbody>
            {data.length === 0 && <Empty>No payment runs created yet.</Empty>}
            {data.map((b) => (
              <tr key={b.id}>
                <td className="mono">#{b.id}</td>
                <td>{date(b.batch_date)}</td>
                <td>{b.cutoff === 'NOON' ? 'Noon' : 'Evening'}</td>
                <td>
                  <span className={`chip ${b.method === 'netbanking' ? 'green' : 'violet'}`}>
                    {b.method === 'netbanking' ? 'Internet banking' : 'Bank sheet'}
                  </span>
                </td>
                <td className="num">{b.item_count}</td>
                <td className="num"><b>{inr(b.total_amount)}</b></td>
                <td><StatusChip value={b.status === 'paid' ? 'paid' : 'open'} /></td>
                <td className="right nowrap">
                  {b.method === 'sheet' && (
                    <button className="sm" onClick={() => api.download(
                      `/advances/batches/${b.id}/sheet`, `advance-batch-${b.id}.xlsx`)}>⭳ Sheet</button>
                  )}{' '}
                  {b.status === 'open' && <button className="sm primary" onClick={() => setPaying(b)}>Record payment</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      {paying && <PayModal batch={paying} onClose={() => setPaying(null)}
        onDone={() => { setPaying(null); toast.success('Payment recorded'); reload(); }} />}
    </>
  );
}

function PayModal({ batch, onClose, onDone }) {
  const toast = useToast();
  const [utrs, setUtrs] = useState({});
  const [paidAt, setPaidAt] = useState(today());
  const [busy, setBusy] = useState(false);
  const { data, loading } = useAsync(() => api.get(`/advances/batches/${batch.id}`), [batch.id]);

  async function submit() {
    setBusy(true);
    try {
      await api.post(`/advances/batches/${batch.id}/pay`, { paid_at: paidAt, utrs });
      onDone();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={`Record payment — run #${batch.id}`} wide onClose={onClose}
      footer={<>
        <button onClick={onClose}>Cancel</button>
        <button className="primary" onClick={submit} disabled={busy}>Mark as paid</button>
      </>}>
      <Field label="Payment date"><input type="date" value={paidAt} onChange={(e) => setPaidAt(e.target.value)} /></Field>
      {!data ? (error ? null : <Loading />) : (
        <table className="tbl">
          <thead><tr><th>Driver</th><th className="num">Amount</th><th>Account</th><th>UTR / reference</th></tr></thead>
          <tbody>
            {data.items.map((i) => (
              <tr key={i.id}>
                <td>{i.driver_name}</td>
                <td className="num">{inr(i.amount)}</td>
                <td className="mono small">{i.bank_account_no || '—'}</td>
                <td>
                  <input value={utrs[i.id] || ''} placeholder="UTR"
                    onChange={(e) => setUtrs((u) => ({ ...u, [i.id]: e.target.value }))} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------- register
function Register() {
  const [from, setFrom] = useState(`${today().slice(0, 7)}-01`);
  const [to, setTo] = useState(today());
  const { data, loading, error, reload } = useAsync(
    () => api.get(`/advances?from=${from}&to=${to}`), [from, to],
  );

  return (
    <>
      <div className="toolbar">
        <Field label="From"><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="To"><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        <div className="spacer" />
        <button className="primary" onClick={() => api.download(
          `/advances/register?from=${from}&to=${to}`, `advance-register-${from}_to_${to}.xlsx`)}>
          ⭳ Download advance register
        </button>
      </div>

      <ErrorBanner error={error} onRetry={reload} />

      <Card tight>
        {!data ? (error ? null : <Loading />) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr><th>#</th><th>Date</th><th>Driver</th><th>Client ID</th><th className="num">Amount</th>
                  <th>Reason</th><th>Status</th><th>Paid on</th><th>UTR</th><th className="num">Outstanding</th></tr>
              </thead>
              <tbody>
                {data.rows.length === 0 && <Empty>No requests in this period.</Empty>}
                {data.rows.map((a) => (
                  <tr key={a.id}>
                    <td className="mono">{a.id}</td>
                    <td className="nowrap">{date(a.request_date)}</td>
                    <td><Link to={`/drivers/${a.driver_id}`}>{a.driver_name}</Link></td>
                    <td className="mono">{a.client_id || '—'}</td>
                    <td className="num">{inr(a.amount)}</td>
                    <td>{a.reason}</td>
                    <td><StatusChip value={a.status} /></td>
                    <td className="nowrap">{a.paid_at ? date(a.paid_at) : '—'}</td>
                    <td className="mono small">{a.utr || '—'}</td>
                    <td className="num">{a.status === 'paid' ? inr(a.amount - a.recovered) : '—'}</td>
                  </tr>
                ))}
              </tbody>
              {data.rows.length > 0 && (
                <tfoot>
                  <tr>
                    <td colSpan={4}><b>Total</b></td>
                    <td className="num"><b>{inr(data.totals.amount)}</b></td>
                    <td colSpan={5} />
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
