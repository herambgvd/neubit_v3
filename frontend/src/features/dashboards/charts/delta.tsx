"use client";

// The period-over-period CHANGE badge.
//
// One component, so every chart that shows a change says it the same way and —
// more importantly — is silent in the same cases. Contract §4 is the whole
// design here: a delta is a claim about two measurements, and there are three
// situations in which no such claim can be made.
//
//   value === null   there is nothing to compare with. The earlier period had no
//                    row for this group, or the previous value was exactly zero
//                    and the change is undefined. Rendering "−100%" or "+∞%"
//                    would both be inventions, so NOTHING is rendered — an
//                    absent badge, not a badge reading "—", because a dash still
//                    occupies the slot where a number would go and reads as
//                    "we measured, and it was nothing".
//   noData           the earlier window returned nothing AT ALL. That IS worth
//                    saying, in words, because a viewer who asked for "vs last
//                    week" and sees no badge cannot tell whether the comparison
//                    ran.
//
// The colour is deliberately NOT semantic. Up is not good and down is not bad —
// a rise in samples is neither, a rise in faults is bad, a rise in generation is
// good — and nothing on this wire says which way round any measure runs. So the
// arrow carries the direction and the colour carries only that a direction
// exists.
import { Icon } from "@iconify/react";

export function fmtDelta(fraction: number): string {
  const pct = fraction * 100;
  const abs = Math.abs(pct);
  // A change of 4,200% is real on a sparse feed. Printing it as "4200.0%" is
  // noise, so large changes lose their decimal.
  const digits = abs >= 100 ? 0 : abs >= 10 ? 0 : 1;
  return `${pct >= 0 ? "+" : "−"}${abs.toFixed(digits)}%`;
}

export default function DeltaBadge({
  value,
  label,
  noData,
  className = "",
}: {
  value: number | null | undefined;
  label?: string;
  noData?: boolean;
  className?: string;
}) {
  if (noData) {
    return (
      <span className={`text-[10.5px] text-nb-faint ${className}`}>
        no data {label ? `for ${label}` : "in the earlier period"}
      </span>
    );
  }
  if (value === null || value === undefined || !Number.isFinite(value)) return null;

  const up = value >= 0;
  return (
    <span
      className={`inline-flex items-center gap-1 text-[11px] text-nb-soft ${className}`}
      title={label ? `versus ${label}` : undefined}
    >
      <Icon
        icon={up ? "heroicons:arrow-trending-up" : "heroicons:arrow-trending-down"}
        className="text-[13px] text-nb-faint"
      />
      <span className="font-mono">{fmtDelta(value)}</span>
      {label ? <span className="text-nb-faint">vs {label}</span> : null}
    </span>
  );
}
