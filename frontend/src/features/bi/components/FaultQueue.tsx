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

// One fault, rendered inline for the ticker rail. Everything the list row said
// is still here — severity, device, point, the gateway's verbatim sentence, the
// age — laid out on a single line because the rail scrolls horizontally.
function FaultItem({ row }: any) {
  const m = severityMeta(row.severity);
  return (
    <span className="inline-flex shrink-0 items-center gap-2 whitespace-nowrap">
      <span
        className="grid h-5 w-5 shrink-0 place-items-center rounded-[6px] border"
        style={{ borderColor: `${m.accent}55`, background: `${m.accent}18`, color: m.accent }}
        title={m.label}
      >
        <Icon icon={m.icon} className="text-[12px]" />
      </span>
      <span className="text-[12px] font-semibold text-nb-ink">{row.device_tag || "—"}</span>
      {row.point_addr && (
        <span className="font-mono text-[11px] text-nb-faint" title={row.point_addr}>
          {pointOf(row.point_addr)}
        </span>
      )}
      <span className="rounded-[5px] border border-nb-line px-1.5 py-px text-[10px] uppercase tracking-[1.1px] text-nb-faint">
        {typeLabel(row.alert_type)}
      </span>
      {/* The gateway's own sentence, verbatim. It is the one place the value that
          tripped the rule is stated, and rewording it would be this console
          asserting something it did not measure. */}
      <span className="text-[11.5px] text-nb-soft">{row.message || "—"}</span>
      <span className="text-[11px] text-nb-faint" title={row.ts}>
        {fmtRelative(row.ts)}
      </span>
      {row.conn_slug && (
        <span className="font-mono text-[10.5px] text-nb-faint">{row.conn_slug}</span>
      )}
    </span>
  );
}

/** Severity counts, for the SECTION HEADER rather than a row of their own.
 *  Exported so the panel's title line can carry them — a queue whose headline
 *  is "how many, how bad" belongs beside the title, and moving it there gives
 *  the faults themselves the row it used to occupy. */
export function FaultSeverity({ query }: any) {
  const data = query.data;
  if (!data?.available) return null;
  const bySeverity = data.by_severity || [];
  const shown = (data.items || []).length;
  return (
    <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
      {bySeverity.map((s: any) => (
        <SeverityChip key={s.severity ?? "_none"} severity={s.severity} count={s.alerts} />
      ))}
      {data.total > shown && (
        <span className="text-[11px] text-nb-faint">
          showing {shown} of {data.total}
        </span>
      )}
    </div>
  );
}

// ── The ticker ───────────────────────────────────────────────────────────────
//
// WHY A TICKER AND NOT A LIST OR A CAROUSEL. A scrolled list reads as a wall:
// same-shaped rows, the newest wherever the scroll was left, and in a panel this
// size only two or three visible with nothing to say more exist. A slide
// carousel fixed the reading but cost a whole row of arrows and dots and made
// every fault wait its turn behind a timer. A ticker shows the queue as what it
// is — a continuous run of events — in ONE row, with no controls at all.
//
// The track holds the items TWICE and slides exactly half its own width. At the
// instant the first copy leaves, the second is where it started, so the loop has
// no jump and no gap. The duplicate is `aria-hidden`: a screen reader gets the
// queue once, not twice.
//
// Speed is per-instance, not fixed. `SECONDS_PER_FAULT` × the item count means
// two faults do not crawl and twenty do not sprint — the rail always moves at
// about a reading pace regardless of how loud the estate is.
//
// Hover or focus PAUSES it (CSS, on the rail, so it works without React), and
// `prefers-reduced-motion` stops the animation entirely while turning the rail
// into a normal horizontal scroller — the motion goes, no fault becomes
// unreachable.
const SECONDS_PER_FAULT = 9;

function FaultTicker({ items }: { items: any[] }) {
  const duration = Math.max(18, items.length * SECONDS_PER_FAULT);
  const run = (dup: boolean) => (
    // `min-w-full` is what makes the loop seamless when the estate is QUIET.
    // With two faults the content is narrower than the rail, and a track sized
    // to content would slide a gap through the frame every cycle. Floored at the
    // rail's width, one run is always at least a full frame, so translating the
    // track by half of itself lands the second run exactly where the first
    // started — loud estate or quiet one.
    <div
      className={`flex min-w-full shrink-0 items-center gap-8 pr-8 ${dup ? "nb-ticker-dup" : ""}`}
      aria-hidden={dup || undefined}
    >
      {items.map((row: any) => (
        <FaultItem key={`${dup ? "d" : ""}${row.alert_id}`} row={row} />
      ))}
    </div>
  );

  return (
    <div className="nb-ticker-hold py-1">
      <div className="nb-ticker-rail overflow-hidden">
        <div
          className="nb-ticker flex"
          style={{ ["--nb-ticker-duration" as any]: `${duration}s` }}
        >
          {run(false)}
          {run(true)}
        </div>
      </div>
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

  // The counts now live in the section header (`FaultSeverity`). What is left
  // here is the queue itself — or, when it is empty, the one sentence that says
  // so. An empty queue is GOOD NEWS and is stated as such; it is not the same
  // as the no-collector state above, which is silence.
  if (!items.length)
    return (
      <p className="py-2 text-[11.5px] text-nb-good">
        No fault was raised in the last {hours} hours.
      </p>
    );

  return (
    <>
      <FaultTicker items={items} />
    </>
  );
}
