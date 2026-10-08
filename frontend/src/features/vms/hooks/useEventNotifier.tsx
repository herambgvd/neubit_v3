"use client";

// THE OFF-PAGE HALF OF ALARM NOTIFICATION.
//
// Every enterprise VMS splits this the same way, and for the same reason:
//
//   * on the ALARM/MONITORING surface, an incoming alarm shows its VIDEO — the
//     operator is there to watch, so the console switches the canvas to it;
//   * ANYWHERE ELSE, it is a non-blocking notification in the corner that says
//     what and where, and takes one click to the monitoring surface. Never a modal
//     over another task: an operator configuring a schedule must not have a camera
//     thrown over their form.
//
// So this hook queues an alarm for the corner card (AlarmCorner) ONLY when the
// operator is not already on the Events page, where the same event is about to
// arrive at the top of the feed and (with auto-follow on) in the video pane.
// Toasting there too would be the console telling you twice about the thing you
// are looking at.
//
// It is deliberately NOT every event. `isAttentionSeverity` is the gate — a
// console that toasts a heartbeat teaches an operator to ignore toasts, which is
// the one failure mode that makes the whole mechanism worthless.
import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";

import { isAttentionSeverity } from "../constants";
import { normalizeVmsEvent } from "../eventLib";
import { pushAlarm } from "../alarmQueue";
import { useEstateCameras } from "./useEstateCameras";
import { useVmsEventStream } from "./useVmsEventStream";

/** The monitoring surface: on it, video replaces the toast. */
export const EVENTS_ROUTE = "/events";

/** Remembered per browser, because whether the corner is allowed to interrupt is
 *  an operator's preference, not a session's. */
const MUTE_KEY = "nb.events.muted";

export function eventsMuted(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(MUTE_KEY) === "1";
  } catch {
    return false; // a browser that blocks storage still gets notified
  }
}

export function setEventsMuted(muted: boolean): void {
  try {
    window.localStorage.setItem(MUTE_KEY, muted ? "1" : "0");
  } catch {
    /* storage blocked — the preference simply does not persist */
  }
}

export interface UseEventNotifierOptions {
  enabled?: boolean;
}

export function useEventNotifier({ enabled = true }: UseEventNotifierOptions = {}) {
  const pathname = usePathname();
  const seen = useRef(new Set<string>());
  // The estate roster, so the corner can name the camera and the recorder that
  // owns it. An event carries the NODE-SIDE camera id; without this the toast can
  // only print whatever name the frame happened to carry, or a uuid.
  const { cameras } = useEstateCameras();
  // The stream runs even while muted or on the Events page: dropping the
  // connection would lose the de-dupe set with it, and every event since would
  // toast the moment the operator navigated away.
  const { events } = useVmsEventStream({ enabled });

  const onEventsPage = pathname === EVENTS_ROUTE;

  useEffect(() => {
    if (!events.length) return;
    for (const frame of events) {
      const e = normalizeVmsEvent(frame);
      if (!e) continue;
      const key = e.event_id || e.id;
      if (!key || seen.current.has(key)) continue;
      seen.current.add(key);

      // Marked seen BEFORE these gates on purpose: an event that arrived while
      // the operator was on the Events page must not toast later, when they
      // navigate away and the buffer replays. They have already seen it.
      if (onEventsPage || eventsMuted()) continue;
      if (!isAttentionSeverity(e.severity)) continue;

      const cam = e.camera_id
        ? cameras.find(
            (c) => c.id === e.camera_id || (c as { real_id?: string }).real_id === e.camera_id,
          )
        : undefined;
      const where = cam?.name || e.camera_name || e.title || "an unnamed camera";
      const recorder = (cam as { node_name?: string } | undefined)?.node_name ?? null;
      // ONE card for the whole burst, not a toast per alarm (SCRUM-312): the
      // alarm joins the queue, and the card shows whatever the queue holds.
      pushAlarm({
        key,
        event: e,
        cameraName: where,
        recorderName: recorder,
        ackId: e.id || undefined,
        raisedAt: Date.now(),
      });
    }
  }, [events, onEventsPage, cameras]);
}

export default useEventNotifier;
