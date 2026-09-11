"use client";

import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from "react";

import { cn } from "@/lib/cn";
import { Card } from "@/components/ui/card";

/* Theme-aware chart primitives, dependency-free SVG. Colors come from the design
   tokens (var(--accent), var(--success)…) so they flip with light/dark. Single-hue
   accent = magnitude; status tokens = state (always paired with a text label). */

/** One slice/bar/point. `color` is a CSS color — pass a token, e.g. var(--success). */
export interface ChartDatum {
  label: string;
  value: number;
  color?: string;
}

/** Formats a value for display. Returns a node so a caller may return markup. */
export type ValueFormatter = (n: number) => ReactNode;

// Measure the live pixel width of a container (for crisp, correctly-scaled SVG).
function useContainerWidth(): [RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    if (!ref.current) return;
    const el = ref.current;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setWidth(e.contentRect.width);
    });
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

export function ChartCard({
  title,
  subtitle,
  action,
  children,
  className,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <Card className={cn("flex flex-col p-5", className)}>
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold tracking-tight text-foreground">{title}</h3>
          {subtitle && <p className="mt-0.5 text-xs text-muted">{subtitle}</p>}
        </div>
        {action}
      </div>
      <div className="flex-1">{children}</div>
    </Card>
  );
}

export function ChartEmpty({ label = "No data yet" }: { label?: ReactNode }) {
  return (
    <div className="flex h-full min-h-[160px] items-center justify-center text-sm text-muted">{label}</div>
  );
}

/* --------------------------------- Donut ---------------------------------- */
// data: [{ label, value, color }]. color is a CSS color (use var(--success) etc).
export function DonutChart({
  data = [],
  centerLabel = "Total",
  formatValue = (n) => n,
}: {
  data?: ChartDatum[];
  centerLabel?: ReactNode;
  formatValue?: ValueFormatter;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const total = data.reduce((s, d) => s + (d.value || 0), 0);
  if (!total) return <ChartEmpty />;

  const size = 168;
  const stroke = 20;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  // Arc length + where it starts, computed up front. Accumulating a `let` while
  // mapping mutates state after the render has begun, which React Compiler
  // (rightly) refuses to memoize.
  const arcs = data.reduce<{ len: number; offset: number }[]>((acc, d) => {
    const len = ((d.value || 0) / total) * c;
    const prev = acc[acc.length - 1];
    acc.push({ len, offset: prev ? prev.offset + prev.len : 0 });
    return acc;
  }, []);

  return (
    <div className="flex flex-wrap items-center justify-center gap-6">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0 -rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--hover)" strokeWidth={stroke} />
        {data.map((d, i) => {
          const { len, offset } = arcs[i]!;
          return (
            <circle
              key={i}
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              stroke={d.color}
              strokeWidth={stroke}
              strokeDasharray={`${len} ${c - len}`}
              strokeDashoffset={-offset}
              strokeLinecap="butt"
              className="transition-opacity"
              opacity={hover === null || hover === i ? 1 : 0.35}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
            />
          );
        })}
      </svg>
      <div className="min-w-[120px]">
        <div className="mb-3">
          <div className="text-2xl font-semibold tabular-nums tracking-tight text-foreground">
            {formatValue(hover === null ? total : (data[hover]?.value ?? 0))}
          </div>
          <div className="text-xs text-muted">{hover === null ? centerLabel : data[hover]?.label}</div>
        </div>
        <ul className="space-y-1.5">
          {data.map((d, i) => (
            <li
              key={i}
              className="flex items-center gap-2 text-xs"
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
            >
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: d.color }} />
              <span className="text-muted">{d.label}</span>
              <span className="ml-auto font-medium tabular-nums text-foreground">{formatValue(d.value)}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/* -------------------------------- Bar list -------------------------------- */
// data: [{ label, value, sub }]. Single-hue horizontal bars (magnitude).
export function BarList({
  data = [],
  color = "var(--accent)",
  formatValue = (n) => n,
  emptyLabel,
}: {
  data?: ChartDatum[];
  color?: string;
  formatValue?: ValueFormatter;
  emptyLabel?: ReactNode;
}) {
  if (!data.length) return <ChartEmpty label={emptyLabel} />;
  const max = Math.max(...data.map((d) => d.value || 0), 1);
  return (
    <ul className="space-y-2.5">
      {data.map((d, i) => (
        <li key={i} className="group">
          <div className="mb-1 flex items-center justify-between gap-3 text-xs">
            <span className="truncate text-foreground">{d.label}</span>
            <span className="shrink-0 font-medium tabular-nums text-muted">{formatValue(d.value)}</span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-hover">
            <div
              className="h-full rounded-full transition-all"
              style={{ width: `${((d.value || 0) / max) * 100}%`, background: color }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

/* ------------------------------- Sparkline -------------------------------- */
// Compact inline trend line for a rolling series (e.g. per-container CPU/mem).
export function Sparkline({
  data = [],
  color = "var(--accent)",
  width = 84,
  height = 26,
}: {
  /** A plain numeric series — one point per sample, oldest first. */
  data?: number[];
  color?: string;
  width?: number;
  height?: number;
}) {
  if (data.length < 2) {
    return <div style={{ width, height }} className="rounded bg-hover/60" aria-hidden />;
  }
  const max = Math.max(...data, 1);
  const step = width / (data.length - 1);
  const yAt = (v: number) => height - 1 - (Math.max(0, v) / max) * (height - 2);
  const pts = data.map((v, i) => `${i * step},${yAt(v)}`);
  const line = `M ${pts.join(" L ")}`;
  const area = `${line} L ${width},${height} L 0,${height} Z`;
  const gid = `spark-${color.replace(/[^a-z]/gi, "")}-${data.length}`;
  return (
    <svg width={width} height={height} className="block">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.18" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gid})`} />
      <path d={line} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/* ------------------------------- Area trend ------------------------------- */
// data: [{ label, value }]. Single-series area with hover crosshair + tooltip.
export function AreaTrend({
  data = [],
  color = "var(--accent)",
  formatValue = (n) => n,
  height = 200,
}: {
  data?: ChartDatum[];
  color?: string;
  formatValue?: ValueFormatter;
  height?: number;
}) {
  const [wrapRef, width] = useContainerWidth();
  const [hover, setHover] = useState<number | null>(null);
  // A per-instance id for the <linearGradient>. useId is stable across renders
  // and unique per component instance, so two charts on a page cannot collide.
  const gradId = `grad-${useId().replaceAll(/:/g, "")}`;

  if (!data.length) return <div ref={wrapRef}><ChartEmpty /></div>;

  const padX = 8;
  const padTop = 12;
  const padBottom = 22;
  const w = Math.max(width, 1);
  const innerW = Math.max(w - padX * 2, 1);
  const innerH = height - padTop - padBottom;
  const max = Math.max(...data.map((d) => d.value || 0), 1);
  const stepX = data.length > 1 ? innerW / (data.length - 1) : 0;
  const xAt = (i: number) => padX + i * stepX;
  const yAt = (v: number) => padTop + innerH - (v / max) * innerH;

  const linePts = data.map((d, i) => `${xAt(i)},${yAt(d.value || 0)}`);
  const linePath = `M ${linePts.join(" L ")}`;
  const areaPath = `${linePath} L ${xAt(data.length - 1)},${padTop + innerH} L ${xAt(0)},${padTop + innerH} Z`;

  function onMove(e: MouseEvent<SVGRectElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const i = Math.max(0, Math.min(data.length - 1, Math.round((x - padX) / (stepX || 1))));
    setHover(i);
  }

  // Show a subset of x-axis labels to avoid crowding.
  const labelEvery = Math.ceil(data.length / 6);

  return (
    <div ref={wrapRef} className="relative">
      {width > 0 && (
        <svg width={w} height={height} className="block">
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.22" />
              <stop offset="100%" stopColor={color} stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={areaPath} fill={`url(#${gradId})`} />
          <path d={linePath} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          {hover !== null && (
            <g>
              <line x1={xAt(hover)} y1={padTop} x2={xAt(hover)} y2={padTop + innerH} stroke="var(--card-border)" strokeWidth={1} />
              <circle cx={xAt(hover)} cy={yAt(data[hover]?.value || 0)} r={4} fill="var(--background)" stroke={color} strokeWidth={2} />
            </g>
          )}
          {data.map((d, i) =>
            i % labelEvery === 0 || i === data.length - 1 ? (
              <text key={i} x={xAt(i)} y={height - 6} textAnchor="middle" className="fill-[var(--muted)] text-[10px]">
                {d.label}
              </text>
            ) : null
          )}
          <rect x="0" y="0" width={w} height={height} fill="transparent" onMouseMove={onMove} onMouseLeave={() => setHover(null)} />
        </svg>
      )}
      {hover !== null && (
        <div
          className="pointer-events-none absolute -translate-x-1/2 rounded-lg border border-card-border bg-card px-2.5 py-1.5 text-xs shadow-lg shadow-black/20"
          style={{ left: Math.min(Math.max(xAt(hover), 48), w - 48), top: 0 }}
        >
          <div className="font-medium text-foreground">{formatValue(data[hover]?.value ?? 0)}</div>
          <div className="text-muted">{data[hover]?.label}</div>
        </div>
      )}
    </div>
  );
}
