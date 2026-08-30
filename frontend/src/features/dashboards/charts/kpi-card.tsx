"use client";

// KPI / stat tile — one headline number.
//
// PORTED from `frontend-next/src/components/charts/kpi-card.tsx`. Kept: the whole
// idea and layout — a small uppercase label over a large tabular-numeral value,
// centred, no chart library involved. That is the right shape for this widget and
// it needs no ECharts.
//
// Changed:
// * **Theme**: navy tokens, and the console's `font-mono` for the number rather
//   than `tabular-nums` on the body face.
// * **Which cell it reads.** Theirs takes `rows[0][0]` — the first cell of the
//   first row — because a free-SQL KPI query is written to return exactly one
//   number. Our aggregate row starts with the point NAME, so it reads the first
//   NUMERIC column instead and uses column 0 as the label. Same intent, correct
//   for this data.
// * **The delta is gone.** Theirs derives a percentage change from `rows[1][0]`,
//   i.e. it treats the second row of the result as "the previous period". That is
//   only true if the query was written to return the two periods in that order.
//   Our second row is simply the second POINT, so a delta computed from it would
//   be a comparison between two different sensors presented as a trend. Deleted
//   rather than adapted: a "▲ 12%" that means nothing is worse than no delta.
// * **The sample count is added.** An average over three samples and an average
//   over three hundred look identical without it, and on a feed whose devices
//   report at different rates that difference is the thing most worth knowing.
// * A null value prints an em dash, never a zero.

import { fmtValue } from "../spec";
import type { ChartProps } from "./types";
import { numericColumns } from "./types";

export default function KpiCard({ data, options }: ChartProps) {
  const rows = data?.rows || [];
  const row = rows[0];

  if (!row) {
    return (
      <div className="flex h-full items-center justify-center px-3 text-center text-[11.5px] text-nb-faint">
        Nothing matched this scope.
      </div>
    );
  }

  const valueIdx = numericColumns(data)[0];
  const raw = valueIdx === undefined ? null : row[valueIdx];
  const value = typeof raw === "number" ? raw : null;

  const label = String(row[data.labelIndex] ?? data.columns[data.labelIndex] ?? "Value");
  // Column 1 is the device a point hangs off (see `adapt.ts`).
  const sublabel = typeof row[1] === "string" ? (row[1] as string) : null;
  // The last column is the sample count.
  const samples = typeof row[row.length - 1] === "number" ? (row[row.length - 1] as number) : 0;

  return (
    <div className="flex h-full flex-col items-start justify-center gap-1 px-4">
      <div
        className="font-mono text-[clamp(1.5rem,3.2vw,2.4rem)] leading-none text-nb-ink"
        title={value === null ? "no reading in this window" : String(value)}
      >
        {fmtValue(value, options?.decimals)}
      </div>
      <div className="min-w-0 max-w-full truncate text-[11.5px] text-nb-soft" title={label}>
        {label}
      </div>
      {sublabel ? (
        <div className="min-w-0 max-w-full truncate text-[10.5px] text-nb-faint" title={sublabel}>
          {sublabel}
        </div>
      ) : null}
      <div className="text-[10px] text-nb-faint">
        {samples.toLocaleString()} sample{samples === 1 ? "" : "s"}
      </div>
    </div>
  );
}
