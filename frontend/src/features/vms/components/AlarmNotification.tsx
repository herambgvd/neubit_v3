"use client";

// THE CORNER ALARM CARD — one card over the whole alarm queue (SCRUM-312).
//
// It replaces a stack of one sonner toast per alarm. A stack left gaps (sonner
// sizes every slot to the front toast) and could stop every timer in it (sonner
// pauses them while the stack is expanded, and a dismissed toast under the cursor
// left it expanded). Milestone's Smart Client shows one notification for alarms
// that arrive together and closes it after 15 s; this is that card. AlarmCorner
// puts it on the screen — not sonner, whose hover-expand clipped it (see there).
//
// THE CLOCK IS OURS. The card closes itself:
//   * 15 s after the NEWEST alarm arrived — a new alarm restarts the wait, so an
//     operator always gets the full time to read the latest one;
//   * never while the pointer is over it — the pause ends on mouseleave of THIS
//     element, which stays mounted while alarms are paged, acked or dismissed, so
//     the leave always arrives;
//   * never while it holds a critical: that waits for a decision.
// The alarms themselves are not lost when it closes: they are on the Events page.
import { useEffect, useState } from "react";

import EventToast from "./EventToast";
import { AUTO_HIDE_MS, clearAlarms, holdsCritical, useAlarmQueue, type QueuedAlarm } from "../alarmQueue";

/** The least time the card stays after the pointer leaves it. */
export const LINGER_MS = 5_000;

export interface AlarmNotificationProps {
  /** Open the Events page on this alarm. */
  onView: (alarm: QueuedAlarm) => void;
  /** Acknowledge it on the server; the card has already let go of it. */
  onAck: (alarm: QueuedAlarm) => void;
  /** Take this alarm off the card. */
  onDismiss: (alarm: QueuedAlarm) => void;
  onMute: () => void;
}

export default function AlarmNotification({ onView, onAck, onDismiss, onMute }: Readonly<AlarmNotificationProps>) {
  const alarms = useAlarmQueue();
  const [index, setIndex] = useState(0);
  const [hovered, setHovered] = useState(false);

  // A new alarm brings the card back to the front: the newest is the one the
  // operator needs to see. Adjusted during render (React's pattern for state that
  // follows a prop), not in an effect, so it never shows one frame of the old one.
  const newest = alarms[0]?.key ?? null;
  const [front, setFront] = useState(newest);
  if (front !== newest) {
    setFront(newest);
    setIndex(0);
  }

  // Emptied under the pointer (Clear all, the last Dismiss): the element is gone,
  // so no mouseleave will come, and the next card must not start out paused.
  const empty = alarms.length === 0;
  if (empty && hovered) setHovered(false);

  const raisedAt = alarms[0]?.raisedAt ?? 0;
  // When the pointer last left the card. Reading for 20 s and moving away must
  // not make the card vanish under the operator's eyes the same instant.
  const [leftAt, setLeftAt] = useState(0);
  const stays = hovered || holdsCritical(alarms);
  useEffect(() => {
    if (empty || stays) return;
    const now = Date.now();
    const wait = Math.max(0, AUTO_HIDE_MS - (now - raisedAt), LINGER_MS - (now - leftAt));
    const t = setTimeout(clearAlarms, wait);
    return () => clearTimeout(t);
  }, [empty, stays, raisedAt, leftAt]);

  if (empty) return null;
  const at = Math.min(index, alarms.length - 1);
  const alarm = alarms[at];

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => {
        setHovered(false);
        setLeftAt(Date.now());
      }}
    >
      <EventToast
        // Remounted per alarm, so its "just now" is measured from that alarm.
        key={alarm.key}
        event={alarm.event}
        cameraName={alarm.cameraName}
        recorderName={alarm.recorderName}
        onView={() => onView(alarm)}
        onAck={alarm.ackId ? () => onAck(alarm) : undefined}
        onMute={onMute}
        onDismiss={() => onDismiss(alarm)}
        pager={{
          index: at,
          total: alarms.length,
          onPrev: () => setIndex(Math.max(0, at - 1)),
          onNext: () => setIndex(Math.min(alarms.length - 1, at + 1)),
          onClearAll: clearAlarms,
        }}
      />
    </div>
  );
}
