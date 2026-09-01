"use client";

// The correlation matrix.
//
// One cell per unordered pair, and the cell's whole job is to be honest about
// four different states that a naive matrix renders identically as a number:
//
//   ok                 a coefficient, with n underneath it. n is not a footnote:
//                      +0.98 over 4 buckets and +0.98 over 400 are different
//                      claims, and the reader has to be able to tell without
//                      hovering anything.
//   undefined_frozen   one side never moved. Pearson divides by a standard
//                      deviation, so r has NO VALUE — the cell says UNDEF, not
//                      0.00, and never gets a colour.
//   no_overlap         the two series never filled the same bucket. Absence.
//   too_few            fewer overlapping buckets than the server's floor.
//
// The colour ramp encodes MAGNITUDE and SIGN of a defined coefficient and
// nothing else. It is deliberately not a heat map of "importance": there is no
// ranking here, and a strong r is not a strong cause.
import { Icon } from "@iconify/react";

export interface CorrPair {
  a: string;
  b: string;
  n: number;
  r: number | null;
  status: string;
  reason: string;
  overlap_start?: string | null;
  overlap_end?: string | null;
}

export interface CorrSeries {
  point_id: string;
  point_tag: string | null;
  device_tag: string | null;
  category: string | null;
  buckets: number;
  distinct_values: number;
  frozen: boolean;
}

export const fmtR = (r: number | null | undefined) =>
  r === null || r === undefined || !Number.isFinite(r)
    ? "—"
    : (r >= 0 ? "+" : "") + r.toFixed(2);

/** Cell background for a DEFINED coefficient. Undefined cells get none. */
function cellTone(r: number | null, status: string): string {
  if (status !== "ok" || r === null) return "bg-[rgba(6,11,26,.55)]";
  const m = Math.min(1, Math.abs(r));
  const alpha = 0.08 + m * 0.32;
  return r >= 0
    ? `rgba(52,211,153,${alpha})`
    : `rgba(248,113,113,${alpha})`;
}

const SHORT: Record<string, string> = {
  no_overlap: "NO OVERLAP",
  undefined_frozen: "UNDEF",
  too_few: "n TOO LOW",
};

export default function CorrelationMatrix({
  series,
  pairs,
  selected,
  onSelect,
}: {
  series: CorrSeries[];
  pairs: CorrPair[];
  selected?: [string, string] | null;
  onSelect?: (a: string, b: string) => void;
}) {
  const key = (a: string, b: string) => [a, b].sort().join("|");
  const byKey = new Map(pairs.map((p) => [key(p.a, p.b), p]));
  const label = (s: CorrSeries) => `${s.device_tag ?? "?"} / ${s.point_tag ?? "?"}`;
  const selKey = selected ? key(selected[0], selected[1]) : null;

  return (
    <div className="overflow-x-auto">
      <table className="border-collapse text-left">
        <thead>
          <tr>
            <th className="sticky left-0 z-[1] bg-[rgba(10,18,40,.92)] px-2 py-2" />
            {series.map((s, i) => (
              <th
                key={s.point_id}
                title={label(s)}
                className="min-w-[74px] px-1 py-2 text-center align-bottom text-[10px] font-semibold text-nb-faint"
              >
                <span className="font-mono">{i + 1}</span>
                {s.frozen && (
                  <Icon
                    icon="heroicons:pause-circle"
                    className="ml-0.5 inline text-[11px] text-nb-warn align-[-1px]"
                  />
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {series.map((row, ri) => (
            <tr key={row.point_id}>
              <th
                scope="row"
                className="sticky left-0 z-[1] max-w-[240px] truncate bg-[rgba(10,18,40,.92)] px-2 py-1.5 text-[11px] font-normal text-nb-soft"
                title={label(row)}
              >
                <span className="mr-1.5 font-mono text-nb-faint">{ri + 1}</span>
                {label(row)}
                {row.frozen && (
                  <span className="ml-1 rounded-[4px] border border-[rgba(251,191,36,.4)] px-1 text-[9px] uppercase tracking-[.6px] text-nb-warn">
                    frozen
                  </span>
                )}
              </th>
              {series.map((col, ci) => {
                if (ri === ci) {
                  return (
                    <td
                      key={col.point_id}
                      className="border border-nb-line/60 bg-[rgba(96,165,250,.06)] px-1 py-1.5 text-center font-mono text-[11px] text-nb-faint"
                    >
                      ·
                    </td>
                  );
                }
                const p = byKey.get(key(row.point_id, col.point_id));
                if (!p) {
                  return (
                    <td
                      key={col.point_id}
                      className="border border-nb-line/60 px-1 py-1.5 text-center text-[10px] text-nb-faint"
                    >
                      —
                    </td>
                  );
                }
                const on = selKey === key(p.a, p.b);
                const defined = p.status === "ok" && p.r !== null;
                const tone = cellTone(p.r, p.status);
                return (
                  <td
                    key={col.point_id}
                    onClick={() => onSelect?.(row.point_id, col.point_id)}
                    title={p.reason}
                    style={defined ? { background: tone } : undefined}
                    className={`cursor-pointer border px-1 py-1.5 text-center transition ${
                      on ? "border-[rgba(167,139,250,.85)]" : "border-nb-line/60 hover:border-nb-blue"
                    } ${defined ? "" : "bg-[rgba(6,11,26,.55)]"}`}
                  >
                    {defined ? (
                      <>
                        <div className="font-mono text-[12px] leading-none text-nb-ink">
                          {fmtR(p.r)}
                        </div>
                        <div className="mt-0.5 font-mono text-[9px] leading-none text-nb-faint">
                          n={p.n}
                        </div>
                      </>
                    ) : (
                      <>
                        <div
                          className={`text-[9px] font-semibold uppercase leading-none tracking-[.4px] ${
                            p.status === "no_overlap" ? "text-nb-faint" : "text-nb-warn"
                          }`}
                        >
                          {SHORT[p.status] ?? p.status}
                        </div>
                        <div className="mt-0.5 font-mono text-[9px] leading-none text-nb-faint">
                          n={p.n}
                        </div>
                      </>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
