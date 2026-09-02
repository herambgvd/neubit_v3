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

function FaultRow({ row }: any) {
  const m = severityMeta(row.severity);
  return (
    <li className="flex items-start gap-2.5 border-t border-nb-line/40 px-1 py-2.5 first:border-t-0">
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
        <p className="mt-1 text-[11.5px] leading-snug text-nb-soft">{row.message || "—"}</p>
      </div>
      <div className="shrink-0 text-right">
        <div className="text-[11px] text-nb-faint" title={row.ts}>
          {fmtRelative(row.ts)}
        </div>
        {row.conn_slug && (
          <div className="mt-0.5 font-mono text-[10.5px] text-nb-faint">{row.conn_slug}</div>
        )}
      </div>
    </li>
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

      {items.length > 0 && (
        <ul className="max-h-[420px] overflow-y-auto">
          {items.map((row: any) => (
            <FaultRow key={row.alert_id} row={row} />
          ))}
        </ul>
      )}
    </>
  );
}
