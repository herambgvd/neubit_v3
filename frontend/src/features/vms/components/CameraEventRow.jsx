"use client";

// CameraEventRow — one row in the VMS camera-events feed. A severity band, the
// event-type chip (icon + color), the camera name, the occurred-at time, an
// ack pill, and two actions: acknowledge (unless already acked) + "jump to
// recording" (opens the PlaybackPlayer at occurred_at via /playback?camera=&t=).
// Expandable to show the raw device payload. Ported in spirit from gvd_nvr
// Events.js rows, rethemed to v3 tokens.
import { useState } from "react";
import Link from "next/link";
import { Icon } from "@iconify/react";

import { typePreset, sevPreset, eventTypeLabel, fmtTime, fmtDate } from "../eventLib";

export default function CameraEventRow({ event, cameraName, incidentId = null, onAck, ackPending = false }) {
  const [open, setOpen] = useState(false);
  const tp = typePreset(event.event_type);
  const sp = sevPreset(event.severity);
  const acked = !!event.acknowledged;

  // Deep-link to Playback at this event's time. occurred_at is an ISO string the
  // Playback page reads from ?t= to seek the scrub bar.
  const playbackHref =
    event.camera_id && event.occurred_at
      ? `/playback?camera=${encodeURIComponent(event.camera_id)}&t=${encodeURIComponent(event.occurred_at)}`
      : null;

  const raw = event.raw && Object.keys(event.raw).length ? event.raw : null;

  return (
    <div className="flex items-stretch gap-0 hover:bg-hover/50">
      {/* Severity band */}
      <span className={`w-1 shrink-0 ${sp.band}`} aria-hidden />

      <div className="min-w-0 flex-1 px-3 py-2.5">
        <div className="flex items-start gap-3">
          {/* Time */}
          <div className="w-[86px] shrink-0 font-mono text-[11px] leading-tight text-muted">
            <div className="tabular-nums">{fmtTime(event.occurred_at)}</div>
            <div className="mt-0.5 text-[10px] text-muted/70">{fmtDate(event.occurred_at)}</div>
          </div>

          {/* Body */}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${tp.cls}`}>
                <Icon icon={tp.icon} className="text-xs" />
                {eventTypeLabel(event.event_type)}
              </span>
              <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${sp.cls}`}>{sp.label}</span>
              {event.title && event.title !== eventTypeLabel(event.event_type) && (
                <span className="truncate text-xs font-medium text-foreground">{event.title}</span>
              )}
              {acked && (
                <span className="inline-flex items-center gap-1 rounded-full bg-hover px-1.5 py-0.5 text-[10px] text-muted">
                  <Icon icon="heroicons-outline:check" className="text-[10px]" />
                  Acked
                </span>
              )}
              {incidentId && (
                <Link
                  href={`/events/${encodeURIComponent(incidentId)}`}
                  title="This event raised an incident — open it"
                  className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-amber-500 hover:bg-amber-500/20"
                >
                  <Icon icon="heroicons-outline:bell-alert" className="text-[10px]" />
                  Incident
                  <Icon icon="heroicons-outline:arrow-top-right-on-square" className="text-[9px]" />
                </Link>
              )}
              {raw && (
                <button
                  type="button"
                  onClick={() => setOpen((o) => !o)}
                  className="ml-auto inline-flex items-center gap-0.5 text-[10px] text-muted hover:text-foreground"
                >
                  <Icon icon={open ? "heroicons-outline:chevron-down" : "heroicons-outline:chevron-right"} className="text-xs" />
                  raw
                </button>
              )}
            </div>

            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted">
              <span className="inline-flex items-center gap-1">
                <Icon icon="heroicons-outline:video-camera" className="text-xs" />
                {cameraName || (event.camera_id ? `Camera ${String(event.camera_id).slice(0, 8)}` : "System")}
              </span>
              {event.source && (
                <>
                  <span className="opacity-40">·</span>
                  <span className="uppercase tracking-wide">{event.source}</span>
                </>
              )}
              {event.zone && (
                <>
                  <span className="opacity-40">·</span>
                  <span>zone {event.zone}</span>
                </>
              )}
              {event.description && (
                <>
                  <span className="opacity-40">·</span>
                  <span className="truncate">{event.description}</span>
                </>
              )}
            </div>

            {open && raw && (
              <pre className="mt-2 max-h-48 overflow-auto rounded border border-card-border bg-hover p-2 font-mono text-[10px] text-muted">
                {JSON.stringify(raw, null, 2)}
              </pre>
            )}
          </div>

          {/* Actions */}
          <div className="flex shrink-0 flex-col items-stretch gap-1">
            {!acked && onAck && (
              <button
                type="button"
                onClick={() => onAck(event)}
                disabled={ackPending}
                title="Acknowledge"
                className="inline-flex items-center justify-center gap-1 rounded-md border border-card-border px-2 py-1 text-[11px] font-medium text-foreground hover:bg-card disabled:opacity-40"
              >
                <Icon icon="heroicons-outline:check" className="text-xs" /> Ack
              </button>
            )}
            {playbackHref && (
              <Link
                href={playbackHref}
                title="Jump to recording at this time"
                className="inline-flex items-center justify-center gap-1 rounded-md border border-card-border px-2 py-1 text-[11px] font-medium text-muted hover:bg-card hover:text-foreground"
              >
                <Icon icon="heroicons-outline:play" className="text-xs" /> Recording
              </Link>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
