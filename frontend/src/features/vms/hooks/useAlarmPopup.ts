"use client";

// THE CLOCK AND THE PAGER OF AN ALARM POP-UP (SCRUM-312, SCRUM-327) — shared by the
// corner card on most pages and the alarm window on the Events page, so both close
// and page the same way.
//
// The pop-up closes itself:
//   * `closeAfterMs` after the alarm IN FRONT arrived — the operator's setting,
//     15 s unless they chose otherwise. The front is the worst, newest alarm
//     (alarmQueue), so a new alarm of the same priority or worse restarts the
//     wait, and a lesser one only raises the count;
//   * never while the pointer is over it or focus is in one of its controls — the
//     pause ends on the leave or blur of the pop-up's own element, which stays
//     mounted while alarms are paged, acked or dismissed, so the leave always
//     arrives;
//   * never while it holds a critical, when the operator keeps criticals up until
//     answered — Nx's forced acknowledgement, Genetec's rule that a live alarm is
//     never closed for you;
//   * never, when the operator chose "don't close".
// It says which of those it is doing — "Closes in 12 s", "Paused" — as plain text
// that changes once a second: a draining bar would be an animation, and the console
// has none. Closing is not acknowledging: the alarms stay unacknowledged on the
// Events page.
//
// A new alarm in front brings the pop-up to it — unless the operator is reading
// one (pointer or focus on the pop-up): then the count rises and what they are
// reading stays put.
import { useEffect, useState, type FocusEvent } from "react";

import { AUTO_HIDE_MS, clearAlarms, holdsCritical, useAlarmQueue, type QueuedAlarm } from "../alarmQueue";
import type { AlarmPager } from "../components/EventToast";
import { useTicker } from "./useTicker";

/** The least time a pop-up stays after the pointer or focus leaves it. */
export const LINGER_MS = 5_000;

export interface AlarmPopupOptions {
  /** How long it stays after the alarm in front arrived; null keeps it. */
  closeAfterMs?: number | null;
  /** A critical keeps it up until someone answers it. */
  criticalStays?: boolean;
}

function closingText(stays: "never" | "critical" | null, paused: boolean, leftMs: number): string {
  if (stays === "critical") return "Stays until answered";
  if (stays === "never") return "Stays open";
  if (paused) return "Paused";
  return `Closes in ${Math.max(1, Math.ceil(leftMs / 1000))} s`;
}

export function useAlarmPopup({ closeAfterMs = AUTO_HIDE_MS, criticalStays = true }: AlarmPopupOptions = {}) {
  const alarms = useAlarmQueue();
  const [viewKey, setViewKey] = useState<string | null>(null);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const paused = hovered || focused;

  // Adjusted during render (React's pattern for state that follows a prop), not in
  // an effect, so it never shows one frame of the old alarm.
  const newest = alarms[0]?.key ?? null;
  const [front, setFront] = useState(newest);
  if (front !== newest) {
    setFront(newest);
    if (!paused) setViewKey(null);
  }

  // Emptied under the pointer or the focus (Clear all, the last Dismiss): the
  // element is gone, so no leave will come, and the next pop-up must not start
  // out paused.
  const empty = alarms.length === 0;
  if (empty && hovered) setHovered(false);
  if (empty && focused) setFocused(false);

  const raisedAt = alarms[0]?.raisedAt ?? 0;
  // When the pointer or focus last left. Reading for 20 s and moving away must not
  // make the pop-up vanish under the operator's eyes the same instant.
  const [leftAt, setLeftAt] = useState(0);
  let stays: "never" | "critical" | null = null;
  if (criticalStays && holdsCritical(alarms)) stays = "critical";
  else if (closeAfterMs === null) stays = "never";
  const counting = !empty && !stays && !paused;
  const now = useTicker(1_000, counting);

  useEffect(() => {
    if (!counting || closeAfterMs === null) return;
    const at = Date.now();
    const wait = Math.max(0, closeAfterMs - (at - raisedAt), LINGER_MS - (at - leftAt));
    const t = setTimeout(clearAlarms, wait);
    return () => clearTimeout(t);
  }, [counting, raisedAt, leftAt, closeAfterMs]);

  const found = viewKey ? alarms.findIndex((a) => a.key === viewKey) : 0;
  const at = Math.max(0, found);
  const alarm: QueuedAlarm | undefined = alarms[at];

  // The ticker's last beat can predate the newest alarm or the pointer leaving;
  // the clock is never earlier than either.
  const clock = Math.max(now, raisedAt, leftAt);
  const full = closeAfterMs ?? 0;
  const left = Math.min(full, Math.max(full - (clock - raisedAt), LINGER_MS - (clock - leftAt)));
  const leave = () => setLeftAt(Date.now());

  const pager: AlarmPager = {
    index: at,
    total: alarms.length,
    onPrev: () => setViewKey(alarms[Math.max(0, at - 1)]?.key ?? null),
    onNext: () => setViewKey(alarms[Math.min(alarms.length - 1, at + 1)]?.key ?? null),
    onClearAll: clearAlarms,
  };

  /** The pause: spread on the pop-up's own outermost element. Focus on that
   *  element itself — where a dialog puts it when it opens — is not reading. */
  const bind = {
    onMouseEnter: () => setHovered(true),
    onMouseLeave: () => {
      setHovered(false);
      leave();
    },
    onFocus: (e: FocusEvent<HTMLElement>) => {
      if (e.target !== e.currentTarget) setFocused(true);
    },
    onBlur: (e: FocusEvent<HTMLElement>) => {
      if (e.currentTarget.contains(e.relatedTarget as Node | null) && e.relatedTarget !== e.currentTarget) return;
      setFocused(false);
      leave();
    },
  };

  return {
    alarms,
    alarm,
    pager,
    closing: closingText(stays, paused, left),
    /** Show this alarm. */
    view: (key: string) => setViewKey(key),
    bind,
  };
}
