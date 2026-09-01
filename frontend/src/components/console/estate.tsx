"use client";

// Estate skeleton primitives — the COMMON LAYER every Building Intelligence
// surface composes from, so BI reads as one product rather than a different
// design per page.
//
// The SHAPE is the neubit-vms-bi mockup's `#portfolio` section: a 5-slot KPI
// strip on top, a two-column main (leaderboard left; charts + actions right),
// leaderboard rows with a score slot / name / meta line / chips / trend / OPEN.
// The TOKENS are ours (`nb-*`, tailwind.config.js) — the mockup's violet estate
// palette is not imported, and neither are its invented figures.
//
// HONESTY IS PART OF THE COMPONENT CONTRACT here, not just of the data: every
// slot accepts null/undefined as a value and renders an em dash with the REASON
// (`sub` / `title`) beside it. A slot whose input does not exist must say why it
// is empty — these primitives make that the path of least resistance, because a
// `<Kpi value={null} sub="no kWh register confirmed" />` is less code than
// faking one. Nothing here defaults a number.
import Link from "next/link";
import { Icon } from "@iconify/react";

const TONES: Record<string, string> = {
  ink: "text-nb-ink",
  good: "text-nb-good",
  warn: "text-nb-warn",
  crit: "text-nb-crit",
  blue: "text-nb-blueb",
  faint: "text-nb-faint",
};

const tone = (t?: string) => TONES[t || "ink"] || TONES.ink;

// ── KPI strip ────────────────────────────────────────────────────────────────

/** The 5-slot strip across the top of an estate page (mockup `.pkpis`).
 *  It does not enforce exactly five children, but five is the rhythm. */
export function KpiStrip({ className = "", children }: any) {
  return (
    <div className={`grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5 ${className}`}>
      {children}
    </div>
  );
}

/** One KPI slot: icon + uppercase label, big mono value, one line of subtext.
 *  `value == null` renders "—" faint — the ABSENT state, with `sub` carrying
 *  the reason. `title` puts the same reason on hover. */
export function Kpi({ icon, label, value, sub, tone: t = "ink", title }: any) {
  const absent = value === null || value === undefined;
  return (
    <div
      className="rounded-[10px] border border-nb-line bg-[rgba(10,18,40,.5)] px-3 py-2.5"
      title={title}
    >
      <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[1.4px] text-nb-faint">
        {icon && <Icon icon={icon} className="text-[13px]" />}
        {label}
      </p>
      <p className={`mt-1 font-mono text-[19px] leading-none ${absent ? "text-nb-faint" : tone(t)}`}>
        {absent ? "—" : value}
      </p>
      {sub && <p className="mt-1 truncate text-[11px] text-nb-faint" title={title ?? sub}>{sub}</p>}
    </div>
  );
}

// ── Two-column main ──────────────────────────────────────────────────────────

/** The estate page's main split (mockup `.pmain`): leaderboard-weight left
 *  column, charts-and-actions right column. Stacks on small screens. */
export function EstateMain({ left, right, className = "" }: any) {
  return (
    <div className={`grid grid-cols-1 items-start gap-3 xl:grid-cols-[1.52fr_1fr] ${className}`}>
      <div className="min-w-0 space-y-3">{left}</div>
      <div className="min-w-0 space-y-3">{right}</div>
    </div>
  );
}

// ── Leaderboard ──────────────────────────────────────────────────────────────

export function Leaderboard({ className = "", children }: any) {
  return <div className={`flex flex-col gap-2 ${className}`}>{children}</div>;
}

/** One chip on a leaderboard row's meta strip. `value == null` renders "—";
 *  `title` states why (shown on hover). */
export function LeaderChip({ label, value, tone: t = "faint", title }: any) {
  const absent = value === null || value === undefined;
  const border =
    t === "crit"
      ? "border-nb-crit/50 text-nb-crit"
      : t === "warn"
        ? "border-nb-warn/45 text-nb-warn"
        : t === "good"
          ? "border-[rgba(52,211,153,.45)] text-nb-good"
          : "border-nb-line text-nb-soft";
  return (
    <span
      className={`whitespace-nowrap rounded-[6px] border px-2 py-0.5 font-mono text-[10.5px] ${border}`}
      title={title}
    >
      {label}
      <span className={`ml-1 ${absent ? "text-nb-faint" : ""}`}>{absent ? "—" : value}</span>
    </span>
  );
}

/** One leaderboard row (mockup `.lb`): score slot / title + meta line + chips /
 *  trend + OPEN.
 *
 *  `score == null` renders the honest slot: an em dash with `scoreSub` as the
 *  stated reason under it — never a placeholder number. `trend == null` renders
 *  "—" with `trendTitle` as the hover reason. `href` makes the whole row a link
 *  and shows the OPEN › affordance; without it the row is inert. */
export function LeaderRow({
  icon = "heroicons:building-office-2",
  score,
  scoreSub,
  title,
  meta,
  metaTitle,
  chips,
  trend,
  trendTone = "faint",
  trendTitle,
  href,
  openLabel = "OPEN ›",
  muted = false,
}: any) {
  const body = (
    <>
      {/* score slot — fixed width so rows align whether or not a score exists */}
      <div className="flex w-[120px] flex-none items-center gap-2.5">
        <Icon icon={icon} className={`text-[17px] ${muted ? "text-nb-faint" : "text-nb-soft"}`} />
        <div className="min-w-0">
          <div
            className={`font-mono text-[24px] font-bold leading-none ${
              score === null || score === undefined ? "text-nb-faint" : "text-nb-ink"
            }`}
            title={score === null || score === undefined ? scoreSub : undefined}
          >
            {score ?? "—"}
          </div>
          {scoreSub && (
            <div className="mt-1 text-[9.5px] leading-tight text-nb-faint" title={scoreSub}>
              {scoreSub}
            </div>
          )}
        </div>
      </div>

      {/* title + meta + chips */}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className={`text-[13.5px] font-semibold ${muted ? "italic text-nb-faint" : "text-nb-ink"}`}>
            {title}
          </span>
          {meta && (
            <span className="truncate text-[11px] text-nb-faint" title={metaTitle ?? meta}>
              {meta}
            </span>
          )}
        </div>
        {chips && <div className="mt-1.5 flex flex-wrap gap-1.5">{chips}</div>}
      </div>

      {/* trend + OPEN */}
      <div className="flex flex-none items-center gap-2.5">
        <span
          className={`font-mono text-[11px] ${tone(trend === null || trend === undefined ? "faint" : trendTone)}`}
          title={trendTitle}
        >
          {trend ?? "—"}
        </span>
        {href && (
          <span className="rounded-[7px] border border-[rgba(96,165,250,.4)] px-2.5 py-1 text-[10.5px] tracking-[.5px] text-nb-blueb">
            {openLabel}
          </span>
        )}
      </div>
    </>
  );

  const cls =
    "flex items-center gap-3 rounded-[11px] border border-nb-line bg-[rgba(10,18,40,.45)] px-3.5 py-2.5";
  return href ? (
    <Link href={href} className={`${cls} transition hover:border-nb-blue/60 hover:bg-white/[.03]`}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

// ── Action list ──────────────────────────────────────────────────────────────

export function ActionList({ className = "", children }: any) {
  return <div className={`space-y-1.5 ${className}`}>{children}</div>;
}

/** One ranked action row (mockup `.act`): icon, title, sub, right-side value,
 *  open affordance. `value == null` renders "—" with `valueTitle` as reason. */
export function ActionRow({
  icon = "heroicons:exclamation-triangle",
  iconTone = "warn",
  title,
  sub,
  value,
  valueTone = "warn",
  valueTitle,
  href,
  onOpen,
  openLabel = "Open →",
}: any) {
  const iconCls =
    iconTone === "crit"
      ? "border-nb-crit/40 bg-nb-crit/10 text-nb-crit"
      : iconTone === "good"
        ? "border-[rgba(52,211,153,.4)] bg-[rgba(52,211,153,.1)] text-nb-good"
        : "border-nb-warn/40 bg-nb-warn/10 text-nb-warn";
  const open = href ? (
    <Link
      href={href}
      className="mt-1 inline-block rounded-[6px] border border-nb-line px-2 py-0.5 text-[10px] text-nb-muted transition hover:border-nb-blue hover:text-nb-blueb"
    >
      {openLabel}
    </Link>
  ) : onOpen ? (
    <button
      type="button"
      onClick={onOpen}
      className="mt-1 rounded-[6px] border border-nb-line px-2 py-0.5 text-[10px] text-nb-muted transition hover:border-nb-blue hover:text-nb-blueb"
    >
      {openLabel}
    </button>
  ) : null;
  return (
    <div className="flex items-center gap-3 rounded-[10px] border border-nb-line bg-[rgba(10,18,40,.45)] px-3 py-2">
      <span className={`grid h-7 w-7 flex-none place-items-center rounded-[7px] border ${iconCls}`}>
        <Icon icon={icon} className="text-[14px]" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12.5px] font-semibold text-nb-ink">{title}</div>
        {sub && <div className="mt-0.5 truncate text-[10.5px] text-nb-faint">{sub}</div>}
      </div>
      <div className="flex-none text-right">
        <div
          className={`font-mono text-[12.5px] font-bold ${
            value === null || value === undefined ? "text-nb-faint" : tone(valueTone)
          }`}
          title={valueTitle}
        >
          {value ?? "—"}
        </div>
        {open}
      </div>
    </div>
  );
}

// ── Page header ──────────────────────────────────────────────────────────────

/** The estate page header: breadcrumb-capable title + description, with a
 *  right-hand slot for freshness / spinners. `crumbs` is an ordered list of
 *  `{label, href?}` — the last one is the current page and renders plain. */
export function EstateHeader({ crumbs = [], desc, right, className = "" }: any) {
  return (
    <div className={`mb-3 flex flex-wrap items-end justify-between gap-3 ${className}`}>
      <div className="min-w-0">
        <h1 className="flex items-center gap-1.5 text-[17px] font-semibold text-nb-ink">
          {crumbs.map((c: any, i: number) => (
            <span key={`${c.label}-${i}`} className="flex items-center gap-1.5">
              {i > 0 && <span className="text-nb-faint">/</span>}
              {c.href ? (
                <Link href={c.href} className="text-nb-blueb transition hover:underline">
                  {c.label}
                </Link>
              ) : (
                <span>{c.label}</span>
              )}
            </span>
          ))}
        </h1>
        {desc && <p className="mt-0.5 max-w-3xl text-[11.5px] text-nb-faint">{desc}</p>}
      </div>
      {right && <div className="flex items-center gap-2 text-[11px] text-nb-faint">{right}</div>}
    </div>
  );
}
