"use client";

// THE CORNER ALARM — what an operator gets when the thing fires and they are
// somewhere else in the console.
//
// It used to be one line: "tamper · Channel 2" and a View button. That is the
// event's TYPE and a camera name, which is barely more than the fact that
// something happened. An operator reading it still has to go somewhere to learn
// whether it matters, when it was, whether it is still running and whether
// anybody has taken it — which is most of the reason to open the Events page,
// for an alarm that might not have needed opening at all.
//
// So the toast carries what a triage decision actually needs:
//   * HOW BAD — a severity stripe and badge, the same ladder as the feed, so the
//     colour alone sorts a critical from a motion trip across the room;
//   * WHAT — the type in the console's own words ("Tamper", not "tamper");
//   * WHERE — the camera, and the recorder that owns it when we know it;
//   * WHEN — the clock time and how long ago, because "just now" and "4m ago" are
//     different situations;
//   * WHETHER IT IS STILL GOING — an open stateful event says "ongoing", which is
//     the difference between a thing that happened and a thing that is happening;
//   * WHAT TO DO — View (the video, focused on this event) and Acknowledge, so an
//     alarm an operator recognises is closed from where they are standing.
//
// Nothing here is invented: a field the recorder did not send is simply absent.
import { useState } from "react";
import { Icon } from "@iconify/react";

import { eventTypeLabel, fmtTime, sevPreset, typePreset, type NormalizedVmsEvent } from "../eventLib";
import { eventInterval, formatDuration } from "../eventState";

export interface EventToastProps {
  event: NormalizedVmsEvent;
  cameraName: string;
  recorderName?: string | null;
  /** Open the Events page on this event. */
  onView: () => void;
  /** Acknowledge in place; absent when the event carries no id to ack. */
  onAck?: () => void;
  acked?: boolean;
  ackPending?: boolean;
  /** Stop the corner interrupting — the operator's own preference. */
  onMute?: () => void;
  onDismiss: () => void;
  /** Injectable for tests; defaults to the moment the toast was raised. */
  now?: number;
}

/** "just now" / "4m ago" / "2h ago". An alarm's age changes what it means. */
export function agoLabel(occurredAt: string | undefined, now: number): string | null {
  if (!occurredAt) return null;
  const t = new Date(occurredAt).getTime();
  if (Number.isNaN(t)) return null;
  const sec = Math.round((now - t) / 1000);
  if (sec < 0) return null; // a clock ahead of ours: say nothing rather than "-3s ago"
  if (sec < 45) return "just now";
  return `${formatDuration(sec * 1000)} ago`;
}

export default function EventToast({
  event,
  cameraName,
  recorderName = null,
  onView,
  onAck,
  acked = false,
  ackPending = false,
  onMute,
  onDismiss,
  now,
}: EventToastProps) {
  // Lazily, once: a Date.now() in the render body is a different answer every
  // render, so "just now" could change while nothing about the alarm did.
  const [raisedAt] = useState(() => Date.now());
  const sp = sevPreset(event.severity);
  const tp = typePreset(event.event_type);
  const iv = eventInterval(event);
  const ago = agoLabel(event.occurred_at, now ?? raisedAt);

  return (
    <div
      role="alert"
      className="flex w-[22rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-card-border bg-card shadow-xl"
    >
      {/* The severity as a colour before it is a word — read across a room. */}
      <span className={`w-1 shrink-0 ${sp.band}`} aria-hidden />

      <div className="min-w-0 flex-1 px-3 py-2.5">
        <div className="flex items-start gap-2">
          <Icon icon={tp.icon} className={`mt-0.5 shrink-0 text-base ${sp.text}`} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-[13px] font-semibold text-foreground">
                {eventTypeLabel(event.event_type)}
              </span>
              <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${sp.cls}`}>
                {sp.label}
              </span>
              {iv.open && (
                <span className="shrink-0 inline-flex items-center gap-1 rounded-full bg-orange-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-orange-300">
                  <span className="relative flex h-1.5 w-1.5">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-orange-400 opacity-70" />
                    <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-orange-400" />
                  </span>
                  Ongoing
                </span>
              )}
            </div>

            {/* WHERE and WHEN, on one line — the two questions that follow "what". */}
            <p className="mt-0.5 truncate text-[12px] text-foreground/90">
              {cameraName}
              {recorderName && <span className="text-muted"> · {recorderName}</span>}
            </p>
            <p className="mt-0.5 text-[11px] text-muted">
              <span className="font-mono">{fmtTime(event.occurred_at)}</span>
              {ago && <> · {ago}</>}
              {acked && <span className="text-emerald-400"> · acknowledged</span>}
            </p>

            {event.description && (
              <p className="mt-1 line-clamp-2 text-[11.5px] text-muted">{event.description}</p>
            )}

            <div className="mt-2 flex items-center gap-1.5">
              <button
                type="button"
                onClick={onView}
                className="inline-flex items-center gap-1 rounded-md border border-blue-500/40 bg-blue-500/10 px-2 py-1 text-[11.5px] font-medium text-blue-200 transition hover:bg-blue-500/20"
              >
                <Icon icon="heroicons:play-circle" className="text-xs" /> View video
              </button>
              {onAck && !acked && (
                <button
                  type="button"
                  onClick={onAck}
                  disabled={ackPending}
                  className="inline-flex items-center gap-1 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-[11.5px] text-emerald-300 transition hover:bg-emerald-500/20 disabled:opacity-50"
                >
                  <Icon icon="heroicons-outline:check" className="text-xs" /> Acknowledge
                </button>
              )}
              {onMute && (
                <button
                  type="button"
                  onClick={onMute}
                  title="Stop these corner alerts (Events keeps its own feed)"
                  aria-label="Mute event alerts"
                  className="ml-auto inline-flex h-6 w-6 items-center justify-center rounded-md text-muted transition hover:bg-hover hover:text-foreground"
                >
                  <Icon icon="heroicons-outline:bell-slash" className="text-xs" />
                </button>
              )}
            </div>
          </div>

          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss alert"
            className="-mr-1 -mt-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted transition hover:bg-hover hover:text-foreground"
          >
            <Icon icon="heroicons-outline:x-mark" className="text-sm" />
          </button>
        </div>
      </div>
    </div>
  );
}
