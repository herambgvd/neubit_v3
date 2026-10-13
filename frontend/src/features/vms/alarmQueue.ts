// THE ALARMS THE CORNER CARD IS HOLDING.
//
// The corner used to raise one sonner toast per alarm. A burst — a recorder
// losing its uplink fires one per channel — became a stack, and two things went
// wrong with it (SCRUM-312):
//
//   * SPACE. Sonner sizes every slot of a collapsed stack to the FRONT toast, and
//     the front one was taller (it carried "Clear all"), so each card behind it
//     sat in a slot ~30 px too tall and the expanded stack spread out to match.
//   * TOASTS THAT NEVER LEFT. Sonner pauses every timer while its stack is
//     expanded, and it expands on hover. Dismiss the toast under the cursor and
//     the browser never sends the stack its mouseleave — so it stayed expanded,
//     and every timer in it stayed paused, until the next hover happened to fix it.
//
// Industry practice answers both at once: Milestone's Smart Client shows ONE
// desktop notification for alarms that arrive within seconds of each other, and
// closes it after 15 s. So the corner is now one card over this queue, paged
// ‹ 1 of N ›, with its own timer (see AlarmNotification).
//
// THE ORDER IS PRIORITY, THEN NEWEST (SCRUM-327) — Genetec's and Avigilon's: a
// critical goes in front of every alarm, and among equals the newest leads. So an
// alarm arriving under a critical only raises the count; it never takes the card
// away from the critical an operator is reading.
import { useSyncExternalStore } from "react";

import type { AlertTone } from "./alertSound";
import { sevPreset, type NormalizedVmsEvent } from "./eventLib";
import type { EstateCamera } from "./types";

export interface QueuedAlarm {
  /** The event's identity — the same key the notifier de-dupes on. */
  key: string;
  event: NormalizedVmsEvent;
  cameraName: string;
  recorderName: string | null;
  /** The estate's camera, for the card's live picture; absent when unknown. */
  camera?: EstateCamera | null;
  /** The row id the ack API takes; absent when the frame carried none. */
  ackId?: string;
  /** When the corner learned of it, for the auto-hide clock. */
  raisedAt: number;
  /** The operator silenced its repeating tone (SCRUM-326): it stays on the card,
   *  quiet, and the next new alarm rings again. */
  silenced?: boolean;
}

/** Milestone's figure for a desktop alarm notification. */
export const AUTO_HIDE_MS = 15_000;

/** Enough to page through a burst; past this the Events page is the tool. */
export const MAX_QUEUED = 99;

let queue: QueuedAlarm[] = [];
const subscribers = new Set<() => void>();

function set(next: QueuedAlarm[]): void {
  queue = next;
  for (const fn of subscribers) fn();
}

function subscribe(fn: () => void): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

/** The queue, newest first. A stable reference between changes. */
export function alarmQueue(): QueuedAlarm[] {
  return queue;
}

const rank = (a: QueuedAlarm) => sevPreset(String(a.event.severity || "").toLowerCase()).rank;

/** Queue an alarm in front of every alarm of its priority or below. */
export function pushAlarm(alarm: QueuedAlarm): void {
  if (queue.some((a) => a.key === alarm.key)) return;
  const at = queue.findIndex((a) => rank(a) <= rank(alarm));
  const next = [...queue];
  next.splice(at === -1 ? next.length : at, 0, alarm);
  set(next.slice(0, MAX_QUEUED));
}

export function removeAlarm(key: string): void {
  if (!queue.some((a) => a.key === key)) return;
  set(queue.filter((a) => a.key !== key));
}

export function clearAlarms(): void {
  if (queue.length) set([]);
}

/** Silence what is ringing now — Genetec's "mute all alarms": the card keeps every
 *  alarm, and the next new one rings again. */
export function silenceAlarms(): void {
  if (queue.some((a) => !a.silenced)) set(queue.map((a) => (a.silenced ? a : { ...a, silenced: true })));
}

/** The priority that keeps ringing: the worst one still waiting for an answer that
 *  nobody has silenced, when the operator repeats that priority. */
export function ringingTone(
  alarms: readonly QueuedAlarm[],
  repeat: { repeatCritical: boolean; repeatAlarm: boolean },
): AlertTone | null {
  const waiting = alarms.filter((a) => !a.silenced);
  if (repeat.repeatCritical && waiting.some((a) => rank(a) >= sevPreset("critical").rank)) return "critical";
  if (repeat.repeatAlarm && waiting.some((a) => rank(a) === sevPreset("alarm").rank)) return "alarm";
  return null;
}

/** A critical alarm waits for a decision; anything else leaves on its own. */
export function holdsCritical(alarms: readonly QueuedAlarm[]): boolean {
  return alarms.some((a) => rank(a) >= sevPreset("critical").rank);
}

export function useAlarmQueue(): QueuedAlarm[] {
  return useSyncExternalStore(subscribe, alarmQueue, alarmQueue);
}
