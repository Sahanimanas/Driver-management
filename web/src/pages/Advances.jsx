import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { Page } from '../App.jsx';
import { api } from '../lib/api.js';
import {
  useAsync, useAuth, useToast, Card, Field, Modal, Loading, ErrorBanner, Empty, Stat,
} from '../lib/ui.jsx';
import { date, dateTime, inr, inr0, today } from '../lib/format.js';
import StatusChip, { ApprovalSteps } from '../components/StatusChip.jsx';
import DebitModal from '../components/DebitModal.jsx';

export default function Advances() {
  const { can, user } = useAuth();
  const [tab, setTab] = useState(
    can('finance') && user.role === 'finance' ? 'payments' : 'requests',
  );

  return (
    <Page title="Salary advances" subtitle="Raised by supervisors, approved by Admin / Director, paid by Finance">
      <div className="tabs">
        <button className={tab === 'requests' ? 'active' : ''} onClick={() => setTab('requests')}>Requests</button>
        {can('finance') && (
          <>
            <button className={tab === 'payments' ? 'active' : ''} onClick={() => setTab('payments')}>Payment runs</button>
            <button className={tab === 'batches' ? 'active' : ''} onClick={() => setTab('batches')}>Past runs</button>
          </>
        )}
        <button className={tab === 'register' ? 'active' : ''} onClick={() => setTab('register')}>Advance register</button>
        <button className={tab === 'debits' ? 'active' : ''} onClick={() => setTab('debits')}>Challans / Debits</button>
      </div>

      {tab === 'requests' && <Requests />}
      {tab === 'payments' && <Payments />}
      {tab === 'batches' && <Batches />}
      {tab === 'register' && <Register />}
      {tab === 'debits' && <Debits />}
    </Page>
  );
}

// ---------------------------------------------------------------- requests
function Requests() {
  const { can, user } = useAuth();
  const toast = useToast();
  const [status, setStatus] = useState('pending_approval,approved');
  const [newOpen, setNewOpen] = useState(false);
  const [acting, setActing] = useState(null);

  const { data, loading, error, reload } = useAsync(
    () => api.get(`/advances?status=${status}`), [status],
  );
  const inbox = useAsync(() => api.get('/advances/inbox'), []);

  return (
    <>
      <div className="grid c4" style={{ marginBottom: 16 }}>
        <Stat tone="amber" label="Awaiting approval" value={inbox.data?.pending_approval ?? '—'}
          foot="with Admin / Director" />
        <Stat tone="good" label="Approved, to pay" value={inbox.data?.approved_unpaid ?? '—'}
          foot="with Finance" />
        <Stat label="My open requests" value={inbox.data?.my_requests ?? '—'} />
        <Stat label="Filtered total" value={data ? inr0(data.totals.amount) : '—'}
          foot={data ? `${data.totals.count} request(s)` : ''} />
      </div>

      <div className="toolbar">
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="pending_approval,approved">Open requests</option>
          <option value="pending_approval">Awaiting approval</option>
          <option value="approved">Approved, awaiting payment</option>
          <option value="paid">Paid</option>
          <option value="rejected">Rejected</option>
          <option value="">All</option>
        </select>
        <div className="spacer" />
        {can('supervisor') && (
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
                      {a.actions.canApprove && (
                        <>
                          <button className="sm good" onClick={() => setActing({ a, decision: 'approve' })}>Approve</button>{' '}
                          <button className="sm danger" onClick={() => setActing({ a, decision: 'reject' })}>Reject</button>
                        </>
                      )}
                      {a.status === 'paid' && <span className="chip green">UTR {a.utr || 'recorded'}</span>}
                      {a.actions.canCancel && !a.actions.canApprove && (
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
  const position = useAsync(
    () => (driver ? api.get(`/advances/context/${driver.id}?on=${form.request_date}`) : Promise.resolve(null)),
    [driver?.id, form.request_date],
  );
  const pos = position.data;
  const overLimit = pos && Number(form.amount) > pos.eligible;

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
        <div>Raise the request on the driver's behalf once you are satisfied it is genuine. It goes
          to Admin / Director for approval, and Finance releases the payment.</div>
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

      {pos && (
        <div className={`banner ${overLimit ? 'warn' : 'info'}`}>
          <span>₹</span>
          <div>
            Can be advanced up to <b>{inr(pos.eligible)}</b> this month — {pos.limitPercent}% of
            {' '}{inr(pos.accruedSalary)} earned over {pos.payableDays} day(s) of attendance
            {pos.grantedThisMonth > 0 && <>, less {inr(pos.grantedThisMonth)} already approved or paid</>}.
            {overLimit && <div style={{ marginTop: 4 }}>
              This request is over the limit — Admin / Director can approve only up to {inr(pos.eligible)}.
            </div>}
          </div>
        </div>
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
  // The approver may sign off a smaller (or larger) figure than was asked for.
  const [amount, setAmount] = useState(a.amount);
  const [busy, setBusy] = useState(false);
  const [eligible, setEligible] = useState(null);

  const adjusted = decision === 'approve' && Number(amount) !== Number(a.amount);
  const withinLimit = eligible === null || Number(amount) <= eligible;
  const valid = decision !== 'approve' || (Number(amount) > 0 && withinLimit);

  async function submit() {
    setBusy(true);
    try {
      await api.post(`/advances/${a.id}/decision`, {
        decision,
        remarks,
        ...(decision === 'approve' ? { amount } : {}),
      });
      toast.success(decision === 'approve'
        ? (adjusted
          ? `Approved at ${inr(amount)} against ${inr(a.amount)} requested`
          : 'Request approved')
        : 'Request rejected');
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
        <button className={decision === 'approve' ? 'good' : 'danger'} onClick={submit}
          disabled={busy || !valid}>
          {busy ? <span className="spinner" />
            : decision === 'approve'
              ? (adjusted ? `Approve ${inr(amount)}` : 'Approve')
              : 'Reject'}
        </button>
      </>}>
      <dl className="kv">
        <dt>Driver</dt><dd><b>{a.driver_name}</b> · <span className="mono">{a.client_id}</span></dd>
        <dt>Amount requested</dt><dd><b>{inr(a.amount)}</b></dd>
        <dt>Reason</dt><dd>{a.reason}</dd>
        <dt>Requested on</dt><dd>{date(a.request_date)} by {a.requested_by_name}</dd>
      </dl>

      <ApprovalContext
        advanceId={a.id}
        amount={amount}
        onAmountChange={decision === 'approve' ? setAmount : undefined}
        onLoaded={(ctx) => setEligible(ctx.eligible)}
      />
      <Field label="Remarks" hint="optional">
        <textarea value={remarks} onChange={(e) => setRemarks(e.target.value)} style={{ minHeight: 60 }} />
      </Field>
    </Modal>
  );
}

/**
 * "While approving, the approver should be able to see how much advance has
 * been given to the driver for the month and how much salary is accrued as per
 * attendance." Both, plus what is left once this request is met.
 */
function ApprovalContext({ advanceId, amount, onAmountChange, onLoaded }) {
  const { data, error } = useAsync(
    () => api.get(`/advances/${advanceId}/context`).then((d) => { onLoaded?.(d); return d; }),
    [advanceId],
  );

  if (error) return <div className="banner error"><span>⚠</span><div>{error.message}</div></div>;
  if (!data) return <div className="loading"><span className="spinner" /> Loading the driver's position…</div>;

  const asked = Number(amount) || 0;

  // Everything already committed this month, then this request on top. The
  // context deliberately excludes this request from its own totals, so it is
  // added exactly once here.
  const committed = data.advancesThisMonth;
  const withThis = round2(committed + asked);
  const earned = data.accruedSalary;

  // Positive: the company still owes the driver this at month end.
  // Negative: the driver has taken more than they have earned and carries it.
  const balance = round2(earned - withThis);
  const over = balance < 0;
  const breach = asked > data.eligible;

  return (
    <>
      <div className="ledger">
        <div className={`grp limit${breach ? ' breach' : ''}`}>
          <div className="grp-head">Advance limit — {data.limitPercent}% of salary earned on attendance</div>
          <Line label="Paid to the driver this month" value={data.paidThisMonth}
            note={data.approvedThisMonth ? `plus ${inr(data.approvedThisMonth)} approved, awaiting payment` : undefined} />
          <Line label={`Limit (${data.limitPercent}% of ${inr(earned)})`} value={data.advanceLimit}
            note={`${data.payableDays} day(s) of attendance at ${inr(data.ratePerDay)}/day`} muted />
          <Line label="Can still be approved" value={data.eligible} sub />
          {breach && (
            <div className="small" style={{ marginTop: 6 }}>
              {inr(asked)} is over the limit by {inr(round2(asked - data.eligible))}.
              {onAmountChange && data.eligible > 0 && (
                <> <button className="sm" onClick={() => onAmountChange(data.eligible)}>
                  Approve {inr(data.eligible)} instead</button></>
              )}
              {data.eligible <= 0 && ' Nothing more can be approved this month on the attendance so far.'}
            </div>
          )}
        </div>

        <div className="grp">
          <div className="grp-head">Advances this month ({data.period})</div>
          <Line label="Requested, awaiting approval" value={data.requestedThisMonth} muted />
          <Line label="Approved, not yet paid" value={data.approvedThisMonth} muted />
          <Line label="Already paid out" value={data.paidThisMonth} muted />
          <Line label="Committed before this request" value={committed} sub />
        </div>

        <div className="grp">
          <div className="grp-head">Earned so far</div>
          <Line
            label="Salary accrued as per attendance"
            value={earned}
            note={`${data.payableDays} payable day(s) at ${inr(data.ratePerDay)}/day`}
          />
        </div>

        <div className="grp">
          <div className="grp-head">This request</div>
          <div className="ln">
            <span>Amount to approve</span>
            <span className="v">
              <input
                type="number" min={0} step={100} value={amount}
                onChange={(e) => onAmountChange?.(e.target.value)}
                disabled={!onAmountChange}
                style={{ width: 130, textAlign: 'right' }}
              />
            </span>
          </div>
          <Line label="Total advances once approved" value={withThis} sub />
        </div>

        <div className={`grp final ${over ? 'over' : 'ok'}`}>
          <div className="ln big">
            <span>{over ? 'Driver would owe back' : 'Still payable to the driver'}</span>
            <span className="v"><b>{inr(Math.abs(balance))}</b></span>
          </div>
          <div className="small muted" style={{ marginTop: 4 }}>
            {over
              ? `Advances would exceed what ${inr(earned)} of attendance has earned. `
                + `The excess is carried and recovered from a later month.`
              : `After this advance, ${inr(balance)} of this month's earnings remains to pay at month end.`}
          </div>
        </div>

        {/* Paid advances are deducted in full from the month's salary when it is
            paid, so nothing carries over from earlier months to show here. */}
        {data.openDebits > 0 && (
          <div className="grp">
            <Line
              label="Challans / debits still to recover"
              value={data.openDebits}
              note="also recovered from salary, after advances"
              muted
            />
          </div>
        )}
      </div>

      <AdvanceHistory history={data.history} totals={data.historyTotals} />
    </>
  );
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** One line of the ledger. `sub` marks a subtotal, `muted` a contributing row. */
function Line({ label, value, note, sub, muted }) {
  return (
    <div className={`ln${sub ? ' sub' : ''}${muted ? ' muted-row' : ''}`}>
      <span>
        {label}
        {note && <div className="small muted">{note}</div>}
      </span>
      <span className="v">{sub ? <b>{inr(value)}</b> : inr(value)}</span>
    </div>
  );
}

/**
 * Every earlier advance for this driver, newest first.
 *
 * The totals above answer "how much"; this answers "how often, and did the
 * last ones get recovered" — which is the part an approver is really weighing
 * on a repeat request. Fixed height and scrolled, so a driver with a long
 * history cannot push the Approve button off the screen.
 */
function AdvanceHistory({ history, totals }) {
  if (!history?.length) {
    return (
      <div className="muted small" style={{ marginTop: 12 }}>
        No earlier advances for this driver — this is their first request.
      </div>
    );
  }

  return (
    <div style={{ marginTop: 14 }}>
      <div className="row wrap" style={{ marginBottom: 6 }}>
        <b className="small">Past advances</b>
        <span className="muted small">
          {totals.count} request(s) · {inr(totals.lifetime)} approved to date
          {totals.rejected ? ` · ${totals.rejected} rejected` : ''}
        </span>
      </div>

      <div className="tbl-wrap" style={{ maxHeight: 200, overflowY: 'auto' }}>
        <table className="tbl">
          <thead>
            <tr>
              <th>Date</th>
              <th className="num">Amount</th>
              <th>Reason</th>
              <th>Status</th>
              <th className="num">Outstanding</th>
            </tr>
          </thead>
          <tbody>
            {history.map((h) => (
              <tr key={h.id}>
                <td className="nowrap small">{date(h.request_date)}</td>
                <td className="num">{inr(h.amount)}</td>
                <td className="small">{h.reason}</td>
                <td><StatusChip value={h.status} /></td>
                <td className="num small">
                  {h.outstanding > 0
                    ? <b>{inr(h.outstanding)}</b>
                    : <span className="muted">{h.status === 'paid' ? 'recovered' : '—'}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- payments
function Payments() {
  const toast = useToast();
  const [selected, setSelected] = useState({});
  const [busy, setBusy] = useState(false);
  const { data, loading, error, reload } = useAsync(() => api.get('/advances/payable'), []);

  const [sheetDate, setSheetDate] = useState(today());
  const [dayBusy, setDayBusy] = useState(false);

  /** Every approved advance up to the date, in one HDFC bulk upload. */
  async function daySheet(format) {
    setDayBusy(true);
    try {
      const res = await api.post('/advances/day-sheet', { date: sheetDate });
      await api.download(
        `/advances/batches/${res.batch.id}/sheet${format === 'csv' ? '?format=csv' : ''}`,
        `hdfc-advances-${sheetDate}-run${res.batch.id}.${format}`,
      );
      toast.success(`${res.count} advance(s), ${inr(res.total)}, in payment run #${res.batch.id}. `
        + 'Upload the file in HDFC, then record the payment under Past runs.');
      if (res.skipped?.length) {
        toast.error(`Left out for missing bank details: ${res.skipped.map((s) => s.driver).join(', ')}`);
      }
      reload();
    } catch (err) {
      toast.error(err);
    } finally {
      setDayBusy(false);
    }
  }

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

      {data.groups.length > 0 && (
        <Card title="HDFC bulk payment — the day's advances">
          <div className="row wrap">
            <Field label="Advances approved up to">
              <input type="date" value={sheetDate} max={today()} onChange={(e) => setSheetDate(e.target.value)} />
            </Field>
            <div className="spacer" style={{ flex: 1 }} />
            <button className="primary" disabled={dayBusy} onClick={() => daySheet('xlsx')}>
              {dayBusy ? <span className="spinner" /> : '⭳ HDFC sheet (.xlsx)'}
            </button>
            <button disabled={dayBusy} onClick={() => daySheet('csv')}>⭳ HDFC file (.csv)</button>
          </div>
          <p className="small muted" style={{ marginBottom: 0 }}>
            Puts every approved advance waiting to be paid, up to the date, into one payment run and
            one file for HDFC bulk upload. Drivers without bank details are left out and named.
          </p>
        </Card>
      )}

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
                  <td className="small muted">{dateTime(i.approved_at)}</td>
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
                    <>
                      <button className="sm" onClick={() => api.download(
                        `/advances/batches/${b.id}/sheet`, `hdfc-advances-${b.batch_date}-run${b.id}.xlsx`)}>⭳ HDFC .xlsx</button>{' '}
                      <button className="sm" onClick={() => api.download(
                        `/advances/batches/${b.id}/sheet?format=csv`, `hdfc-advances-${b.batch_date}-run${b.id}.csv`)}>.csv</button>
                    </>
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
  const { data, loading, error } = useAsync(() => api.get(`/advances/batches/${batch.id}`), [batch.id]);

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
      <ErrorBanner error={error} />
      {!data ? (error ? null : <Loading what="the requests in this run" />) : (
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

// ------------------------------------------------------- challans / debits
/**
 * Challans and debits raised against drivers. Each is recovered from salary
 * after advances; the list shows how much of each is still to come back.
 */
function Debits() {
  const { can } = useAuth();
  const toast = useToast();
  const [status, setStatus] = useState(can('admin') ? 'pending_approval' : 'open');
  const [raising, setRaising] = useState(false);
  const [cancelling, setCancelling] = useState(null);
  const [deciding, setDeciding] = useState(null);
  const { data, error, reload } = useAsync(() => api.get(`/debits?status=${status}`), [status]);

  return (
    <>
      <div className="grid c4" style={{ marginBottom: 16 }}>
        <Stat tone="amber" label="Still to recover" value={data ? inr0(data.totals.outstanding) : '—'}
          foot="from the next salary" />
        <Stat tone="violet" label="Awaiting approval" value={data ? data.totals.pending : '—'}
          foot="in this view · Admin / Director" />
        <Stat label="In this view" value={data ? data.totals.count : '—'}
          foot={data ? inr0(data.totals.amount) : ''} />
      </div>

      <div className="toolbar">
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="pending_approval">Awaiting approval</option>
          <option value="open">Open — being recovered</option>
          <option value="recovered">Recovered</option>
          <option value="rejected">Rejected</option>
          <option value="cancelled">Cancelled</option>
          <option value="">All</option>
        </select>
        <div className="spacer" />
        <button onClick={() => api.download(`/debits/register?status=${status}`, 'challans-debits.xlsx')}>
          ⭳ Download register
        </button>
        {can('supervisor', 'finance') && (
          <button className="primary" onClick={() => setRaising(true)}>+ Challan / debit</button>
        )}
      </div>

      <ErrorBanner error={error} onRetry={reload} />

      <Card tight>
        {!data ? (error ? null : <Loading what="challans and debits" />) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Date</th><th>Driver</th><th>Type</th><th>Details</th><th>Reason</th>
                  <th className="num">Amount</th><th className="num">Outstanding</th><th>Status</th>
                  <th>Raised by</th><th />
                </tr>
              </thead>
              <tbody>
                {data.rows.length === 0 && <Empty>Nothing in this view.</Empty>}
                {data.rows.map((x) => (
                  <tr key={x.id}>
                    <td className="nowrap">{date(x.debit_date)}</td>
                    <td>
                      <Link to={`/drivers/${x.driver_id}`}><b>{x.driver_name}</b></Link>
                      <div className="muted small mono">{x.client_id || x.registration_no}</div>
                    </td>
                    <td><span className={`chip ${x.kind === 'challan' ? 'violet' : 'grey'}`}>
                      {x.kind === 'challan' ? 'Challan' : 'Debit'}</span></td>
                    <td className="small">{x.details}</td>
                    <td className="small">{x.reason}</td>
                    <td className="num">{inr(x.amount)}</td>
                    <td className="num">{x.status === 'open' ? <b>{inr(x.outstanding)}</b> : '—'}</td>
                    <td>
                      <StatusChip value={x.status} />
                      {x.cancel_reason && <div className="muted small">{x.cancel_reason}</div>}
                      {x.approval_remarks && <div className="muted small">{x.approval_remarks}</div>}
                    </td>
                    <td className="small">
                      {x.created_by_name}
                      {x.approved_by_name && (
                        <div className="muted">
                          {x.status === 'rejected' ? 'rejected' : 'approved'} by {x.approved_by_name}
                        </div>
                      )}
                    </td>
                    <td className="right nowrap">
                      {x.canDecide && <button className="sm primary" onClick={() => setDeciding(x)}>Review</button>}{' '}
                      {x.canCancel && <button className="sm" onClick={() => setCancelling(x)}>Cancel</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {raising && (
        <DebitModal
          onClose={() => setRaising(false)}
          onDone={() => { setRaising(false); toast.success('Sent to Admin / Director for approval'); reload(); }}
        />
      )}
      {deciding && (
        <DecideDebit
          debit={deciding}
          onClose={() => setDeciding(null)}
          onDone={(approved) => {
            setDeciding(null);
            toast.success(approved ? 'Approved — it will be recovered from the next salary' : 'Rejected');
            reload();
          }}
        />
      )}
      {cancelling && (
        <CancelDebit
          debit={cancelling}
          onClose={() => setCancelling(null)}
          onDone={() => { setCancelling(null); toast.success('Cancelled'); reload(); }}
        />
      )}
    </>
  );
}

function DecideDebit({ debit, onClose, onDone }) {
  const toast = useToast();
  const [remarks, setRemarks] = useState('');
  const [busy, setBusy] = useState(false);
  async function decide(decision) {
    setBusy(true);
    try {
      await api.post(`/debits/${debit.id}/decision`, { decision, remarks });
      onDone(decision === 'approve');
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={`Approve ${debit.kind} — ${debit.driver_name}`} onClose={onClose}
      footer={<>
        <button onClick={onClose}>Close</button>
        <button className="danger" onClick={() => decide('reject')} disabled={busy || !remarks.trim()}
          title={remarks.trim() ? '' : 'Record why it is being rejected'}>Reject</button>
        <button className="primary" onClick={() => decide('approve')} disabled={busy}>Approve</button>
      </>}>
      <table className="tbl" style={{ marginBottom: 14 }}>
        <tbody>
          <tr><td className="muted">Date</td><td>{date(debit.debit_date)}</td></tr>
          <tr><td className="muted">Details</td><td>{debit.details}</td></tr>
          <tr><td className="muted">Reason</td><td>{debit.reason}</td></tr>
          <tr><td className="muted">Amount</td><td><b>{inr(debit.amount)}</b></td></tr>
          <tr><td className="muted">Raised by</td><td>{debit.created_by_name}</td></tr>
        </tbody>
      </table>
      <Field label="Remarks" hint="required to reject">
        <textarea value={remarks} onChange={(e) => setRemarks(e.target.value)} style={{ minHeight: 60 }} />
      </Field>
    </Modal>
  );
}

function CancelDebit({ debit, onClose, onDone }) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true);
    try {
      await api.post(`/debits/${debit.id}/cancel`, { reason });
      onDone();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={`Cancel ${debit.kind} — ${debit.driver_name}`} onClose={onClose}
      footer={<>
        <button onClick={onClose}>Keep it</button>
        <button className="danger" onClick={submit} disabled={busy || reason.trim().length < 3}>Cancel it</button>
      </>}>
      <p style={{ marginTop: 0 }}>{debit.details} — {inr(debit.amount)}</p>
      <Field label="Why is it being cancelled?" required>
        <textarea value={reason} onChange={(e) => setReason(e.target.value)} style={{ minHeight: 60 }} />
      </Field>
    </Modal>
  );
}
