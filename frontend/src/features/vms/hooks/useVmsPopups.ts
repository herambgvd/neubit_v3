"use client";

// Operator-popup consumer — the tab's one shared realtime connection (vmsRealtime.ts),
// routing the `vms.popup` frames (published by the P5-B linkage `popup` action on
// `tenant.<id>.vms.popup`). Each popup carries { camera_id, reason, event_id,
// event_type, severity }. This hook fires a toast per popup and maintains a small
// queue of ACTIVE popups (a floating LivePlayer for the camera) that the app-wide
// VmsPopupHost renders. Dismiss/acknowledge removes a popup from the queue.
//
// Mounted ONCE app-wide (VmsPopupHost) so popups surface on any VMS surface without
// each page wiring its own stream. Non-intrusive: toast + a dismissible camera pop,
// capped so a burst can't flood the screen.
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import type { VmsPopupFrame } from "../types";
import { subscribeVmsRealtime } from "./vmsRealtime";

/** A popup in the active queue: the frame plus its de-dupe key. */
export type ActivePopup = VmsPopupFrame & { key: string };

// Cap concurrent camera-pops so a burst of popups can't cover the whole screen.
const MAX_ACTIVE = 3;

export function useVmsPopups({ enabled = true }: { enabled?: boolean } = {}) {
  const [active, setActive] = useState<ActivePopup[]>([]); // [{ key, camera_id, reason, event_type, severity, occurred_at }]
  const seenRef = useRef(new Set<string>());

  useEffect(() => {
    if (!enabled) return;
    const push = (p: VmsPopupFrame) => {
      // Dedupe by event_id (a rule + a manual re-fire could double up).
      const key = p.event_id || `${p.camera_id}:${p.occurred_at}:${p.event_type}`;
      if (key && seenRef.current.has(key)) return;
      if (key) seenRef.current.add(key);

      const reason = p.reason || `${p.event_type || "Event"} on camera`;
      toast.warning("Camera popup", {
        description: reason,
        duration: 7000,
      });

      if (!p.camera_id) return; // no camera to pop — the toast is enough
      setActive((prev) => {
        if (prev.some((x) => x.key === key)) return prev;
        const next = [{ ...p, key }, ...prev];
        return next.slice(0, MAX_ACTIVE);
      });
    };

    // The shared connection reads the token at connect time and retries until
    // there is one, so a host that mounts before the auth provider has finished
    // probing the refresh cookie still gets its popups.
    return subscribeVmsRealtime({ event: "vms.popup", onFrame: (frame) => push(frame as VmsPopupFrame) });
  }, [enabled]);

  const dismiss = (key: string) => setActive((prev) => prev.filter((p) => p.key !== key));
  const acknowledge = (popup: ActivePopup) => {
    // Best-effort ack of the source event so it drops from the unacknowledged feed.
    if (popup?.event_id) {
      const eventId = popup.event_id;
      import("../api").then(({ vms }) => vms.events.ack(eventId).catch(() => {}));
    }
    dismiss(popup.key);
  };

  return { active, dismiss, acknowledge };
}

export default useVmsPopups;
