"use client";

// THE ALARM WINDOW — how a new alarm opens on the Events page (SCRUM-327).
//
// HikCentral's Control Client and DSS open an alarm in a window in the middle of the
// monitoring screen, and what that window holds is what an operator needs to decide
// on the alarm without going anywhere else:
//   * WHAT, HOW BAD, WHERE, WHEN — the type, the severity, whether it is still
//     going on, the camera, its recorder and site, the clock time and its age;
//   * THE PICTURE, LARGE — the recording at the alarm (from a few seconds before
//     it), the camera live, or a plate read's snapshot: HikCentral's Picture /
//     Video / Live View tabs. A plate read adds the camera bound to the ANPR
//     camera, playing at the read;
//   * EVERY DETAIL — status, type, severity, start and duration, the recorder's
//     own reason, the plate with its list, confidence, vehicle and direction, and
//     the incident it already raised;
//   * WHAT TO DO — Acknowledge, Escalate to an incident, Investigate in Playback,
//     Show it in the panes, Dismiss; Silence when it rings;
//   * WHAT ELSE IS WAITING — the other alarms in the window, worst first, one
//     click each: one window pages a burst, never a stack of windows.
// The picture and the details are the Events page's own panes, handed in by the
// page, so the window and the panes can never disagree about an alarm.
//
// It is a dialog: the screen dims, focus moves into the window (onto the window
// itself, not a button an Enter could press by accident), and Esc or ✕ closes it.
// A stray click on the dim does not: an alarm window is not dismissed by accident.
// It closes on the operator's own clock like the corner card (useAlarmPopup) —
// paused while they point at it or work in it, held for a critical — and closing
// is not acknowledging: every alarm in it stays open in the list.
import { useCallback, useEffect, type ReactNode } from "react";
import { Icon } from "@iconify/react";

import { Overlay } from "@/components/ui/kit";

import { agoLabel, type AlarmSound } from "./EventToast";
import { clearAlarms, removeAlarm, type QueuedAlarm } from "../alarmQueue";
import { anprOf } from "../anprLib";
import { eventTypeLabel, fmtDate, fmtTime, sevPreset, typePreset } from "../eventLib";
import { eventInterval } from "../eventState";
import { useAlarmPopup } from "../hooks/useAlarmPopup";

const TITLE_ID = "nb-alarm-window-title";

/** How many of the other waiting alarms the window lists before "+N more". */
const WAITING_SHOWN = 6;

export interface AlarmWindowProps {
  /** How long it stays after the alarm in front arrived; null keeps it. */
  closeAfterMs?: number | null;
  /** A critical keeps it up until someone answers it. */
  criticalStays?: boolean;
  sound?: AlarmSound;
  /** Turn alert pop-ups off — the operator's own setting. */
  onMute: () => void;
  /** Close the window and show this alarm in the page's panes. */
  onShowInPanes: (alarm: QueuedAlarm) => void;
  /** The picture: the page's monitor pane for this alarm. */
  renderMedia: (alarm: QueuedAlarm) => ReactNode;
  /** The facts and the actions: the page's details pane for this alarm. */
  renderDetails: (alarm: QueuedAlarm) => ReactNode;
  /** More evidence under the picture — a plate read's linked camera. */
  renderExtra?: (alarm: QueuedAlarm) => ReactNode;
}

function Waiting({ alarms, current, onPick }: Readonly<{ alarms: QueuedAlarm[]; current: string; onPick: (key: string) => void }>) {
  const others = alarms.filter((a) => a.key !== current);
  if (!others.length) return null;
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-t border-card-border px-4 py-2">
      <span className="mr-1 text-[11px] text-muted">Also waiting ({others.length})</span>
      {others.slice(0, WAITING_SHOWN).map((a) => {
        const sp = sevPreset(a.event.severity);
        const plate = anprOf(a.event);
        return (
          <button
            key={a.key}
            type="button"
            onClick={() => onPick(a.key)}
            className="inline-flex max-w-[16rem] items-center gap-1.5 rounded-md border border-card-border px-2 py-1 text-[11px] text-muted transition hover:bg-hover hover:text-foreground"
          >
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${sp.dot}`} aria-hidden />
            <span className="truncate">
              {plate && !plate.noPlate ? plate.plate : eventTypeLabel(a.event.event_type)} · {a.cameraName}
            </span>
            <span className="shrink-0 tabular-nums">{fmtTime(a.event.occurred_at)}</span>
          </button>
        );
      })}
      {others.length > WAITING_SHOWN && (
        <span className="text-[11px] text-muted">+{others.length - WAITING_SHOWN} more</span>
      )}
    </div>
  );
}

export default function AlarmWindow({
  closeAfterMs,
  criticalStays,
  sound,
  onMute,
  onShowInPanes,
  renderMedia,
  renderDetails,
  renderExtra,
}: Readonly<AlarmWindowProps>) {
  const { alarms, alarm, pager, closing, view, bind } = useAlarmPopup({ closeAfterMs, criticalStays });
  const open = !!alarm;

  // Into the window when it opens, and back where the operator was when it closes.
  // A callback ref, because the Overlay portals in a render after this one: the
  // window exists only once it has mounted.
  const focusIn = useCallback((el: HTMLDialogElement | null) => el?.focus(), []);
  useEffect(() => {
    if (!open) return;
    const before = document.activeElement as HTMLElement | null;
    return () => before?.focus?.();
  }, [open]);

  if (!alarm) return null;
  const e = alarm.event;
  const sp = sevPreset(e.severity);
  const tp = typePreset(e.event_type);
  const iv = eventInterval(e);
  const plate = anprOf(e);
  const typeLabel = eventTypeLabel(e.event_type);
  const recorder = alarm.recorderName;
  const site = alarm.camera?.site_name && alarm.camera.site_name !== recorder ? alarm.camera.site_name : null;
  const ago = agoLabel(e.occurred_at, alarm.raisedAt);
  const critical = String(e.severity).toLowerCase() === "critical";
  const said = [`${sp.label}: ${typeLabel}`, plate && !plate.noPlate ? `plate ${plate.plate}` : null, alarm.cameraName]
    .filter(Boolean)
    .join(" — ");

  return (
    <Overlay onClose={clearAlarms} staticBackdrop>
      {/* Opened by attribute, not showModal(): the Overlay already dims the page and
          owns Esc, and a top-layer dialog would sit above the toaster's messages. */}
      <dialog
        ref={focusIn}
        open
        aria-modal="true"
        aria-labelledby={TITLE_ID}
        tabIndex={-1}
        {...bind}
        className="relative m-0 flex max-h-[94vh] w-[94vw] max-w-[1400px] flex-col overflow-hidden rounded-xl border border-card-border bg-card p-0 text-foreground shadow-2xl outline-none"
      >
        {critical ? (
          <p role="alert" className="sr-only">
            {said}
          </p>
        ) : (
          <output className="sr-only">{said}</output>
        )}
        {/* The severity as a colour before it is a word — read across a room. */}
        <span className={`h-1 w-full shrink-0 ${sp.band}`} aria-hidden />

        {/* WHAT, HOW BAD, WHERE, WHEN — and the window's own controls. */}
        <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-card-border px-4 py-3">
          <Icon icon={tp.icon} className={`text-xl ${sp.text}`} />
          <h2 id={TITLE_ID} className="text-[16px] font-semibold text-foreground">
            {plate && !plate.noPlate ? `${typeLabel} · ${plate.plate}` : typeLabel}
          </h2>
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${sp.cls}`}>{sp.label}</span>
          {iv.open && (
            <span className="inline-flex items-center gap-1 rounded-full bg-orange-500/15 px-2 py-0.5 text-[11px] font-semibold text-orange-300">
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-orange-400 opacity-70" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-orange-400" />
              </span>
              <span>Ongoing</span>
            </span>
          )}
          <span className="min-w-0 truncate text-[12.5px] text-foreground/90">
            {alarm.cameraName}
            {recorder && <span className="text-muted"> · {recorder}</span>}
            {site && <span className="text-muted"> · {site}</span>}
          </span>
          <span className="text-[12px] text-muted">
            <span className="tabular-nums">
              {fmtTime(e.occurred_at)} · {fmtDate(e.occurred_at)}
            </span>
            {ago && <> · {ago}</>}
          </span>

          <div className="ml-auto flex items-center gap-2 text-[11.5px] text-muted">
            {pager.total > 1 && (
              <span className="inline-flex items-center gap-1">
                <button
                  type="button"
                  onClick={pager.onPrev}
                  disabled={pager.index === 0}
                  aria-label="Previous alarm"
                  className="inline-flex h-6 w-6 items-center justify-center rounded hover:bg-hover hover:text-foreground disabled:opacity-30"
                >
                  <Icon icon="heroicons-outline:chevron-left" className="text-sm" />
                </button>
                <span className="tabular-nums">
                  {pager.index + 1} of {pager.total}
                </span>
                <button
                  type="button"
                  onClick={pager.onNext}
                  disabled={pager.index >= pager.total - 1}
                  aria-label="Next alarm"
                  className="inline-flex h-6 w-6 items-center justify-center rounded hover:bg-hover hover:text-foreground disabled:opacity-30"
                >
                  <Icon icon="heroicons-outline:chevron-right" className="text-sm" />
                </button>
              </span>
            )}
            <span className="whitespace-nowrap tabular-nums">{closing}</span>
            <button
              type="button"
              onClick={clearAlarms}
              aria-label="Close the alarm window"
              title="Close — every alarm in it stays open in the list"
              className="inline-flex h-7 w-7 items-center justify-center rounded-md transition hover:bg-hover hover:text-foreground"
            >
              <Icon icon="heroicons-outline:x-mark" className="text-lg" />
            </button>
          </div>
        </header>

        {/* THE PICTURE beside EVERY DETAIL, sized by the screen rather than the text
            size, so the window stays large on a compact console. Keyed per alarm:
            paging starts the next one's players and facts fresh. */}
        <div
          key={alarm.key}
          className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-y-auto p-3 lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]"
        >
          <div className="flex min-w-0 flex-col gap-3">
            <div className="h-[min(56vh,560px)] min-h-[18rem]">{renderMedia(alarm)}</div>
            {renderExtra?.(alarm)}
          </div>
          <div className="min-h-[18rem] min-w-0">{renderDetails(alarm)}</div>
        </div>

        <Waiting alarms={alarms} current={alarm.key} onPick={view} />

        <footer className="flex shrink-0 flex-wrap items-center gap-2 border-t border-card-border px-4 py-2.5">
          {sound?.held && (
            <button
              type="button"
              onClick={sound.onEnable}
              title="The browser plays sound only after a click in the console"
              className="inline-flex items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-[12px] text-amber-200 transition hover:bg-amber-500/20"
            >
              <Icon icon="heroicons-outline:speaker-wave" className="text-sm" /> Enable sound
            </button>
          )}
          {sound?.ringing && (
            <button
              type="button"
              onClick={sound.onSilence}
              title="Stop the ringing — the next new alarm rings again"
              className="inline-flex items-center gap-1.5 rounded-md border border-card-border px-2.5 py-1.5 text-[12px] text-muted transition hover:bg-hover hover:text-foreground"
            >
              <Icon icon="heroicons-outline:speaker-x-mark" className="text-sm" /> Silence
            </button>
          )}
          <button
            type="button"
            onClick={onMute}
            title="Turn alert pop-ups off — the Events page keeps every alarm"
            aria-label="Turn alert pop-ups off"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted transition hover:bg-hover hover:text-foreground"
          >
            <Icon icon="heroicons-outline:bell-slash" className="text-sm" />
          </button>

          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={() => removeAlarm(alarm.key)}
              title="Take this alarm out of the window — it stays open in the list"
              className="rounded-md border border-card-border px-3 py-1.5 text-[12px] text-muted transition hover:bg-hover hover:text-foreground"
            >
              Dismiss
            </button>
            <button
              type="button"
              onClick={() => onShowInPanes(alarm)}
              className="inline-flex items-center gap-1.5 rounded-md border border-blue-500/40 bg-blue-500/10 px-3 py-1.5 text-[12px] font-medium text-blue-200 transition hover:bg-blue-500/20"
            >
              <Icon icon="heroicons-outline:rectangle-group" className="text-sm" /> Show in panes
            </button>
          </div>
        </footer>
      </dialog>
    </Overlay>
  );
}
