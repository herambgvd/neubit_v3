"use client";

// ALARM NOTIFICATION — the pop-up and the tone, on every page.
//
// Off the Events page an alarm is a non-blocking card in the corner that says what,
// where and when, and takes one click to the monitoring surface. Never a modal over
// another task: an operator configuring a schedule must not have a camera thrown
// over their form.
//
// ON THE EVENTS PAGE IT POPS UP TOO (SCRUM-327). It used to be left to the feed and
// the auto-following panes, on the reasoning that the operator was already looking.
// They often are not looking at THAT: they are reading another event, scrolling the
// table, or have turned auto-follow off — and HikCentral's and DSS's alarm window
// opens in the middle of their monitoring screen for exactly that reason. There the
// alarm opens in that window (AlarmWindow), large, with its recording, live view and
// every detail. An operator who would rather keep the page to its feed gets the
// corner card there instead.
//
// It is deliberately NOT every event. The operator's alert settings decide
// (alertPrefs.ts): alarms and criticals by default, criticals only if they ask,
// and plate reads by their own rule (every alerting read, block-list hits only,
// none). A console that toasts a heartbeat teaches an operator to ignore toasts,
// which is the one failure mode that makes the whole mechanism worthless.
//
// THE TONE (SCRUM-326) follows the same rule and sounds on EVERY page, the Events
// page included: there the video takes the panes, but an operator looking at the
// other monitor still has to be told. A burst rings once, at its worst severity,
// in the sound the operator picked for it; a repeat, when they keep one, carries
// on from there (EventNotifierHost).
import { useEffect, useRef } from "react";

import { normalizeVmsEvent } from "../eventLib";
import { pushAlarm } from "../alarmQueue";
import { alertToneFor, soundActive, soundFor, useAlertPrefs } from "../alertPrefs";
import { playAlertTone, type AlertTone } from "../alertSound";
import { useEstateCameras } from "./useEstateCameras";
import { useVmsEventStream } from "./useVmsEventStream";

/** The monitoring surface: its alarms open in the alarm window. */
export const EVENTS_ROUTE = "/events";

/** A burst within this window rings once. */
const RING_GAP_MS = 1_500;

export interface UseEventNotifierOptions {
  enabled?: boolean;
}

export function useEventNotifier({ enabled = true }: UseEventNotifierOptions = {}) {
  const seen = useRef(new Set<string>());
  // The estate roster, so the corner can name the camera and the recorder that
  // owns it. An event carries the NODE-SIDE camera id; without this the toast can
  // only print whatever name the frame happened to carry, or a uuid.
  const { cameras } = useEstateCameras();
  // The stream runs even while pop-ups and sound are off: dropping the connection
  // would lose the de-dupe set with it, and every event since would pop up the
  // moment the operator turned them back on.
  const { events } = useVmsEventStream({ enabled });
  const { prefs } = useAlertPrefs();
  const lastRing = useRef(0);

  useEffect(() => {
    if (!events.length) return;
    let ring: AlertTone | null = null;
    for (const frame of events) {
      const e = normalizeVmsEvent(frame);
      if (!e) continue;
      const key = e.event_id || e.id;
      if (!key || seen.current.has(key)) continue;
      seen.current.add(key);

      // Marked seen BEFORE these gates on purpose: an event that arrived while the
      // operator kept it quiet must not pop up later, when the settings change and
      // the buffer replays. It has had its moment.
      const tone = alertToneFor(e, prefs);
      if (!tone) continue;
      if (ring !== "critical") ring = tone;
      // Where it shows — the corner card, or the Events page's alarm window — is the
      // pop-up's business (AlarmCorner, AlarmWindow); whether it shows is the operator's.
      if (!prefs.popup) continue;

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
        camera: cam ?? null,
        ackId: e.id || undefined,
        raisedAt: Date.now(),
      });
    }
    const now = Date.now();
    if (ring && soundActive(prefs, now) && now - lastRing.current >= RING_GAP_MS) {
      lastRing.current = now;
      playAlertTone(ring, prefs.volume, soundFor(prefs, ring));
    }
  }, [events, cameras, prefs]);
}

export default useEventNotifier;
