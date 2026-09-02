"use client";

// Scatter of the ALIGNED buckets behind one coefficient.
//
// The points it draws are the exact (a, b) pairs the server used — they come
// back on the same `/bi/correlation` response as the coefficient, from the same
// join on the same bucket column. The picture and the number therefore cannot
// disagree, which is the only reason a chart is allowed beside a statistic here.
//
// WHAT IT DELIBERATELY DOES NOT DRAW:
//   • No trend line. A fitted line is a model, and drawing one turns "these
//     moved together" into "this predicts that" without earning it.
//   • No units on either axis. There are none on the wire; the axis carries the
//     numbers as measured and the caption names the tags they came from.
//   • Nothing when the coefficient is undefined — a frozen series plots as a
//     vertical or horizontal stripe, which LOOKS like a finding and is not one.
//     The caller renders the reason instead.
import { useMemo } from "react";

const W = 460;
const H = 300;
const PAD_L = 52;
const PAD_R = 12;
const PAD_T = 12;
const PAD_B = 34;

export interface ScatterSample {
  t: string;
  a: number;
  b: number;
}

const fmt = (v: number) =>
  Math.abs(v) >= 1000
    ? v.toLocaleString(undefined, { maximumFractionDigits: 0 })
    : String(Number(v.toFixed(2)));

function bounds(vals: number[]): [number, number] {
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 1];
  if (hi === lo) return [lo - 1, hi + 1];
  const pad = (hi - lo) * 0.06;
  return [lo - pad, hi + pad];
}

export default function Scatter({
  samples = [],
  xLabel,
  yLabel,
  accent = "#a78bfa",
}: {
  samples: ScatterSample[];
  xLabel?: string;
  yLabel?: string;
  accent?: string;
}) {
  const geom = useMemo(() => {
    if (!samples.length) return null;
    const [xlo, xhi] = bounds(samples.map((s) => s.a));
    const [ylo, yhi] = bounds(samples.map((s) => s.b));
    const px = (v: number) => PAD_L + ((v - xlo) / (xhi - xlo)) * (W - PAD_L - PAD_R);
    const py = (v: number) => H - PAD_B - ((v - ylo) / (yhi - ylo)) * (H - PAD_T - PAD_B);
    return { xlo, xhi, ylo, yhi, px, py };
  }, [samples]);

  if (!geom) {
    return (
      <div className="flex h-[220px] items-center justify-center text-[11.5px] text-nb-faint">
        No aligned buckets to plot
      </div>
    );
  }

  const { xlo, xhi, ylo, yhi, px, py } = geom;
  // Oldest bucket faintest, newest brightest — the only extra information the
  // scatter carries, and it is measured (the bucket's own position in time).
  const n = samples.length;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Scatter of aligned buckets">
      {/* frame */}
      <line x1={PAD_L} y1={PAD_T} x2={PAD_L} y2={H - PAD_B} stroke="rgba(148,163,184,.25)" />
      <line x1={PAD_L} y1={H - PAD_B} x2={W - PAD_R} y2={H - PAD_B} stroke="rgba(148,163,184,.25)" />

      {/* axis extremes only — a full tick ladder on a 460px scatter is noise */}
      <text x={PAD_L} y={H - PAD_B + 14} fontSize="9" fill="rgba(148,163,184,.75)">
        {fmt(xlo)}
      </text>
      <text x={W - PAD_R} y={H - PAD_B + 14} fontSize="9" textAnchor="end" fill="rgba(148,163,184,.75)">
        {fmt(xhi)}
      </text>
      <text x={PAD_L - 6} y={H - PAD_B} fontSize="9" textAnchor="end" fill="rgba(148,163,184,.75)">
        {fmt(ylo)}
      </text>
      <text x={PAD_L - 6} y={PAD_T + 8} fontSize="9" textAnchor="end" fill="rgba(148,163,184,.75)">
        {fmt(yhi)}
      </text>

      {samples.map((s, i) => (
        <circle
          key={`${s.t}-${i}`}
          cx={px(s.a)}
          cy={py(s.b)}
          r={2.6}
          fill={accent}
          fillOpacity={0.25 + 0.65 * (n > 1 ? i / (n - 1) : 1)}
        >
          <title>
            {new Date(s.t).toLocaleString()} · {fmt(s.a)} / {fmt(s.b)}
          </title>
        </circle>
      ))}

      {xLabel && (
        <text x={(W + PAD_L) / 2} y={H - 4} fontSize="9.5" textAnchor="middle" fill="rgba(148,163,184,.9)">
          {xLabel}
        </text>
      )}
      {yLabel && (
        <text
          x={12}
          y={(H - PAD_B + PAD_T) / 2}
          fontSize="9.5"
          textAnchor="middle"
          fill="rgba(148,163,184,.9)"
          transform={`rotate(-90 12 ${(H - PAD_B + PAD_T) / 2})`}
        >
          {yLabel}
        </text>
      )}
    </svg>
  );
}
