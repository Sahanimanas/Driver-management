import React from 'react';
import { STATUS_TONE, STATUS_LABEL, titleCase } from '../lib/format.js';

export default function StatusChip({ value, label }) {
  if (!value) return <span className="muted">—</span>;
  return (
    <span className={`chip ${STATUS_TONE[value] || 'grey'}`}>
      {label || STATUS_LABEL[value] || titleCase(value)}
    </span>
  );
}

/** Approval pipeline: raised → SM → Director → paid/settled. */
export function ApprovalSteps({ status, finalLabel = 'Paid', skipDirector }) {
  const order = ['raised', 'pending_sm', 'pending_director', 'approved', 'final'];
  const at = {
    pending_sm: 1, pending_director: 2, approved: 3, paid: 4, settled: 4, rejected: -1,
  }[status] ?? 0;

  const steps = [
    { key: 'raised', label: 'Raised' },
    { key: 'pending_sm', label: 'Senior Manager' },
    ...(skipDirector ? [] : [{ key: 'pending_director', label: 'Director' }]),
    { key: 'approved', label: 'Approved' },
    { key: 'final', label: finalLabel },
  ];

  if (status === 'rejected') {
    return <span className="chip red">Rejected</span>;
  }

  return (
    <div className="steps">
      {steps.map((s, i) => {
        const idx = order.indexOf(s.key);
        const cls = idx < at ? 'done' : idx === at ? 'current' : '';
        return (
          <React.Fragment key={s.key}>
            {i > 0 && <span className="sep">›</span>}
            <span className={`step ${cls}`}>{s.label}</span>
          </React.Fragment>
        );
      })}
    </div>
  );
}
