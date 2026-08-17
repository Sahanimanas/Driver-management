import React, { useState } from 'react';
import { Page } from '../App.jsx';
import { api, fileUrl } from '../lib/api.js';
import { useAsync, useToast, Card, Field, Loading, ErrorBanner, Empty, Stat } from '../lib/ui.jsx';
import { date, dateTime, inr, inr0, titleCase } from '../lib/format.js';

const KINDS = [
  ['advance', 'Salary advances', 'Paid advances not yet posted to Tally'],
  ['expense', 'Expenses & petty cash', 'Settled expenses with supporting on record'],
  ['salary', 'Salary payments', 'Salary paid against each driver'],
];

export default function Tally() {
  const toast = useToast();
  const [kind, setKind] = useState('advance');
  const [range, setRange] = useState(null);
  const [busy, setBusy] = useState(false);

  const week = useAsync(() => api.get('/tally/current-week'), []);
  const from = range?.from ?? week.data?.from ?? '';
  const to = range?.to ?? week.data?.to ?? '';

  const preview = useAsync(
    () => (from && to
      ? api.get(`/tally/preview?kind=${kind}&from=${from}&to=${to}`)
      : Promise.resolve(null)),
    [kind, from, to],
  );
  const history = useAsync(() => api.get('/tally/history'), []);

  async function generate() {
    setBusy(true);
    try {
      const res = await api.post('/tally/export', { kind, from, to });
      toast.success(`${res.count} voucher(s) generated — ${inr(res.total)}`);
      preview.reload();
      history.reload();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Page title="Tally linkage"
      subtitle="Weekly posting of advances, expenses and salary into the Tally ledger">
      <div className="banner info">
        <span>⇄</span>
        <div>
          Each run produces a Tally-importable XML voucher file plus a matching spreadsheet for
          checking. Ledgers are named <span className="mono">Driver Name (Registration No)</span> so
          entries reconcile back to the driver. Advances are marked once posted so a weekly run never
          double-posts them.
        </div>
      </div>

      <div className="grid c3" style={{ marginBottom: 16 }}>
        {KINDS.map(([k, label, hint]) => (
          <div key={k} className={`stat${kind === k ? ' accent' : ''}`} style={{ cursor: 'pointer' }}
            onClick={() => setKind(k)}>
            <div className="label">{label}</div>
            <div className="value" style={{ fontSize: 18 }}>
              {kind === k && preview.data ? `${preview.data.count} vouchers` : '—'}
            </div>
            <div className="foot">{hint}</div>
          </div>
        ))}
      </div>

      <Card title={`${titleCase(kind)} vouchers`} actions={<>
        <button onClick={() => setRange({ from: week.data?.from, to: week.data?.to })}>This week</button>
        <button className="primary" disabled={busy || !preview.data?.count} onClick={generate}>
          {busy ? <span className="spinner" /> : 'Generate Tally files'}
        </button>
      </>}>
        <div className="toolbar">
          <Field label="From"><input type="date" value={from}
            onChange={(e) => setRange({ from: e.target.value, to })} /></Field>
          <Field label="To"><input type="date" value={to}
            onChange={(e) => setRange({ from, to: e.target.value })} /></Field>
          <div className="spacer" />
          {preview.data && (
            <>
              <span className="chip grey">{preview.data.count} vouchers</span>
              <span className="chip blue">{inr(preview.data.total)}</span>
            </>
          )}
        </div>

        <ErrorBanner error={preview.error} onRetry={preview.reload} />

        {preview.loading ? <Loading /> : (
          <div className="tbl-wrap" style={{ maxHeight: 400 }}>
            <table className="tbl">
              <thead>
                <tr><th>Date</th><th>Voucher</th><th>Dr ledger</th><th>Cr ledger</th>
                  <th className="num">Amount</th><th>Narration</th></tr>
              </thead>
              <tbody>
                {(!preview.data || preview.data.rows.length === 0) && (
                  <Empty>Nothing to post for this window.</Empty>
                )}
                {preview.data?.rows.map((r, i) => (
                  <tr key={i}>
                    <td className="nowrap">{date(r.date)}</td>
                    <td className="mono small">{r.reference}</td>
                    <td>{r.ledger}</td>
                    <td className="muted">{r.counterLedger}</td>
                    <td className="num">{inr(r.amount)}</td>
                    <td className="small">{r.narration}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Export history" tight>
        <table className="tbl">
          <thead>
            <tr><th>Generated</th><th>Type</th><th>Window</th><th className="num">Vouchers</th>
              <th className="num">Total</th><th>By</th><th className="right">Files</th></tr>
          </thead>
          <tbody>
            {(history.data || []).length === 0 && <Empty>No Tally exports yet.</Empty>}
            {(history.data || []).map((h) => (
              <tr key={h.id}>
                <td className="nowrap">{dateTime(h.created_at)}</td>
                <td><span className="chip grey">{titleCase(h.kind)}</span></td>
                <td className="nowrap">{date(h.period_from)} → {date(h.period_to)}</td>
                <td className="num">{h.entry_count}</td>
                <td className="num">{inr0(h.total_amount)}</td>
                <td className="small muted">{h.created_by_name}</td>
                <td className="right nowrap">
                  <a className="btn sm" href={fileUrl(h.xml_id, { download: true })}>⭳ XML</a>{' '}
                  <a className="btn sm" href={fileUrl(h.xlsx_id, { download: true })}>⭳ XLSX</a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </Page>
  );
}
