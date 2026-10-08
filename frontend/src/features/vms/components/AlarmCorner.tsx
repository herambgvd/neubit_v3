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
import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { setToastInset } from "@/lib/toastInset";

import AlarmNotification from "./AlarmNotification";
import { vms } from "../api";
import { clearAlarms, removeAlarm, useAlarmQueue, type QueuedAlarm } from "../alarmQueue";
import { EVENTS_ROUTE, setEventsMuted } from "../hooks/useEventNotifier";

export default function AlarmCorner() {
  const router = useRouter();
  const qc = useQueryClient();
  const up = useAlarmQueue().length > 0;
  const ref = useRef<HTMLDivElement>(null);

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
  const mute = () => {
    setEventsMuted(true);
    // Mute means stop interrupting me — the whole card goes.
    clearAlarms();
    toast("Event alerts muted", {
      description: "The Events page keeps its own live feed.",
      action: { label: "Undo", onClick: () => setEventsMuted(false) },
    });
  };

  return (
    // Sonner's corner offsets (24 px, 16 px on a phone), one layer under its
    // toaster: above the page and its dialogs, as the toast was.
    <div ref={ref} className="fixed bottom-4 right-4 z-[999999998] sm:bottom-6 sm:right-6">
      <AlarmNotification
        onView={(alarm) => {
          // Off to the monitoring surface, where every one of these is listed.
          clearAlarms();
          router.push(`${EVENTS_ROUTE}?event=${encodeURIComponent(alarm.key)}`);
        }}
        onAck={ack}
        onDismiss={(alarm) => removeAlarm(alarm.key)}
        onMute={mute}
      />
    </div>
  );
}
