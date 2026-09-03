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

/**
 * The approval pipeline: raised → Admin / Director → approved → paid or
 * settled. One approval stage, matching the three-role model.
 */
export function ApprovalSteps({ status, finalLabel = 'Paid' }) {
  const order = ['raised', 'pending_approval', 'approved', 'final'];
  const at = {
    pending_approval: 1, approved: 2, paid: 3, settled: 3, rejected: -1,
  }[status] ?? 0;

  const steps = [
    { key: 'raised', label: 'Raised' },
    { key: 'pending_approval', label: 'Admin / Director' },
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
