import React from 'react';
import { Link } from 'react-router-dom';
import { Page } from '../App.jsx';
import { api } from '../lib/api.js';
import { useAsync, useAuth, Card, Stat, Loading, ErrorBanner } from '../lib/ui.jsx';
import { inr0, date, periodLabel, titleCase } from '../lib/format.js';
import StatusChip from '../components/StatusChip.jsx';

const CODE_LABEL = { P: 'Driving / Present', T: 'Training', TA: 'In Transit', L: 'Leave', LE: 'Left' };

export default function Dashboard() {
  const { user } = useAuth();
  const { data, loading, error, reload } = useAsync(() => api.get('/dashboard'));

  if (loading) return <Page title="Dashboard"><Loading /></Page>;
  if (error) return <Page title="Dashboard"><ErrorBanner error={error} onRetry={reload} /></Page>;

  const { drivers, attendanceToday, approvals, money, insuranceGaps, alerts, payroll, rules } = data;
  const totalToday = Object.values(attendanceToday).reduce((a, b) => a + b, 0);

  return (
    <Page
      title={`Good day, ${user.name.split(' ')[0]}`}
      subtitle={`Operational snapshot for ${date(data.today)}`}
    >
      <div className="grid c4" style={{ marginBottom: 16 }}>
        <Stat tone="accent" label="Drivers on roll" value={drivers.total}
          foot={`${drivers.deployed} currently deployed`} />
        <Stat tone="amber" label="In screening" value={drivers.inScreening}
          foot={`${drivers.cleared} cleared, awaiting client ID`} />
        <Stat tone="good" label="Present today" value={attendanceToday.P || 0}
          foot={`of ${totalToday} deployed drivers`} />
        <Stat tone="bad" label="Advance outstanding" value={inr0(money.advance_outstanding)}
          foot="not yet recovered through salary" />
      </div>

      <div className="grid c2">
        <Card title="Attendance today" actions={<Link className="btn sm" to="/attendance">Open register</Link>}>
          {totalToday === 0 ? (
            <p className="muted">No deployed drivers yet.</p>
          ) : (
            <table className="tbl">
              <tbody>
                {['P', 'T', 'TA', 'L', 'LE'].map((code) => (
                  <tr key={code}>
                    <td style={{ width: 46 }}><span className={`chip ${
                      { P: 'green', T: 'blue', TA: 'amber', L: 'red', LE: 'grey' }[code]}`}>{code}</span></td>
                    <td>{CODE_LABEL[code]}</td>
                    <td className="num" style={{ width: 60, fontWeight: 650 }}>{attendanceToday[code] || 0}</td>
                    <td className="num muted" style={{ width: 60 }}>
                      {totalToday ? `${Math.round(((attendanceToday[code] || 0) / totalToday) * 100)}%` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="small muted" style={{ marginBottom: 0 }}>
            Unmarked days count as <b>P</b> for a deployed driver — supervisors only record the exceptions.
          </p>
        </Card>

        <Card title="Waiting on approval">
          <table className="tbl">
            <tbody>
              <tr>
                <td>Advances with Senior Manager</td>
                <td className="num"><b>{approvals.advances_pending_sm}</b></td>
                <td className="right"><Link className="btn sm" to="/advances">Review</Link></td>
              </tr>
              <tr>
                <td>Advances with Director</td>
                <td className="num"><b>{approvals.advances_pending_director}</b></td>
                <td className="right"><Link className="btn sm" to="/advances">Review</Link></td>
              </tr>
              <tr>
                <td>Advances approved, awaiting payment</td>
                <td className="num"><b>{approvals.advances_to_pay}</b> <span className="muted small">
                  {inr0(approvals.advances_to_pay_amount)}</span></td>
                <td className="right"><Link className="btn sm" to="/advances">Pay</Link></td>
              </tr>
              <tr>
                <td>Expenses with Senior Manager</td>
                <td className="num"><b>{approvals.expenses_pending_sm}</b></td>
                <td className="right"><Link className="btn sm" to="/expenses">Review</Link></td>
              </tr>
              <tr>
                <td>Expenses with Director <span className="muted small">(≥ {inr0(rules.expenseDirectorThreshold)})</span></td>
                <td className="num"><b>{approvals.expenses_pending_director}</b></td>
                <td className="right"><Link className="btn sm" to="/expenses">Review</Link></td>
              </tr>
              <tr>
                <td>Open expenses awaiting supporting</td>
                <td className="num"><b>{approvals.expenses_open}</b></td>
                <td className="right"><Link className="btn sm" to="/expenses">Settle</Link></td>
              </tr>
            </tbody>
          </table>
        </Card>

        <Card title="Insurance gaps" actions={<Link className="btn sm" to="/insurance">Manage</Link>}>
          {insuranceGaps.length === 0 ? (
            <div className="banner success">Every deployed driver is covered under all four policies.</div>
          ) : (
            <table className="tbl">
              <thead>
                <tr><th>Policy</th><th className="num">Drivers not covered</th><th /></tr>
              </thead>
              <tbody>
                {insuranceGaps.map((g) => (
                  <tr key={g.type}>
                    <td><b>{g.type}</b></td>
                    <td className="num">{g.uncovered}</td>
                    <td className="right">
                      <Link className="btn sm" to={`/insurance?type=${g.type}&covered=false`}>View</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card title="Attention needed">
          <table className="tbl">
            <tbody>
              <tr>
                <td>Deployed drivers with incomplete bank details</td>
                <td className="num"><b>{alerts.missingBank}</b></td>
              </tr>
              <tr>
                <td>Registered over 14 days, screening not complete</td>
                <td className="num"><b>{alerts.screeningStuck}</b></td>
              </tr>
              <tr>
                <td>Driving licences expiring within 60 days</td>
                <td className="num"><b>{alerts.dlExpiring.length}</b></td>
              </tr>
            </tbody>
          </table>
          {alerts.dlExpiring.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <div className="small muted" style={{ marginBottom: 6 }}>Licences expiring soonest</div>
              <table className="tbl">
                <tbody>
                  {alerts.dlExpiring.slice(0, 5).map((d) => (
                    <tr key={d.id}>
                      <td><Link to={`/drivers/${d.id}`}>{d.name}</Link></td>
                      <td className="mono muted">{d.registration_no}</td>
                      <td className="right">
                        <span className={`chip ${d.dl_valid_till < data.today ? 'red' : 'amber'}`}>
                          {d.dl_valid_till < data.today ? 'Expired ' : 'Valid till '}{date(d.dl_valid_till)}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card title="Money this month">
          <div className="grid c3">
            <Stat label="Advances" value={inr0(money.advances_this_month)} foot="approved or paid" />
            <Stat label="Expenses" value={inr0(money.expenses_this_month)} foot="approved or settled" />
            <Stat label="Outstanding" value={inr0(money.advance_outstanding)} foot="advance to recover" />
          </div>
          <p className="small muted" style={{ marginBottom: 0, marginTop: 10 }}>
            Advance payment runs accumulate to the {rules.cutoffs.NOON} and {rules.cutoffs.EVENING} cut-offs.
            Up to {rules.netbankingMaxRequests} requests go through internet banking; beyond that a bank sheet is generated.
          </p>
        </Card>

        <Card title="Payroll" actions={<Link className="btn sm" to="/salary">Open payroll</Link>}>
          {payroll.length === 0 ? (
            <p className="muted">No payroll period has been collated yet.</p>
          ) : (
            <table className="tbl">
              <thead><tr><th>Period</th><th>Status</th><th className="num">Drivers</th><th className="num">Net payable</th></tr></thead>
              <tbody>
                {payroll.map((p) => (
                  <tr key={p.period}>
                    <td><b>{periodLabel(p.period)}</b></td>
                    <td><StatusChip value={p.status} /></td>
                    <td className="num">{p.lines}</td>
                    <td className="num">{inr0(p.net)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </Page>
  );
}
