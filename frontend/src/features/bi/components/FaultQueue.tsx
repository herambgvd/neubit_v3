"use client";

// Building Intelligence → the FAULT QUEUE.
//
// Every row here is an alert the GATEWAY raised — a rule tripping, a poll
// failing, a point going stale — projected onto `neubit_reporting.iot_alerts` by
// the reporting-projector and read back through `/api/v1/bi/alerts`. Nothing on
// this panel is computed by the console: the severity, the type, the device and
// the message are the gateway's own words, including the number that tripped the
// rule.
//
// WHAT THIS PANEL DELIBERATELY DOES NOT SAY, and why each absence is correct:
//
//   • It is not "cross-domain". The alert payload carries the connection, the
//     device tag, the point address and the protocol — and NOTHING about what the
//     device IS. `points.category` (energy / hvac / water) exists only on the
//     READING wire, so an alert cannot be attributed to a domain without
//     inventing the attribution. Until the gateway puts `device_category` on the
//     alert payload the way Phase D put it on the reading payload, this is a
//     queue of faults, not a cross-domain queue.
//
//   • There is no MTTA, no "time to acknowledge", no open/closed split.
//     `alert.acked` is on the wire and is ALWAYS false: an alert is published the
//     instant it is raised, and acknowledging one is a store-only mutation inside
//     the gateway that publishes nothing at all. Every one of those figures would
//     be derived from a field that cannot change.
//
//   • There is no rupee impact and no CCEI driver. Both need to know what a point
//     measures and what it costs; the wire says neither.
import { useEffect, useRef, useState } from "react";
import { Icon } from "@iconify/react";

import { LoadingBlock } from "@/components/console";
import { fmtRelative } from "@/lib/format";

// The gateway's own severity vocabulary (`model.Severity`). A severity that is
// not one of these still renders — using its raw string, in the neutral tone —
// because the gateway is free to add one and a queue that hid the unknown row
// would be hiding a fault.
const SEVERITY: Record<string, { label: string; accent: string; icon: string }> = {
  critical: { label: "Critical", accent: "#f87171", icon: "heroicons:exclamation-triangle" },
  warning: { label: "Warning", accent: "#fbbf24", icon: "heroicons:exclamation-circle" },
  info: { label: "Info", accent: "#93c5fd", icon: "heroicons:information-circle" },
};

function severityMeta(key: string | null | undefined) {
  if (!key) return { label: "Unspecified", accent: "#9a92c8", icon: "heroicons:question-mark-circle" };
  return SEVERITY[key] || { label: key, accent: "#a78bfa", icon: "heroicons:bell-alert" };
}

// conflux's `AlertType` vocabulary, prettified only. `rule` is what the rule
// engine raises; the rest come from the poll/stale watchdogs.
const TYPE_LABELS: Record<string, string> = {
  rule: "Rule",
  comm_fail: "Comms failure",
  range: "Out of range",
  stale: "Stale",
  recovered: "Recovered",
};

const typeLabel = (t: string | null | undefined) => (t ? TYPE_LABELS[t] || t : "—");

/** The point path the gateway named, with the topic prefix trimmed off the front.
 *  `aeonhwj/B2_Main Incomer/CAvg_A` → `CAvg_A`. The full address stays in the
 *  title attribute — shortening a label must never lose the identifier. */
function pointOf(addr: string | null | undefined): string {
  if (!addr) return "";
  const parts = addr.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : addr;
}

function SeverityChip({ severity, count }: { severity: string | null; count: number }) {
  const m = severityMeta(severity);
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-[6px] border px-2 py-0.5 text-[10.5px] uppercase tracking-[1.1px]"
      style={{ borderColor: `${m.accent}55`, background: `${m.accent}18`, color: m.accent }}
    >
      <Icon icon={m.icon} className="text-[12px]" />
      {m.label}
      <span className="font-mono text-[11px]">{count}</span>
    </span>
  );
}

// How long one fault holds the frame before the carousel moves on. Slow on
// purpose: this is a sentence a human reads, not a banner they glance at.
const DWELL_MS = 7000;

function FaultCard({ row }: any) {
  const m = severityMeta(row.severity);
  return (
    <div className="flex items-start gap-2.5 px-1 py-2.5">
      <span
        className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-[7px] border"
        style={{ borderColor: `${m.accent}55`, background: `${m.accent}18`, color: m.accent }}
        title={m.label}
      >
        <Icon icon={m.icon} className="text-[13px]" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-[12.5px] font-semibold text-nb-ink">{row.device_tag || "—"}</span>
          {row.point_addr && (
            <span className="font-mono text-[11px] text-nb-faint" title={row.point_addr}>
              {pointOf(row.point_addr)}
            </span>
          )}
          <span className="rounded-[5px] border border-nb-line px-1.5 py-px text-[10px] uppercase tracking-[1.1px] text-nb-faint">
            {typeLabel(row.alert_type)}
          </span>
        </div>
        {/* The gateway's own sentence, verbatim. It is the one place the value
            that tripped the rule is stated, and rewording it would be this
            console asserting something it did not measure. */}
        <p
          className="mt-1 line-clamp-3 text-[11.5px] leading-snug text-nb-soft"
          title={row.message || undefined}
        >
          {row.message || "—"}
        </p>
      </div>
      <div className="shrink-0 text-right">
        <div className="text-[11px] text-nb-faint" title={row.ts}>
          {fmtRelative(row.ts)}
        </div>
        {row.conn_slug && (
          <div className="mt-0.5 font-mono text-[10.5px] text-nb-faint">{row.conn_slug}</div>
        )}
      </div>
    </div>
  );
}

// ── The carousel ─────────────────────────────────────────────────────────────
//
// WHY NOT A LIST. A scrolled list of faults reads as a wall: every row is the
// same shape, the newest one is wherever the scroll happens to be, and in a
// panel this size two or three rows are visible at a time with no indication
// that more exist. One fault at a time, given the width of the card, is
// readable at a glance — which is the whole job of a live queue.
//
// THREE RULES THE ROTATION FOLLOWS, each of them about not fighting the reader:
//
//   1. Hovering or focusing PAUSES it. Text that slides away mid-sentence is
//      worse than no rotation at all.
//   2. Touching an arrow or a dot STOPS it for good. Manual navigation is
//      someone saying which fault they want to look at; resuming the carousel
//      would take it back off them.
//   3. `prefers-reduced-motion` never auto-advances. The arrows still work, so
//      no fault becomes unreachable — the motion goes, the content does not.
//
// The index is clamped against the CURRENT item count on every render, because
// the query behind this refetches: a queue that shrinks while someone is on the
// last card must land somewhere real rather than render an undefined row.
function FaultCarousel({ items }: { items: any[] }) {
  const [i, setI] = useState(0);
  const [paused, setPaused] = useState(false);
  const [manual, setManual] = useState(false);
  const reduced = useRef(false);

  useEffect(() => {
    reduced.current =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
  }, []);

  const n = items.length;
  const at = n ? Math.min(i, n - 1) : 0;

  useEffect(() => {
    if (n < 2 || paused || manual || reduced.current) return;
    const t = setTimeout(() => setI((k) => (k + 1) % n), DWELL_MS);
    return () => clearTimeout(t);
  }, [at, n, paused, manual]);

  const go = (d: number) => {
    setManual(true);
    setI((k) => (((k + d) % n) + n) % n);
  };

  const row = items[at];
  if (!row) return null;

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") go(-1);
        if (e.key === "ArrowRight") go(1);
      }}
      tabIndex={n > 1 ? 0 : -1}
      role="group"
      aria-roledescription="carousel"
      aria-label={`Fault ${at + 1} of ${n}`}
      // A card keyed by its alert id remounts on change, so the transition is
      // per-fault rather than one element mutating its own text mid-read.
    >
      {/* A MINIMUM HEIGHT, not just `flex-1`. One fault needs roughly this much
          room — an icon, an identity line, up to three lines of the gateway's
          own sentence — and asking for it as leftover space is how this panel
          first shipped showing nothing at all: the column had about forty
          pixels to spare, `overflow-hidden` clipped the card to that, and the
          controls underneath made it look like a carousel with no slides.
          Content that cannot fit must push, or scroll, or say so. It must never
          be silently cropped to zero. */}
      <div className="min-h-[92px] flex-1 overflow-hidden rounded-[10px] border border-nb-line/60 bg-[rgba(6,11,26,.45)]">
        <FaultCard key={row.alert_id} row={row} />
      </div>

      {n > 1 && (
        <div className="mt-2 flex shrink-0 items-center gap-2">
          <button
            onClick={() => go(-1)}
            aria-label="Previous fault"
            className="grid h-6 w-6 place-items-center rounded-[6px] border border-nb-line text-nb-faint hover:text-nb-ink"
          >
            <Icon icon="heroicons:chevron-left" className="text-[13px]" />
          </button>

          <div className="flex flex-1 items-center justify-center gap-1.5">
            {items.map((it: any, k: number) => (
              <button
                key={it.alert_id}
                onClick={() => {
                  setManual(true);
                  setI(k);
                }}
                aria-label={`Fault ${k + 1}`}
                aria-current={k === at}
                className={`h-1.5 rounded-full transition-all ${
                  k === at ? "w-4 bg-nb-accent" : "w-1.5 bg-nb-line hover:bg-nb-faint"
                }`}
              />
            ))}
          </div>

          <span className="font-mono text-[10.5px] text-nb-faint">
            {at + 1}/{n}
          </span>

          <button
            onClick={() => go(1)}
            aria-label="Next fault"
            className="grid h-6 w-6 place-items-center rounded-[6px] border border-nb-line text-nb-faint hover:text-nb-ink"
          >
            <Icon icon="heroicons:chevron-right" className="text-[13px]" />
          </button>
        </div>
      )}
    </div>
  );
}

export default function FaultQueue({ query, hours }: any) {
  const data = query.data;

  if (query.isLoading) return <LoadingBlock label="Reading the fault store…" />;
  if (query.error)
    return (
      <p className="py-6 text-center text-[11.5px] text-nb-crit">
        Could not read the fault store.
      </p>
    );

  // Not "no faults" — nothing is COLLECTING faults. The two states look identical
  // on a screen that draws an empty list, and they mean opposite things.
  if (data && !data.available)
    return (
      <div className="rounded-[10px] border border-nb-warn/40 bg-[rgba(251,191,36,.08)] px-3 py-2.5 text-[11.5px] text-nb-soft">
        <span className="font-semibold text-nb-warn">No collector.</span>{" "}
        {data.unavailable_reason}. This is not the same as “no faults”, so nothing
        is claimed here either way.
      </div>
    );

  const items = data?.items || [];
  const bySeverity = data?.by_severity || [];

  return (
    <>
      <div className="mb-2.5 flex flex-wrap items-center gap-1.5">
        {bySeverity.length ? (
          bySeverity.map((s: any) => (
            <SeverityChip key={s.severity ?? "_none"} severity={s.severity} count={s.alerts} />
          ))
        ) : (
          <span className="text-[11.5px] text-nb-good">
            No fault was raised in the last {hours} hours.
          </span>
        )}
        {data?.total > items.length && (
          <span className="ml-auto text-[11px] text-nb-faint">
            showing {items.length} of {data.total}
          </span>
        )}
      </div>

      {items.length > 0 && <FaultCarousel items={items} />}
    </>
  );
}
