"use client";

// THE CLOCK, AS A SHAPE BEFORE IT IS A NUMBER.
//
// An operator reading "22m" has to know the procedure's limit to know whether 22
// minutes is comfortable or nearly gone. The ring carries that for free: it is
// how much of the allowance is LEFT, so a thin arc is late whatever the limit was.
//
// It ticks, because a deadline that only moves when the page refetches is a
// deadline an operator stops trusting. And it says the three states apart —
// running, overdue, and no limit at all — rather than showing an empty ring for
// the last of those, which reads as "out of time".
import { useEffect, useState } from "react";

import type { InstancePublic } from "../../types";
import { isTerminal, slaFor } from "./lib";

const R = 46;
const CIRC = 2 * Math.PI * R;

export interface SlaRingProps {
  incident: InstancePublic | null;
  /** Injectable for tests; defaults to a ticking clock. */
  now?: number;
}

/** How much of the allowance remains, 0…1. Needs the START of the clock, which is
 *  when the alarm was raised — the deadline alone cannot say what fraction is
 *  left. Returns null when there is no allowance to divide by. */
export function slaFraction(incident: InstancePublic, now: number): number | null {
  const sla = slaFor(incident, now);
  if (!sla) return null;
  const raised = incident.created_at ? new Date(incident.created_at).getTime() : NaN;
  if (!Number.isFinite(raised)) return null;
  const span = sla.deadline - raised;
  if (span <= 0) return null;
  const left = (sla.deadline - now) / span;
  return Math.max(0, Math.min(1, left));
}

function useNow(enabled: boolean, injected?: number): number {
  const [now, setNow] = useState(() => injected ?? Date.now());
  useEffect(() => {
    if (injected !== undefined || !enabled) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [enabled, injected]);
  return injected ?? now;
}

export default function SlaRing({ incident, now: injected }: SlaRingProps) {
  const running = !!incident && !isTerminal(incident.status);
  const now = useNow(running, injected);

  const sla = incident ? slaFor(incident, now) : null;
  const frac = incident ? slaFraction(incident, now) : null;

  const tone = sla?.tone ?? "none";
  const stroke =
    tone === "breach" ? "#f87171" : tone === "warn" ? "#fbbf24" : tone === "ok" ? "#34d399" : "#7f93bd";

  // An overdue alarm shows a FULL ring in the breach colour rather than an empty
  // one: "nothing left" and "no clock at all" must not look the same.
  const dash = sla ? (sla.overdue ? CIRC : CIRC * (frac ?? 0)) : 0;

  const big = sla ? sla.label.replace(/^Overdue /, "").replace(/^SLA /, "") : "—";
  const sub = !incident
    ? "no alarm selected"
    : !sla
      ? "no time limit"
      : sla.overdue
        ? "overdue"
        : isTerminal(incident.status)
          ? "closed"
          : `of ${incident.sla_hours ?? "—"}h`;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-card-border bg-card p-3">
      <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted">Time left</span>
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <svg
          width="118"
          height="118"
          viewBox="0 0 112 112"
          role="img"
          aria-label={sla ? `${big} ${sub}` : "No time limit on this alarm"}
        >
          <circle cx="56" cy="56" r={R} fill="none" stroke="var(--nb-ring-track, rgba(150,180,245,.18))" strokeWidth="9" />
          {sla && (
            <circle
              cx="56"
              cy="56"
              r={R}
              fill="none"
              stroke={stroke}
              strokeWidth="9"
              strokeLinecap="round"
              strokeDasharray={`${dash} ${CIRC}`}
              transform="rotate(-90 56 56)"
            />
          )}
          <text
            x="56"
            y="53"
            textAnchor="middle"
            fill="currentColor"
            className="fill-foreground"
            fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
            fontSize={big.length > 6 ? 17 : 22}
            fontWeight="600"
          >
            {big}
          </text>
          <text
            x="56"
            y="71"
            textAnchor="middle"
            className="fill-muted"
            fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
            fontSize="10"
          >
            {sub}
          </text>
        </svg>
      </div>
      {sla && (
        <p className="text-center text-[11px] text-muted">
          due {new Date(sla.deadline).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </p>
      )}
    </div>
  );
}
