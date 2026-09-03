import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { Page } from '../App.jsx';
import { api, fileUrl } from '../lib/api.js';
import {
  useAsync, useAuth, useToast, Card, Field, Modal, Loading, ErrorBanner, Empty, Stat,
} from '../lib/ui.jsx';
import { date, inr, inr0, titleCase, today } from '../lib/format.js';
import StatusChip, { ApprovalSteps } from '../components/StatusChip.jsx';

export default function Expenses() {
  const { can } = useAuth();
  const [tab, setTab] = useState('requests');

  return (
    <Page title="Expenses & petty cash"
      subtitle="Purchase requirements, reimbursements and the petty cash float">
      <div className="tabs">
        <button className={tab === 'requests' ? 'active' : ''} onClick={() => setTab('requests')}>Requests</button>
        <button className={tab === 'petty' ? 'active' : ''} onClick={() => setTab('petty')}>Petty cash</button>
      </div>
      {tab === 'requests' && <Requests />}
      {tab === 'petty' && <PettyCash />}
    </Page>
  );
}

function Requests() {
  const { can } = useAuth();
  const toast = useToast();
  const [status, setStatus] = useState('pending_approval,approved');
  const [newOpen, setNewOpen] = useState(false);
  const [acting, setActing] = useState(null);
  const [settling, setSettling] = useState(null);

  const meta = useAsync(() => api.get('/expenses/meta'), []);
  const inbox = useAsync(() => api.get('/expenses/inbox'), []);
  const { data, loading, error, reload } = useAsync(() => api.get(`/expenses?status=${status}`), [status]);
  const threshold = meta.data?.directorThreshold ?? 3000;

  return (
    <>
      <div className="grid c4" style={{ marginBottom: 16 }}>
        <Stat tone="amber" label="Awaiting approval" value={inbox.data?.pending_approval ?? '—'}
          foot="with Admin / Director" />
        <Stat tone="accent" label="My open requests" value={inbox.data?.my_requests ?? '—'}
          foot={`requests of ${inr0(threshold)} and above`} />
        <Stat tone="warn" label="Open, awaiting supporting" value={inbox.data?.open_settlements ?? '—'} />
        <Stat label="Filtered total" value={data ? inr0(data.totals.amount) : '—'}
          foot={data ? `${data.totals.count} request(s)` : ''} />
      </div>

      <div className="banner info">
        <span>ℹ</span>
        <div>
          Below <b>{inr0(threshold)}</b> the Senior Manager is the final approver and the supervisor
          pays from petty cash, then uploads the receipt and payment proof. At <b>{inr0(threshold)}</b>
          {' '}and above the Director also approves and accounts pay directly. An expense stays open
          until the supporting documents are on record.
        </div>
      </div>

      <div className="toolbar">
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="pending_approval,approved">Open requests</option>
          <option value="pending_approval">Awaiting approval</option>
          <option value="approved">Approved, awaiting settlement</option>
          <option value="settled">Settled</option>
          <option value="rejected">Rejected</option>
          <option value="">All</option>
        </select>
        <div className="spacer" />
        <button onClick={() => api.download(
          `/expenses/export/register?from=${today().slice(0, 4)}-01-01&to=${today()}`,
          'expense-register.xlsx')}>⭳ Register</button>
        {can('supervisor') && (
          <button className="primary" onClick={() => setNewOpen(true)}>+ Raise request</button>
        )}
      </div>

      <ErrorBanner error={error} onRetry={reload} />

      <Card tight>
        {!data ? (error ? null : <Loading what="expenses" />) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Purpose</th><th>Driver</th><th className="num">Amount</th><th>Type</th>
                  <th>Paid by</th><th>Progress</th><th>Supporting</th><th className="right">Action</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.length === 0 && <Empty>No requests in this view.</Empty>}
                {data.rows.map((x) => (
                  <tr key={x.id}>
                    <td>
                      <b>{x.purpose}</b>
                      <div className="muted small">{titleCase(x.category)} · {date(x.request_date)} · {x.requested_by_name}</div>
                    </td>
                    <td>{x.driver_name
                      ? <Link to={`/drivers/${x.driver_id}`}>{x.driver_name}</Link>
                      : <span className="muted">general</span>}</td>
                    <td className="num"><b>{inr(x.amount)}</b></td>
                    <td><span className="chip grey">{titleCase(x.kind)}</span></td>
                    <td>
                      <span className={`chip ${x.route === 'petty_cash' ? 'amber' : 'blue'}`}>
                        {x.route === 'petty_cash' ? 'Petty cash' : 'Accounts'}
                      </span>
                    </td>
                    <td><ApprovalSteps status={x.status} finalLabel="Settled"
                      skipDirector={x.amount < (meta.data?.directorThreshold ?? 3000)} /></td>
                    <td>
                      {x.attachments.length
                        ? x.attachments.map((a) => (
                          <a key={a.id} className="chip green" style={{ marginRight: 4 }}
                            href={fileUrl(a.id)} target="_blank" rel="noreferrer">
                            {a.kind === 'receipt' ? '🧾' : '💳'}
                          </a>
                        ))
                        : <span className="muted small">none</span>}
                    </td>
                    <td className="right nowrap">
                      {x.actions.canApprove && (
                        <>
                          <button className="sm good" onClick={() => setActing({ x, decision: 'approve' })}>Approve</button>{' '}
                          <button className="sm danger" onClick={() => setActing({ x, decision: 'reject' })}>Reject</button>
                        </>
                      )}
                      {x.actions.canSettle && (
                        <button className="sm primary" onClick={() => setSettling(x)}>Settle</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {newOpen && <NewExpense threshold={threshold} categories={meta.data?.categories || []}
        onClose={() => setNewOpen(false)}
        onDone={(msg) => { setNewOpen(false); toast.success(msg); reload(); inbox.reload(); }} />}
      {acting && <DecisionModal {...acting} onClose={() => setActing(null)}
        onDone={() => { setActing(null); reload(); inbox.reload(); }} />}
      {settling && <SettleModal expense={settling} onClose={() => setSettling(null)}
        onDone={() => { setSettling(null); toast.success('Expense settled'); reload(); inbox.reload(); }} />}
    </>
  );
}

function NewExpense({ threshold, categories, onClose, onDone }) {
  const toast = useToast();
  const [form, setForm] = useState({
    purpose: '', amount: '', kind: 'expense', category: 'other', request_date: today(), driver_id: '',
  });
  const [search, setSearch] = useState('');
  const [driver, setDriver] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const results = useAsync(
    () => (search.length >= 2
      ? api.get(`/drivers?search=${encodeURIComponent(search)}&deployed=true&limit=6`)
      : Promise.resolve({ rows: [] })),
    [search],
  );

  const needsDirector = Number(form.amount) >= threshold;

  async function submit() {
    setBusy(true);
    try {
      const res = await api.post('/expenses', { ...form, driver_id: driver?.id || undefined });
      onDone(res.note);
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Raise an expense / purchase request" onClose={onClose}
      footer={<>
        <button onClick={onClose}>Cancel</button>
        <button className="primary" onClick={submit} disabled={busy || !form.purpose || !form.amount}>
          {busy ? <span className="spinner" /> : 'Submit for approval'}
        </button>
      </>}>
      <Field label="Purpose of expense">
        <input value={form.purpose} onChange={set('purpose')} autoFocus
          placeholder="Safety shoes, medical bill, cab repair…" />
      </Field>

      <div className="grid c3">
        <Field label="Amount (INR)"><input type="number" value={form.amount} onChange={set('amount')} /></Field>
        <Field label="Category">
          <select value={form.category} onChange={set('category')}>
            {categories.map((c) => <option key={c} value={c}>{titleCase(c)}</option>)}
          </select>
        </Field>
        <Field label="Reimbursement or expense">
          <select value={form.kind} onChange={set('kind')}>
            <option value="expense">Expense</option>
            <option value="reimbursement">Reimbursement</option>
          </select>
        </Field>
      </div>

      {driver ? (
        <div className="banner success">
          <span>✓</span>
          <div style={{ flex: 1 }}><b>{driver.name}</b> · <span className="mono">{driver.client_id}</span></div>
          <button className="sm" onClick={() => setDriver(null)}>Clear</button>
        </div>
      ) : (
        <>
          <Field label="Against a driver" hint="optional — leave blank for a general expense">
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name or client ID…" />
          </Field>
          {results.data?.rows?.length > 0 && (
            <table className="tbl" style={{ marginBottom: 12 }}>
              <tbody>
                {results.data.rows.map((d) => (
                  <tr key={d.id} style={{ cursor: 'pointer' }} onClick={() => setDriver(d)}>
                    <td><b>{d.name}</b></td><td className="mono">{d.client_id}</td>
                    <td className="right"><button className="sm">Select</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}

      {form.amount && (
        <div className={`banner ${needsDirector ? 'warn' : 'info'}`}>
          <span>{needsDirector ? '⚠' : 'ℹ'}</span>
          <div>{needsDirector
            ? `${inr(form.amount)} is at or above ${inr0(threshold)} — Senior Manager and Director approval are needed, and accounts will pay directly.`
            : `${inr(form.amount)} is below ${inr0(threshold)} — the Senior Manager approves, then you pay from petty cash and upload the supporting.`}</div>
        </div>
      )}
    </Modal>
  );
}

function DecisionModal({ x, decision, onClose, onDone }) {
  const toast = useToast();
  const [remarks, setRemarks] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      await api.post(`/expenses/${x.id}/decision`, { decision, remarks });
      toast.success(decision === 'approve' ? 'Expense approved' : 'Expense rejected');
      onDone();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={`${decision === 'approve' ? 'Approve' : 'Reject'} — ${x.purpose}`} onClose={onClose}
      footer={<>
        <button onClick={onClose}>Cancel</button>
        <button className={decision === 'approve' ? 'good' : 'danger'} onClick={submit} disabled={busy}>
          {decision === 'approve' ? 'Approve' : 'Reject'}
        </button>
      </>}>
      <dl className="kv">
        <dt>Purpose</dt><dd><b>{x.purpose}</b></dd>
        <dt>Amount</dt><dd><b>{inr(x.amount)}</b></dd>
        <dt>Driver</dt><dd>{x.driver_name || 'General expense'}</dd>
        <dt>Type</dt><dd>{titleCase(x.kind)} · {titleCase(x.category)}</dd>
        <dt>Raised by</dt><dd>{x.requested_by_name} on {date(x.request_date)}</dd>
        <dt>Payment route</dt><dd>{x.route === 'petty_cash' ? 'Supervisor petty cash' : 'Accounts, directly'}</dd>
      </dl>
      <Field label="Remarks" hint="optional">
        <textarea value={remarks} onChange={(e) => setRemarks(e.target.value)} style={{ minHeight: 60 }} />
      </Field>
    </Modal>
  );
}

function SettleModal({ expense, onClose, onDone }) {
  const toast = useToast();
  const [paidAmount, setPaidAmount] = useState(expense.amount);
  const [txnRef, setTxnRef] = useState('');
  const [busy, setBusy] = useState(false);
  const [attachments, setAttachments] = useState(expense.attachments);

  async function upload(kind, file) {
    if (!file) return;
    try {
      const fd = new FormData();
      fd.append('files', file);
      fd.append('kind', kind);
      const res = await api.upload(`/expenses/${expense.id}/attachments`, fd);
      setAttachments(res.attachments);
      toast.success('Supporting uploaded');
    } catch (err) {
      toast.error(err);
    }
  }

  async function submit() {
    setBusy(true);
    try {
      await api.post(`/expenses/${expense.id}/settle`, {
        paid_amount: paidAmount, txn_ref: txnRef, settled_at: today(),
      });
      onDone();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={`Settle — ${expense.purpose}`} onClose={onClose}
      footer={<>
        <button onClick={onClose}>Cancel</button>
        <button className="primary" onClick={submit} disabled={busy || attachments.length === 0}>
          {busy ? <span className="spinner" /> : 'Mark as settled'}
        </button>
      </>}>
      <div className="grid c2">
        <Field label="Amount actually paid">
          <input type="number" value={paidAmount} onChange={(e) => setPaidAmount(e.target.value)} />
        </Field>
        <Field label="Transaction reference">
          <input value={txnRef} onChange={(e) => setTxnRef(e.target.value)} placeholder="UPI / UTR / cash voucher no" />
        </Field>
      </div>

      <Field label="Receipt / bill"><input type="file" accept="image/*,application/pdf"
        onChange={(e) => upload('receipt', e.target.files[0])} /></Field>
      <Field label="Payment transaction proof"><input type="file" accept="image/*,application/pdf"
        onChange={(e) => upload('txn_proof', e.target.files[0])} /></Field>

      {attachments.length > 0 ? (
        <table className="tbl">
          <tbody>
            {attachments.map((a) => (
              <tr key={a.id}>
                <td><span className="chip grey">{a.kind === 'receipt' ? 'Receipt' : 'Payment proof'}</span></td>
                <td>{a.filename}</td>
                <td className="right"><a className="btn sm" href={fileUrl(a.id)} target="_blank" rel="noreferrer">View</a></td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="banner warn">
          <span>!</span>
          <div>Upload at least one supporting document before settling — the expense stays open until
            the receipt and payment details are on record.</div>
        </div>
      )}
    </Modal>
  );
}

// -------------------------------------------------------------- petty cash
function PettyCash() {
  const { can } = useAuth();
  const toast = useToast();
  const [issueOpen, setIssueOpen] = useState(false);
  const { data, loading, error, reload } = useAsync(() => api.get('/expenses/petty-cash/ledger'), []);

  if (loading) return <Loading what="the petty cash ledger" />;
  if (error) return <ErrorBanner error={error} onRetry={reload} />;

  return (
    <>
      <div className="toolbar">
        <div className="spacer" />
        {can('finance') && <button className="primary" onClick={() => setIssueOpen(true)}>+ Issue petty cash</button>}
      </div>

      <Card title="Supervisor balances" tight>
        <table className="tbl">
          <thead><tr><th>Supervisor</th><th className="num">Issued</th><th className="num">Spent</th>
            <th className="num">Returned</th><th className="num">Balance in hand</th></tr></thead>
          <tbody>
            {data.balances.length === 0 && <Empty>No supervisors on record.</Empty>}
            {data.balances.map((b) => (
              <tr key={b.id}>
                <td><b>{b.name}</b></td>
                <td className="num">{inr(b.issued)}</td>
                <td className="num">{inr(b.spent)}</td>
                <td className="num">{inr(b.returned)}</td>
                <td className="num"><b className={b.balance < 0 ? 'chip red' : ''}>{inr(b.balance)}</b></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card title="Ledger" tight>
        <div className="tbl-wrap" style={{ maxHeight: '50vh' }}>
          <table className="tbl">
            <thead><tr><th>Date</th><th>Supervisor</th><th>Entry</th><th className="num">Amount</th><th>Note</th></tr></thead>
            <tbody>
              {data.entries.length === 0 && <Empty>No petty cash movement recorded.</Empty>}
              {data.entries.map((e) => (
                <tr key={e.id}>
                  <td className="nowrap">{date(e.entry_date)}</td>
                  <td>{e.supervisor_name}</td>
                  <td>
                    <span className={`chip ${e.direction === 'issue' ? 'blue' : e.direction === 'spend' ? 'amber' : 'grey'}`}>
                      {titleCase(e.direction)}
                    </span>
                  </td>
                  <td className="num">{inr(e.amount)}</td>
                  <td className="muted">{e.note || e.purpose || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {issueOpen && <IssueModal supervisors={data.balances} onClose={() => setIssueOpen(false)}
        onDone={() => { setIssueOpen(false); toast.success('Petty cash recorded'); reload(); }} />}
    </>
  );
}

function IssueModal({ supervisors, onClose, onDone }) {
  const toast = useToast();
  const [form, setForm] = useState({
    supervisor_id: supervisors[0]?.id || '', amount: '', direction: 'issue', note: '', entry_date: today(),
  });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit() {
    setBusy(true);
    try {
      await api.post('/expenses/petty-cash', form);
      onDone();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Petty cash movement" onClose={onClose}
      footer={<>
        <button onClick={onClose}>Cancel</button>
        <button className="primary" onClick={submit} disabled={busy || !form.amount}>Record</button>
      </>}>
      <div className="grid c2">
        <Field label="Supervisor">
          <select value={form.supervisor_id} onChange={set('supervisor_id')}>
            {supervisors.map((s) => <option key={s.id} value={s.id}>{s.name} — balance {inr(s.balance)}</option>)}
          </select>
        </Field>
        <Field label="Direction">
          <select value={form.direction} onChange={set('direction')}>
            <option value="issue">Issue cash to supervisor</option>
            <option value="return">Return of unspent cash</option>
          </select>
        </Field>
        <Field label="Amount"><input type="number" value={form.amount} onChange={set('amount')} /></Field>
        <Field label="Date"><input type="date" value={form.entry_date} onChange={set('entry_date')} /></Field>
      </div>
      <Field label="Note"><input value={form.note} onChange={set('note')} /></Field>
    </Modal>
  );
}
