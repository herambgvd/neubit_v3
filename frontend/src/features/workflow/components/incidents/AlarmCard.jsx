"use client";

// AlarmCard — one rich incident tile for the board. Left severity color-band, a
// type/status glyph, the incident name + SOP + location + elapsed, a priority
// chip, a NEW marker for just-arrived incidents, an SLA countdown (green→amber→
// red), the assignee (avatar/initials or "Unassigned"), and inline quick actions
// (Acknowledge/Activate + Assign) wired to the real action API via parent
// handlers. The whole card is a link to the existing IncidentDetail; quick-action
// buttons stopPropagation so they don't navigate.

import Link from "next/link";
import { Icon } from "@iconify/react";

import { Avatar, Badge } from "@/components/ui/kit";
import { titleize, fmtRelative } from "@/lib/format";
import { PRIORITY_COLOR, STATUS_COLOR } from "../../constants";
import {
  incId,
  incTitle,
  incSopName,
  incStateName,
  incSiteName,
  incAssignedId,
  incAssigneeName,
  incCameraId,
  incEventTime,
  sev,
  slaFor,
  isOpen,
} from "./lib";
import AlarmCardCamera from "./AlarmCardCamera";

// A status → glyph for the card's type icon.
const STATUS_ICON = {
  pending: "heroicons-solid:bell-alert",
  active: "heroicons-solid:signal",
  paused: "heroicons-solid:pause-circle",
  resolved: "heroicons-solid:check-circle",
  completed: "heroicons-solid:check-circle",
  cancelled: "heroicons-solid:x-circle",
};

function SlaChip({ sla }) {
  if (!sla) {
    return <span className="inline-flex items-center gap-1 font-mono text-[11px] text-[#7e93bf]"><Icon icon="heroicons-outline:clock" className="text-xs" />No SLA</span>;
  }
  const tone = {
    ok: "text-[#34d399]",
    warn: "text-[#fbbf24]",
    breach: "text-[#f87171]",
    done: "text-[#7e93bf]",
  }[sla.tone];
  return (
    <span className={`inline-flex items-center gap-1 font-mono text-[11px] font-medium ${tone}`}>
      <Icon icon="heroicons-solid:clock" className="text-xs" />
      {sla.label}
    </span>
  );
}

export default function AlarmCard({
  incident,
  sopName = {},
  siteName = {},
  isNew = false,
  selected = false,
  onSelect,
  onAck,
  onAssign,
  actionPending = false,
}) {
  const it = incident;
  const id = incId(it);
  const s = sev(it.priority);
  const sla = slaFor(it);
  const open = isOpen(it.status);
  const assigneeName = incAssigneeName(it);
  const assignedId = incAssignedId(it);
  const site = incSiteName(it, siteName);
  const sop = incSopName(it, sopName);
  const state = incStateName(it);

  // "Acknowledge" is only offered while the incident is pending (→ Activate),
  // matching STATUS_ACTIONS in IncidentActionBar. We never render an illegal
  // action; the backend still enforces the machine.
  const canAck = it.status === "pending";

  // A camera-sourced incident (VMS event) gets a live snapshot + "view recording".
  const cameraId = incCameraId(it);
  const eventTime = incEventTime(it);

  const stop = (e) => e.stopPropagation();

  return (
    <div
      className={`group relative flex overflow-hidden rounded-[13px] border bg-[rgba(150,180,245,.04)] backdrop-blur-xs transition hover:bg-[rgba(150,180,245,.07)] ${
        isNew ? "border-[rgba(34,211,238,.5)] ring-1 ring-[rgba(34,211,238,.25)]" : "border-[rgba(150,180,245,.22)]"
      } ${selected ? "!border-[rgba(34,211,238,.6)]" : ""}`}
    >
      {/* Severity band */}
      <span className={`w-1.5 shrink-0 ${s.band}`} aria-hidden />

      {/* Selection checkbox (bulk) */}
      {onSelect && (
        <label className="flex items-start pl-3 pt-4" onClick={stop}>
          <input
            type="checkbox"
            checked={selected}
            onChange={() => onSelect(id)}
            aria-label="Select incident"
            className="mt-0.5 accent-[#22d3ee]"
          />
        </label>
      )}

      <Link href={`/events/${id}`} className="flex min-w-0 flex-1 flex-col gap-2.5 px-4 py-3.5">
        {/* Top row: glyph + title + NEW + priority */}
        <div className="flex items-start gap-3">
          <span className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border ${s.ring} ${s.soft} ${s.text}`}>
            <Icon icon={STATUS_ICON[it.status] || "heroicons-solid:bell-alert"} className="text-base" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-semibold text-[#f2f6ff]">{incTitle(it)}</span>
              {isNew && (
                <span className="shrink-0 rounded-full border border-[rgba(34,211,238,.5)] bg-[rgba(34,211,238,.15)] px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-[1px] text-[#67e8f9]">
                  New
                </span>
              )}
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-[#aec2e8]">
              {sop && <span className="truncate">{sop}</span>}
              {sop && <span className="text-[#7e93bf] opacity-60">·</span>}
              <span className="inline-flex items-center gap-0.5">
                <Icon icon="heroicons-outline:map-pin" className="text-xs" />
                {site || "No site"}
              </span>
              <span className="text-[#7e93bf] opacity-60">·</span>
              <span className="font-mono text-[#7e93bf]">{fmtRelative(it.created_at)}</span>
            </div>
          </div>
          <Badge color={PRIORITY_COLOR[it.priority] || "neutral"}>{titleize(it.priority)}</Badge>
        </div>

        {/* Bottom row: status/state · SLA · assignee · quick actions */}
        <div className="flex items-center gap-2.5 pl-11">
          <Badge color={STATUS_COLOR[it.status] || "neutral"}>{titleize(it.status)}</Badge>
          {state && <span className="truncate text-[11px] text-[#aec2e8]">{state}</span>}
          <span className="text-[#7e93bf] opacity-60">·</span>
          <SlaChip sla={sla} />

          <span className="ml-auto inline-flex items-center gap-1.5 text-[11px]" title={assigneeName || "Unassigned"}>
            {assignedId || assigneeName ? (
              <>
                <Avatar name={assigneeName || "?"} size={20} />
                <span className="max-w-[8rem] truncate text-[#aec2e8]">{assigneeName || "Assigned"}</span>
              </>
            ) : (
              <span className="inline-flex items-center gap-1 text-[#7e93bf]">
                <Icon icon="heroicons-outline:user" className="text-xs" />
                Unassigned
              </span>
            )}
          </span>
        </div>

        {/* Camera media (P5-C) — only for incidents with an associated camera. */}
        {cameraId && (
          <div className="pl-11">
            <AlarmCardCamera cameraId={cameraId} eventTime={eventTime} />
          </div>
        )}
      </Link>

      {/* Quick actions rail (appears on hover; always visible on touch via group) */}
      {open && (onAck || onAssign) && (
        <div className="flex shrink-0 flex-col items-stretch justify-center gap-1 border-l border-[rgba(150,180,245,.22)] p-2 opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
          {canAck && onAck && (
            <button
              type="button"
              onClick={(e) => { stop(e); onAck(it); }}
              disabled={actionPending}
              title="Acknowledge (activate)"
              className="inline-flex items-center gap-1 rounded-[8px] border border-[rgba(150,180,245,.22)] px-2 py-1 font-mono text-[11px] font-medium uppercase tracking-[.5px] text-[#aec2e8] transition hover:border-[rgba(34,211,238,.5)] hover:text-[#67e8f9] disabled:opacity-40"
            >
              <Icon icon="heroicons-outline:check" className="text-xs" /> Ack
            </button>
          )}
          {onAssign && (
            <button
              type="button"
              onClick={(e) => { stop(e); onAssign(it); }}
              disabled={actionPending}
              title={assignedId ? "Reassign" : "Assign"}
              className="inline-flex items-center gap-1 rounded-[8px] border border-[rgba(150,180,245,.22)] px-2 py-1 font-mono text-[11px] font-medium uppercase tracking-[.5px] text-[#aec2e8] transition hover:border-[rgba(34,211,238,.5)] hover:text-[#67e8f9] disabled:opacity-40"
            >
              <Icon icon="heroicons-outline:user-plus" className="text-xs" /> {assignedId ? "Reassign" : "Assign"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
