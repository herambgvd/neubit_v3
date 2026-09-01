"use client";

// Inline-SVG trend chart for one point's rollup series.
//
// Hand-rolled rather than pulling in a charting library: the console has none
// today, and one 120-line component is a smaller commitment than a new runtime
// dependency for a single line and a band.
//
// It draws what the ROLLUP actually contains and nothing more:
//   • the min→max BAND for each bucket, so a 1-hour average never hides a spike
//   • the avg LINE through the bucket centres
// On `resolution="raw"` the API sets min=max=avg=the sample, so the band
// collapses to the line and the same component renders every resolution.
//
// No unit is drawn on the axis. There is none on the wire (contract §11/§12) and
// inventing one is the failure this feature exists to avoid — the axis shows the
// numbers as measured, and the caption names the point tag they came from.
import { useMemo } from "react";

const W = 600;
const H = 160;
const PAD_L = 44;
const PAD_R = 8;
const PAD_T = 10;
const PAD_B = 20;

export interface Bucket {
  t: string;
  count: number;
  min: number | null;
  max: number | null;
  avg: number | null;
  first: number | null;
  last: number | null;
  txt_last: string | null;
}

function niceTicks(lo: number, hi: number): number[] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [];
  if (hi === lo) return [lo];
  const span = hi - lo;
  const step = Math.pow(10, Math.floor(Math.log10(span / 3)));
  const mult = [1, 2, 2.5, 5, 10].find((m) => span / (step * m) <= 4) ?? 10;
  const s = step * mult;
  const out: number[] = [];
  for (let v = Math.ceil(lo / s) * s; v <= hi + 1e-9; v += s) out.push(Number(v.toFixed(6)));
  return out;
}

const fmtTick = (v: number) =>
  Math.abs(v) >= 1000 ? v.toLocaleString(undefined, { maximumFractionDigits: 0 }) : String(Number(v.toFixed(2)));

export default function TrendChart({
  buckets = [],
  accent = "#67e8f9",
  label,
}: {
  buckets: Bucket[];
  accent?: string;
  label?: string;
}) {
  const model = useMemo(() => {
    const pts = buckets.filter((b) => b.avg !== null && b.avg !== undefined);
    if (pts.length === 0) return null;

    const times = pts.map((b) => new Date(b.t).getTime());
    const t0 = times[0];
    const t1 = times[times.length - 1];
    const lows = pts.map((b) => (b.min ?? b.avg) as number);
    const highs = pts.map((b) => (b.max ?? b.avg) as number);
    let lo = Math.min(...lows);
    let hi = Math.max(...highs);
    if (hi === lo) {
      // A perfectly flat series is REAL and common here (a status point pinned at
      // 1, a meter that has not moved). Give it a band so it renders as a flat
      // line in the middle instead of collapsing onto the axis.
      const pad = Math.abs(hi) > 0 ? Math.abs(hi) * 0.05 : 1;
      lo -= pad;
      hi += pad;
    }

    const x = (ms: number) =>
      t1 === t0 ? (PAD_L + W - PAD_R) / 2 : PAD_L + ((ms - t0) / (t1 - t0)) * (W - PAD_L - PAD_R);
    const y = (v: number) => PAD_T + (1 - (v - lo) / (hi - lo)) * (H - PAD_T - PAD_B);

    const line = pts
      .map((b, i) => `${i === 0 ? "M" : "L"}${x(times[i]).toFixed(2)},${y(b.avg as number).toFixed(2)}`)
      .join(" ");

    const bandTop = pts.map((b, i) => `${x(times[i]).toFixed(2)},${y(highs[i]).toFixed(2)}`);
    const bandBottom = pts
      .map((b, i) => `${x(times[i]).toFixed(2)},${y(lows[i]).toFixed(2)}`)
      .reverse();
    const band = `M${bandTop.join(" L")} L${bandBottom.join(" L")} Z`;

    return {
      line,
      band,
      ticks: niceTicks(lo, hi).map((v) => ({ v, y: y(v) })),
      t0,
      t1,
      last: pts[pts.length - 1],
      x,
      y,
      times,
      pts,
    };
  }, [buckets]);

  if (!model) {
    return (
      <div className="flex h-[160px] items-center justify-center text-[11.5px] text-nb-faint">
        No samples in this window
      </div>
    );
  }

  const timeLabel = (ms: number) =>
    new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

  // The SVG stretches to the container (`preserveAspectRatio="none"`), which is
  // what keeps the plot full-width at any pane size. That would also stretch SVG
  // <text>, so every LABEL is HTML positioned over the plot instead — text stays
  // upright and at the console's own type size, and the geometry stays fluid.
  return (
    <div className="relative h-[160px] w-full" aria-label={label ? `Trend for ${label}` : "Trend"}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-full w-full">
        {model.ticks.map((t) => (
          <line
            key={t.v}
            x1={PAD_L}
            x2={W - PAD_R}
            y1={t.y}
            y2={t.y}
            stroke="rgba(160,150,245,.16)"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        ))}
        <path d={model.band} fill={accent} opacity={0.16} />
        <path
          d={model.line}
          fill="none"
          stroke={accent}
          strokeWidth={1.6}
          vectorEffect="non-scaling-stroke"
          strokeLinejoin="round"
        />
      </svg>

      {model.ticks.map((t) => (
        <span
          key={t.v}
          className="pointer-events-none absolute -translate-y-1/2 font-mono text-[9.5px] text-nb-faint"
          style={{ top: `${(t.y / H) * 100}%`, left: 0, width: `${(PAD_L / W) * 100}%`, textAlign: "right" }}
        >
          {fmtTick(t.v)}
        </span>
      ))}
      <span className="pointer-events-none absolute bottom-0 font-mono text-[9.5px] text-nb-faint" style={{ left: `${(PAD_L / W) * 100}%` }}>
        {timeLabel(model.t0)}
      </span>
      <span className="pointer-events-none absolute bottom-0 right-0 font-mono text-[9.5px] text-nb-faint">
        {timeLabel(model.t1)}
      </span>
    </div>
  );
}
