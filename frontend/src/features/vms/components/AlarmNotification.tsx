"use client";

// THE CORNER ALARM CARD — one card over the whole alarm queue (SCRUM-312, SCRUM-327).
//
// It replaces a stack of one sonner toast per alarm. A stack left gaps (sonner
// sizes every slot to the front toast) and could stop every timer in it (sonner
// pauses them while the stack is expanded, and a dismissed toast under the cursor
// left it expanded). Milestone's Smart Client shows one notification for alarms
// that arrive together and closes it after 15 s; this is that card, paged ‹ 1 of N ›,
// with the alarm's picture. AlarmCorner puts it on the screen; on the Events page
// the alarm window takes its place (AlarmWindow).
//
// Its clock and pager are the pop-up's (useAlarmPopup): it closes on the operator's
// own time, waits while it is pointed at or a control in it has focus, holds a
// critical until answered, and says which. Esc, with focus in the card, closes the
// alarm on show.
import { useEffect, useRef, type ReactNode } from "react";

import EventToast, { type AlarmSound } from "./EventToast";
import type { QueuedAlarm } from "../alarmQueue";
import { useAlarmPopup } from "../hooks/useAlarmPopup";

export { LINGER_MS } from "../hooks/useAlarmPopup";

export interface AlarmNotificationProps {
  /** Open the Events page on this alarm. */
  onView: (alarm: QueuedAlarm) => void;
  /** The view button's words. */
  viewLabel?: string;
  /** Acknowledge it on the server; the card has already let go of it. */
  onAck: (alarm: QueuedAlarm) => void;
  /** Take this alarm off the card. */
  onDismiss: (alarm: QueuedAlarm) => void;
  onMute: () => void;
  /** The alert tone's switch on the card: mute it, or let the browser play it. */
  sound?: AlarmSound;
  /** How long the card stays after the alarm in front arrived; null keeps it. */
  closeAfterMs?: number | null;
  /** A critical keeps the card up until someone answers it. */
  criticalStays?: boolean;
  /** The picture for the alarm on show. */
  media?: (alarm: QueuedAlarm) => ReactNode;
}

export default function AlarmNotification({
  onView,
  viewLabel,
  onAck,
  onDismiss,
  onMute,
  sound,
  closeAfterMs,
  criticalStays,
  media,
}: Readonly<AlarmNotificationProps>) {
  const { alarm, pager, closing, bind } = useAlarmPopup({ closeAfterMs, criticalStays });

  // Esc closes the alarm on show — while focus is in the card, never from a field
  // elsewhere on the page.
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!alarm) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && ref.current?.contains(document.activeElement)) onDismiss(alarm);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [alarm, onDismiss]);

  if (!alarm) return null;

  return (
    <div ref={ref} {...bind}>
      <EventToast
        // Remounted per alarm, so its "just now" is measured from that alarm.
        key={alarm.key}
        event={alarm.event}
        cameraName={alarm.cameraName}
        recorderName={alarm.recorderName}
        siteName={alarm.camera?.site_name ?? null}
        media={media?.(alarm)}
        onView={() => onView(alarm)}
        viewLabel={viewLabel}
        onAck={alarm.ackId ? () => onAck(alarm) : undefined}
        onMute={onMute}
        sound={sound}
        closing={closing}
        onDismiss={() => onDismiss(alarm)}
        pager={pager}
      />
    </div>
  );
}
