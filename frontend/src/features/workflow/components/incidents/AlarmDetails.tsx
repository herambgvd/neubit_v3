"use client";

// THE FACTS COLUMN of the alarm triptych — what this alarm is, and the moves an
// operator can make without leaving the screen.
//
// Same rule as the events console: NOTHING IS INVENTED. A row appears when the
// record actually holds the thing. An alarm with no SLA says so rather than
// printing a comfortable number; one nobody owns says "Unassigned" rather than
// leaving a blank an operator reads as "probably fine".
//
// STATUS LEADS, because it is the first thing asked of a row just clicked: is
// anyone on this, and how long is left.
import type { ReactNode } from "react";
import Link from "next/link";
import { Icon } from "@iconify/react";

import { fmtDateTime } from "@/lib/format";
import type { InstancePublic, NameMap } from "../../types";
import {
  incAssigneeName,
  incCameraId,
  incEventTime,
  incId,
  incSiteName,
  incSopName,
  incTitle,
  isOpen,
  sev,
  slaFor,
} from "./lib";

export interface AlarmDetailsProps {
  incident: InstancePublic;
  sopName?: NameMap;
  siteName?: NameMap;
  /** The camera's name as the ESTATE knows it, when the source event named one. */
  cameraName?: string | null;
  onAck?: (incident: InstancePublic) => void;
  onAssign?: (incident: InstancePublic) => void;
  ackPending?: boolean;
  onClose?: () => void;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3 border-b border-card-border/60 px-3 py-2 last:border-0">
      <span className="w-28 shrink-0 text-[11px] text-muted">{label}</span>
      <span className="min-w-0 flex-1 text-[12px] text-foreground">{children}</span>
    </div>
  );
}

const SLA_TONE: Record<string, string> = {
  ok: "text-emerald-400",
  warn: "text-amber-400",
  breach: "text-red-400",
  done: "text-muted",
};

export default function AlarmDetails({
  incident,
  sopName = {},
  siteName = {},
  cameraName = null,
  onAck,
  onAssign,
  ackPending = false,
  onClose,
}: AlarmDetailsProps) {
  const id = incId(incident);
  const s = sev(incident.priority);
  const sla = slaFor(incident);
  const owner = incAssigneeName(incident);
  const cameraId = incCameraId(incident);
  const eventTime = incEventTime(incident);
  const open = isOpen(incident.status);
  // "vision" = raised from a camera event, by a rule or by an operator; "manual"
  // = raised with no originating event at all. Worth saying: it changes what an
  // operator should expect to find in the evidence panes.
  const source = incident.event_source;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-card-border bg-card">
      <header className="flex items-center gap-2 border-b border-card-border px-3 py-2">
        <span className={`h-2 w-2 shrink-0 rounded-full ${s.dot}`} />
        <span className="truncate text-[12px] font-semibold text-foreground">{incTitle(incident)}</span>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            title="Close — stop showing this alarm"
            aria-label="Close alarm details"
            className="ml-auto inline-flex h-6 w-6 items-center justify-center rounded-md text-muted transition hover:bg-hover hover:text-foreground"
          >
            <Icon icon="heroicons-outline:x-mark" className="text-sm" />
          </button>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <Row label="State">
          <span className="inline-flex items-center gap-1.5">
            <span className="rounded-full bg-hover px-1.5 py-0.5 text-[10px] text-foreground">
              {incident.current_state_name || incident.status}
            </span>
            <span className="text-[11px] text-muted">{incident.status}</span>
          </span>
        </Row>
        <Row label="Deadline">
          {sla ? (
            <span className={SLA_TONE[sla.tone]}>
              {sla.label}
              <span className="ml-1.5 font-mono text-[11px] text-muted">
                {fmtDateTime(new Date(sla.deadline).toISOString())}
              </span>
            </span>
          ) : (
            <span className="text-muted">No time limit on this procedure</span>
          )}
        </Row>
        <Row label="Owner">
          {owner ? (
            <span>{owner}</span>
          ) : (
            <span className="text-amber-400">Unassigned</span>
          )}
        </Row>
        <Row label="Priority">
          <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${s.soft} ${s.text}`}>
            {s.label}
          </span>
        </Row>
        <Row label="Procedure">{incSopName(incident, sopName) || "—"}</Row>
        {incSiteName(incident, siteName) && (
          <Row label="Site">{incSiteName(incident, siteName)}</Row>
        )}
        {cameraName && <Row label="Camera">{cameraName}</Row>}
        {eventTime && (
          <Row label="Event at">
            <span className="font-mono text-[11.5px]">{fmtDateTime(eventTime)}</span>
          </Row>
        )}
        <Row label="Raised">
          <span className="font-mono text-[11.5px]">{fmtDateTime(incident.created_at)}</span>
        </Row>
        {source && (
          <Row label="Raised by">
            {source === "manual" ? "An operator, with no source event" : `A ${source} event`}
          </Row>
        )}
        {incident.description && <Row label="Notes">{incident.description}</Row>}
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-t border-card-border px-3 py-2">
        {open && incident.status === "pending" && onAck && (
          <button
            type="button"
            onClick={() => onAck(incident)}
            disabled={ackPending}
            className="inline-flex items-center gap-1.5 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1.5 text-[11.5px] font-medium text-emerald-300 transition hover:bg-emerald-500/20 disabled:opacity-50"
          >
            <Icon icon="heroicons-outline:check" className="text-xs" /> Take it
          </button>
        )}
        {open && onAssign && (
          <button
            type="button"
            onClick={() => onAssign(incident)}
            className="inline-flex items-center gap-1.5 rounded-md border border-card-border px-2.5 py-1.5 text-[11.5px] text-muted transition hover:bg-hover hover:text-foreground"
          >
            <Icon icon="heroicons-outline:user-plus" className="text-xs" /> Assign
          </button>
        )}
        <Link
          href={`/alarms/${encodeURIComponent(id)}`}
          className="inline-flex items-center gap-1.5 rounded-md border border-blue-500/40 bg-blue-500/10 px-2.5 py-1.5 text-[11.5px] text-blue-200 transition hover:bg-blue-500/20"
        >
          <Icon icon="heroicons-outline:arrow-top-right-on-square" className="text-xs" /> Open
        </Link>
        {cameraId && eventTime && (
          <Link
            href={`/playback?camera=${encodeURIComponent(cameraId)}&t=${encodeURIComponent(eventTime)}`}
            title="Open this camera's whole timeline in Playback"
            className="inline-flex items-center gap-1.5 rounded-md border border-card-border px-2.5 py-1.5 text-[11.5px] text-muted transition hover:bg-hover hover:text-foreground"
          >
            <Icon icon="heroicons-outline:film" className="text-xs" /> Timeline
          </Link>
        )}
      </div>
    </div>
  );
}
