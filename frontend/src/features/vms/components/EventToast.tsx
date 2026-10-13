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
// AND A PICTURE, AND A CLOCK (SCRUM-327): the pop-up leads with the alarm's
// picture when there is one (AlarmMedia), the way HikCentral's alarm window does,
// and says when it will close.
//
// It is a labelled region, not an alert: an alert role would read the whole card
// out again every time its countdown ticked. The announcement is a separate line
// only a screen reader sees — assertive for a critical, polite for an alarm — and
// focus is never taken: the operator may be typing somewhere else.
//
// Nothing here is invented: a field the recorder did not send is simply absent.
import { useState, type ReactNode } from "react";
import { Icon } from "@iconify/react";

import { eventTypeLabel, fmtTime, sevPreset, typePreset, type NormalizedVmsEvent } from "../eventLib";
import { eventInterval, formatDuration } from "../eventState";
import { anprOf } from "../anprLib";
import { AnprAlertPlate } from "./AnprEvidence";

export interface EventToastProps {
  event: NormalizedVmsEvent;
  cameraName: string;
  recorderName?: string | null;
  siteName?: string | null;
  /** The alarm's picture: a live view, the plate read's still. */
  media?: ReactNode;
  /** Open this event — the Events page, or its panes when already there. */
  onView: () => void;
  /** The view button's words. */
  viewLabel?: string;
  /** Acknowledge in place; absent when the event carries no id to ack. */
  onAck?: () => void;
  acked?: boolean;
  ackPending?: boolean;
  /** Stop the corner interrupting — the operator's own preference. */
  onMute?: () => void;
  /** The alert tone's switch, when the card offers it. */
  sound?: AlarmSound;
  onDismiss: () => void;
  /** Where this alarm sits in the corner card's queue. Present only while the
   *  card holds more than one: a burst is ONE card paged ‹ 1 of N ›, not a stack
   *  (SCRUM-312). */
  pager?: AlarmPager;
  /** When the card will close — "Closes in 12 s", "Stays until answered". */
  closing?: string;
  /** Injectable for tests; defaults to the moment the toast was raised. */
  now?: number;
}

export interface AlarmSound {
  /** On, but the browser is still holding sound back until a click. */
  held: boolean;
  /** A critical on the card is ringing again and again. */
  ringing: boolean;
  /** Quiet what is ringing now; the next new alarm rings again. */
  onSilence: () => void;
  onEnable: () => void;
}

export interface AlarmPager {
  /** 0-based, newest first. */
  index: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
  /** Close the card and everything queued in it. */
  onClearAll: () => void;
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
  siteName = null,
  media,
  onView,
  viewLabel = "View video",
  onAck,
  acked = false,
  ackPending = false,
  onMute,
  sound,
  onDismiss,
  pager,
  closing,
  now,
}: Readonly<EventToastProps>) {
  // Lazily, once: a Date.now() in the render body is a different answer every
  // render, so "just now" could change while nothing about the alarm did.
  const [raisedAt] = useState(() => Date.now());
  const sp = sevPreset(event.severity);
  const tp = typePreset(event.event_type);
  const iv = eventInterval(event);
  const ago = agoLabel(event.occurred_at, now ?? raisedAt);
  const plate = anprOf(event);
  const typeLabel = eventTypeLabel(event.event_type);
  // The rule's own words when they say more than the type and the camera do; a
  // plate read's title is its plate, which the plate block already leads with.
  const norm = (v: string | null | undefined) => (v ?? "").trim().toLowerCase();
  const title =
    !plate && event.title && ![norm(typeLabel), norm(cameraName)].includes(norm(event.title)) ? event.title.trim() : null;
  // A site named after its only recorder says the same thing twice.
  const site = siteName && norm(siteName) !== norm(recorderName) ? siteName : null;
  const said = [`${sp.label}: ${typeLabel}`, plate && !plate.noPlate ? `plate ${plate.plate}` : null, cameraName]
    .filter(Boolean)
    .join(" — ");
  const paged = !!pager && pager.total > 1;

  return (
    <section
      aria-label={`${sp.label} alarm: ${typeLabel}`}
      className={`flex ${media ? "w-[25rem]" : "w-[22rem]"} max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-xl border border-card-border bg-card shadow-xl`}
    >
      {String(event.severity).toLowerCase() === "critical" ? (
        <p role="alert" className="sr-only">
          {said}
        </p>
      ) : (
        <output className="sr-only">{said}</output>
      )}
      {media}
      <div className="flex min-w-0">
        {/* The severity as a colour before it is a word — read across a room. */}
        <span className={`w-1 shrink-0 ${sp.band}`} aria-hidden />

        <div className="min-w-0 flex-1 px-3 py-2.5">
          <div className="flex items-start gap-2">
            <Icon icon={tp.icon} className={`mt-0.5 shrink-0 text-base ${sp.text}`} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-[13px] font-semibold text-foreground">{typeLabel}</span>
                <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${sp.cls}`}>
                  {sp.label}
                </span>
                {iv.open && (
                  <span className="shrink-0 inline-flex items-center gap-1 rounded-full bg-orange-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-orange-300">
                    <span className="relative flex h-1.5 w-1.5">
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-orange-400 opacity-70" />
                      <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-orange-400" />
                    </span>
                    <span>Ongoing</span>
                  </span>
                )}
              </div>

              {title && <p className="mt-0.5 truncate text-[12px] text-foreground">{title}</p>}

              {/* A plate read leads with the plate: which vehicle, and the list it hit. */}
              {plate && <AnprAlertPlate anpr={plate} />}

              {/* WHERE and WHEN, on one line — the two questions that follow "what". */}
              <p className="mt-0.5 truncate text-[12px] text-foreground/90">
                {cameraName}
                {recorderName && <span className="text-muted"> · {recorderName}</span>}
                {site && <span className="text-muted"> · {site}</span>}
              </p>
              <p className="mt-0.5 text-[11px] text-muted">
                <span className="font-mono">{fmtTime(event.occurred_at)}</span>
                {ago && <> · {ago}</>}
                {acked && <span className="text-emerald-400"> · acknowledged</span>}
              </p>

              {event.description && (
                <p className="mt-1 line-clamp-2 text-[11.5px] text-muted">{event.description}</p>
              )}

              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={onView}
                  className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md border border-blue-500/40 bg-blue-500/10 px-2 py-1 text-[11.5px] font-medium text-blue-200 transition hover:bg-blue-500/20"
                >
                  <Icon icon="heroicons:play-circle" className="text-xs" /> {viewLabel}
                </button>
                {onAck && !acked && (
                  <button
                    type="button"
                    onClick={onAck}
                    disabled={ackPending}
                    className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-[11.5px] text-emerald-300 transition hover:bg-emerald-500/20 disabled:opacity-50"
                  >
                    <Icon icon="heroicons-outline:check" className="text-xs" /> Acknowledge
                  </button>
                )}
                {sound?.held && (
                  <button
                    type="button"
                    onClick={sound.onEnable}
                    title="The browser plays sound only after a click in the console"
                    className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[11.5px] text-amber-200 transition hover:bg-amber-500/20"
                  >
                    <Icon icon="heroicons-outline:speaker-wave" className="text-xs" /> Enable sound
                  </button>
                )}
                <div className="ml-auto flex shrink-0 items-center gap-1">
                  {sound?.ringing && (
                    <button
                      type="button"
                      onClick={sound.onSilence}
                      title="Stop the ringing — the next new alarm rings again"
                      className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-1 text-[11px] text-muted transition hover:bg-hover hover:text-foreground"
                    >
                      <Icon icon="heroicons-outline:speaker-x-mark" className="text-xs" /> Silence
                    </button>
                  )}
                  {onMute && (
                    <button
                      type="button"
                      onClick={onMute}
                      title="Turn alert pop-ups off — the Events page keeps every alarm"
                      aria-label="Turn alert pop-ups off"
                      className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted transition hover:bg-hover hover:text-foreground"
                    >
                      <Icon icon="heroicons-outline:bell-slash" className="text-xs" />
                    </button>
                  )}
                </div>
              </div>

              {(paged || closing) && (
                <div className="mt-2 flex items-center gap-1 border-t border-card-border pt-1.5 text-[11px] text-muted">
                  {pager && paged && (
                    <>
                      <button
                        type="button"
                        onClick={pager.onPrev}
                        disabled={pager.index === 0}
                        aria-label="Newer alarm"
                        className="inline-flex h-5 w-5 items-center justify-center rounded hover:bg-hover hover:text-foreground disabled:opacity-30"
                      >
                        <Icon icon="heroicons-outline:chevron-left" className="text-xs" />
                      </button>
                      <span className="tabular-nums">
                        {pager.index + 1} of {pager.total}
                      </span>
                      <button
                        type="button"
                        onClick={pager.onNext}
                        disabled={pager.index >= pager.total - 1}
                        aria-label="Older alarm"
                        className="inline-flex h-5 w-5 items-center justify-center rounded hover:bg-hover hover:text-foreground disabled:opacity-30"
                      >
                        <Icon icon="heroicons-outline:chevron-right" className="text-xs" />
                      </button>
                    </>
                  )}
                  {closing && <span className="ml-auto whitespace-nowrap tabular-nums">{closing}</span>}
                  {pager && paged && (
                    <button
                      type="button"
                      onClick={pager.onClearAll}
                      className={`${closing ? "ml-1.5" : "ml-auto"} whitespace-nowrap rounded-md px-1.5 py-0.5 hover:bg-hover hover:text-foreground`}
                    >
                      Clear all ({pager.total})
                    </button>
                  )}
                </div>
              )}
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
    </section>
  );
}
