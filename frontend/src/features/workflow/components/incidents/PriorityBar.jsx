"use client";

// Priority distribution bar — a slim horizontal stacked bar showing the
// critical/high/medium/low mix of OPEN incidents. Fed from the /stats endpoint's
// by_priority via priorityMix(). Segments run most-severe → least-severe, left to
// right. Each segment carries a tooltip + a legend chip below.

import { sev, priorityMix } from "./lib";

export default function PriorityBar({ byPriority }) {
  const { total, segments } = priorityMix(byPriority || {});

  return (
    <div className="mb-4 rounded-xl border border-card-border bg-card px-4 py-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted">
          Priority distribution
        </span>
        <span className="text-[11px] text-muted">{total} open</span>
      </div>

      <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-hover">
        {total === 0 ? (
          <div className="h-full w-full bg-hover" />
        ) : (
          segments.map((s) =>
            s.count > 0 ? (
              <div
                key={s.priority}
                className={`h-full ${sev(s.priority).band} transition-all`}
                style={{ width: `${s.pct}%` }}
                title={`${sev(s.priority).label}: ${s.count} (${s.pct.toFixed(0)}%)`}
              />
            ) : null,
          )
        )}
      </div>

      <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1.5">
        {segments.map((s) => (
          <span key={s.priority} className="inline-flex items-center gap-1.5 text-[11px] text-muted">
            <span className={`h-2 w-2 rounded-sm ${sev(s.priority).dot}`} />
            <span className="text-foreground">{sev(s.priority).label}</span>
            <span className="tabular-nums">{s.count}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
