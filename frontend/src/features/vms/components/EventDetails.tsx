"use client";

// THE FACTS COLUMN — what this event is, in the words the recorder used.
//
// The middle of the triage triptych: the recording on one side, live on the
// other, and between them the answer to "what am I looking at" plus the moves an
// operator can make. Every enterprise console lays it out this way because the
// three questions arrive together: what happened, what is it, what do I do.
//
// One rule runs through the fields: NOTHING IS INVENTED. A row appears when the
// recorder told us the thing. A duration whose ends do not make sense says so; an
// event with no end says it is still running; a camera we cannot name is printed
// as the id it came with rather than as a blank.
import type { ReactNode } from "react";
import Link from "next/link";
import { Icon } from "@iconify/react";

import { eventTypeLabel, fmtDate, fmtTime, sevPreset, typePreset, type NormalizedVmsEvent } from "../eventLib";
import { durationLabel, eventInterval } from "../eventState";
import { useTicker } from "../hooks/useTicker";

export interface EventDetailsProps {
  event: NormalizedVmsEvent;
  cameraName?: string | null;
  recorderName?: string | null;
  incidentId?: string | null;
  onAck?: (event: NormalizedVmsEvent) => void;
  ackPending?: boolean;
  /** Playback deep link — for the whole timeline, when one clip is not enough. */
  investigateHref?: string | null;
  /** Escalate into an alarm — absent when the operator cannot raise one, or when
   *  this event already has one (the link below replaces it). */
  onEscalate?: () => void;
  /** Let go of this event. The triptych holds a selection the operator did not
   *  always make (the newest event, or an alarm that took the canvas), so there
   *  has to be a way to put it down — otherwise the only way off an event is onto
   *  another one. */
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

/** The recorder's own reason, out of the payload it sent. A row that prints the
 *  transport ("ONVIF_PULLPOINT") tells an operator nothing they can act on. */
function reasonOf(event: NormalizedVmsEvent): string | null {
  const raw = (event.raw || {}) as Record<string, unknown>;
  const payload = (raw.payload || {}) as Record<string, unknown>;
  const reason = payload.reason ?? raw.reason;
  if (typeof reason === "string" && reason.trim()) return reason.trim();
  const status = payload.status;
  return typeof status === "string" && status.trim() ? status.trim() : null;
}

export default function EventDetails({
  event,
  cameraName,
  recorderName,
  incidentId = null,
  onAck,
  ackPending = false,
  investigateHref = null,
  onClose,
  onEscalate,
}: EventDetailsProps) {
  const iv = eventInterval(event);
  // Only an OPEN event needs a clock: its duration is still changing.
  const now = useTicker(1_000, iv.open);
  const sp = sevPreset(event.severity);
  const tp = typePreset(event.event_type);
  const reason = reasonOf(event);
  const topic = typeof (event.raw as { topic?: unknown })?.topic === "string"
    ? ((event.raw as { topic?: string }).topic as string)
    : null;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-card-border bg-card">
      <header className="flex items-center gap-2 border-b border-card-border px-3 py-2">
        <Icon icon="heroicons-outline:information-circle" className="text-sm text-blue-500" />
        <span className="text-[12px] font-semibold text-foreground">Details</span>
        {iv.open && (
          <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-orange-500/15 px-2 py-0.5 text-[10px] font-semibold text-orange-300">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-orange-400 opacity-70" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-orange-400" />
            </span>
            Ongoing
          </span>
        )}
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            title="Close — stop showing this event"
            aria-label="Close event details"
            className={`${iv.open ? "" : "ml-auto "}inline-flex h-6 w-6 items-center justify-center rounded-md text-muted transition hover:bg-hover hover:text-foreground`}
          >
            <Icon icon="heroicons-outline:x-mark" className="text-sm" />
          </button>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <Row label="Status">
          {event.acknowledged ? (
            <span className="rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-400">
              Acknowledged
            </span>
          ) : (
            <span className="rounded-full border border-card-border px-1.5 py-0.5 text-[10px] text-muted">
              Open
            </span>
          )}
        </Row>
        <Row label="Event type">
          <span className="inline-flex items-center gap-1.5">
            <Icon icon={tp.icon} className={`text-sm ${sp.text}`} />
            {eventTypeLabel(event.event_type)}
          </span>
        </Row>
        <Row label="Severity">
          <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${sp.cls}`}>{sp.label}</span>
        </Row>
        <Row label="Started">
          <span className="font-mono">
            {fmtTime(event.occurred_at)} · {fmtDate(event.occurred_at)}
          </span>
        </Row>
        <Row label="Duration">
          {/* Recomputed on the tick while it is open, so this counts up in place. */}
          <span className={`font-mono ${iv.open ? "text-orange-300" : ""}`}>
            {durationLabel(event, now) ?? (iv.durationMs === 0 ? "instant" : "—")}
          </span>
        </Row>
        <Row label="Camera">{cameraName || event.camera_id || "—"}</Row>
        {recorderName && <Row label="Recorder">{recorderName}</Row>}
        <Row label="Source">
          <span className="font-mono text-[11px] text-muted">{event.source || "—"}</span>
        </Row>
        {reason && (
          <Row label="Reason">
            <span className="break-words font-mono text-[11px]">{reason}</span>
          </Row>
        )}
        {topic && (
          <Row label="Topic">
            <span className="break-words font-mono text-[11px] text-muted">{topic}</span>
          </Row>
        )}
        <Row label="Event ID">
          <span className="break-all font-mono text-[10.5px] text-muted">
            {event.event_id || event.id || "—"}
          </span>
        </Row>
      </div>

      {/* The moves. Acknowledge is the one an operator makes most, so it leads. */}
      <div className="flex flex-wrap gap-2 border-t border-card-border p-2">
        {!event.acknowledged && onAck ? (
          <button
            type="button"
            disabled={ackPending}
            onClick={() => onAck(event)}
            className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1.5 text-[11.5px] font-medium text-emerald-300 transition hover:bg-emerald-500/20 disabled:opacity-50"
          >
            <Icon icon="heroicons-outline:check" className="text-xs" /> Acknowledge
          </button>
        ) : (
          <span className="flex-1 rounded-md border border-card-border px-2.5 py-1.5 text-center text-[11.5px] text-muted">
            Acknowledged
          </span>
        )}
        {/* ONE SLOT, TWO STATES. An event that already raised an alarm offers the
            way TO it; one that has not offers the way to raise it. Two buttons
            here would let an operator raise a second alarm for the same event
            without being told the first exists. */}
        {incidentId ? (
          <Link
            href={`/alarms/${encodeURIComponent(incidentId)}`}
            className="inline-flex items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-[11.5px] text-amber-300 transition hover:bg-amber-500/20"
          >
            <Icon icon="heroicons-outline:bell-alert" className="text-xs" /> Open alarm
          </Link>
        ) : (
          onEscalate && (
            <button
              type="button"
              onClick={onEscalate}
              title="Raise an alarm from this event and run a procedure on it"
              className="inline-flex items-center gap-1.5 rounded-md border border-orange-500/40 bg-orange-500/10 px-2.5 py-1.5 text-[11.5px] font-medium text-orange-300 transition hover:bg-orange-500/20"
            >
              <Icon icon="heroicons-outline:arrow-trending-up" className="text-xs" /> Escalate
            </button>
          )
        )}
        {investigateHref && (
          <Link
            href={investigateHref}
            title="Open this camera's whole timeline in Playback"
            className="inline-flex items-center gap-1.5 rounded-md border border-card-border px-2.5 py-1.5 text-[11.5px] text-muted transition hover:bg-hover hover:text-foreground"
          >
            <Icon icon="heroicons-outline:arrow-top-right-on-square" className="text-xs" /> Investigate
          </Link>
        )}
      </div>
    </div>
  );
}
