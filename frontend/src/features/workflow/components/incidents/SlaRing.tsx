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
  const raised = incident.created_at ? new Date(incident.created_at).getTime() : Number.NaN;
  if (!Number.isFinite(raised)) return null;
  const span = sla.deadline - raised;
  if (span <= 0) return null;
  const left = (sla.deadline - now) / span;
  return Math.max(0, Math.min(1, left));
}

/** The duration is drawn inside the ring's hole, so a longer string has to be
 *  set smaller or it runs through the stroke. */
function ringFontSize(length: number): number {
  if (length > 7) return 16;
  return length > 5 ? 19 : 22;
}

/** The ring's colour. `done` and `none` share the grey: a stopped clock and an
 *  absent one are both "nothing to read here", and neither is a green pass. */
const RING_STROKE: Record<string, string> = {
  breach: "#f87171",
  warn: "#fbbf24",
  ok: "#34d399",
  done: "#7f93bd",
  none: "#7f93bd",
};

/** The words under the ring, which are the only thing that says what the big
 *  number MEANS. Four different nothings have to stay apart: no alarm picked, an
 *  alarm with no time limit at all, one already past its deadline, and one whose
 *  clock stopped when it closed. Only the last arm is a countdown. */
export function ringSubtitle(
  incident: InstancePublic | null | undefined,
  sla: { overdue: boolean } | null,
): string {
  if (!incident) return "no alarm selected";
  if (!sla) return "no time limit";
  if (sla.overdue) return "overdue";
  if (isTerminal(incident.status)) return "closed";
  return `of ${incident.sla_hours ?? "—"}h`;
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

export default function SlaRing({ incident, now: injected }: Readonly<SlaRingProps>) {
  const running = !!incident && !isTerminal(incident.status);
  const now = useNow(running, injected);

  const sla = incident ? slaFor(incident, now) : null;
  const frac = incident ? slaFraction(incident, now) : null;

  const stroke = RING_STROKE[sla?.tone ?? "none"] ?? RING_STROKE.none;

  // An overdue alarm shows a FULL ring in the breach colour rather than an empty
  // one: "nothing left" and "no clock at all" must not look the same.
  const dash = sla ? (sla.overdue ? CIRC : CIRC * (frac ?? 0)) : 0;

  // Just the duration inside the ring: "3h 17m left" is wider than the hole and
  // was drawn straight through the stroke. The words live under it.
  const big = sla ? sla.label.replace(/^Overdue /, "").replace(/^SLA /, "").replace(/ left$/, "") : "—";
  const sub = ringSubtitle(incident, sla);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-card-border bg-card p-3">
      <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted">Time left</span>
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <svg
          width="104"
          height="104"
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
            fontSize={ringFontSize(big.length)}
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
        <p className="mt-1 text-center text-[11px] text-muted">
          due {new Date(sla.deadline).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </p>
      )}
    </div>
  );
}
