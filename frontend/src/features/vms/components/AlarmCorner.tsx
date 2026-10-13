"use client";

// WHERE THE ALARM CARD LIVES: the bottom-right corner, on the console's own terms.
//
// It used to be a sonner toast, and sonner measures a toast's height once, when it
// mounts. The card grows after that — the pager row appears when a second alarm
// queues — and on hover sonner "expands" its stack and pins every toast to the
// height it measured, so the grown card was cut off at the bottom of the screen.
// Sonner also applies a dismiss on an animation frame, which a background tab
// never runs. The card already kept its own clock, paging and dismissal, so the
// toaster had nothing left to give it but those faults; it now sits here, sized
// by its content, and the toaster's other messages sit above it (lib/toastInset).
//
// NOT ON THE EVENTS PAGE (SCRUM-327): there the alarm opens in the middle of the
// screen, large, with its recording, live view and every detail — the alarm window
// HikCentral and DSS open on their monitoring screens (AlarmWindow, which the page
// itself renders, because it reuses the page's own panes and actions). An operator
// who keeps that page to its feed gets this card there instead.
import { useEffect, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { setToastInset } from "@/lib/toastInset";

import AlarmMedia from "./AlarmMedia";
import AlarmNotification from "./AlarmNotification";
import { vms } from "../api";
import { clearAlarms, removeAlarm, useAlarmQueue, type QueuedAlarm } from "../alarmQueue";
import { EVENTS_ROUTE } from "../hooks/useEventNotifier";
import { useAlarmPopupSettings } from "../hooks/useAlarmPopupSettings";

const media = (alarm: QueuedAlarm) => <AlarmMedia alarm={alarm} />;

export default function AlarmCorner() {
  const router = useRouter();
  const onEvents = usePathname() === EVENTS_ROUTE;
  const qc = useQueryClient();
  const alarms = useAlarmQueue();
  const ref = useRef<HTMLDivElement>(null);
  const popup = useAlarmPopupSettings();
  // On the Events page the alarm window shows the queue.
  const up = alarms.length > 0 && !(onEvents && popup.prefs.popupOnEvents);

  // Tell the toaster how much of the corner the card takes, and keep telling it
  // as the card grows or shrinks (pager row, a wrapped description).
  useEffect(() => {
    const el = ref.current;
    if (!up || !el) return;
    const report = () => setToastInset(el.offsetHeight);
    report();
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(report);
    ro?.observe(el);
    return () => {
      ro?.disconnect();
      setToastInset(0);
    };
  }, [up]);

  if (!up) return null;

  const ack = (alarm: QueuedAlarm) => {
    // Optimistic on purpose: the card lets go before the round trip, and a
    // failure says so in its own toast.
    removeAlarm(alarm.key);
    if (!alarm.ackId) return;
    vms.events
      .ack(alarm.ackId)
      .then(() => qc.invalidateQueries({ queryKey: ["vms-events"] }))
      .catch(() => toast.error(`Could not acknowledge ${alarm.cameraName}`));
  };

  return (
    // Sonner's corner offsets (24 px, 16 px on a phone), one layer under its
    // toaster: above the page and its dialogs, as the toast was.
    <div ref={ref} className="fixed bottom-4 right-4 z-[999999998] sm:bottom-6 sm:right-6">
      <AlarmNotification
        viewLabel="Open in Events"
        onView={(alarm) => {
          // Off to the monitoring surface, where every one of these is listed.
          clearAlarms();
          router.push(`${EVENTS_ROUTE}?event=${encodeURIComponent(alarm.key)}`);
        }}
        onAck={ack}
        onDismiss={(alarm) => removeAlarm(alarm.key)}
        onMute={popup.mute}
        closeAfterMs={popup.closeAfterMs}
        criticalStays={popup.criticalStays}
        media={media}
        sound={popup.sound}
      />
    </div>
  );
}
