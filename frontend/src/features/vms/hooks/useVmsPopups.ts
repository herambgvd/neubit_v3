"use client";

// Operator-popup consumer — the same core realtime SSE bridge as useVmsEventStream,
// but routing the `vms.popup` frames (published by the P5-B linkage `popup` action on
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

import { api, tokens } from "@/lib/api";
import type { VmsPopupFrame } from "../types";

/** A popup in the active queue: the frame plus its de-dupe key. */
export type ActivePopup = VmsPopupFrame & { key: string };

// Cap concurrent camera-pops so a burst of popups can't cover the whole screen.
const MAX_ACTIVE = 3;

export function useVmsPopups({ enabled = true }: { enabled?: boolean } = {}) {
  const [active, setActive] = useState<ActivePopup[]>([]); // [{ key, camera_id, reason, event_type, severity, occurred_at }]
  const seenRef = useRef(new Set<string>());

  useEffect(() => {
    if (!enabled) return;
    if (typeof window === "undefined" || typeof EventSource === "undefined") return;
    // No token check here: `connect` below reads the token at connect time and
    // RETRIES when there is none yet. Bailing out of the effect instead left the
    // popup stream dead for the whole session whenever this host mounted before
    // the auth provider had finished probing the refresh cookie.

    let es: EventSource | null = null;
    let closed = false;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

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

    const connect = () => {
      if (closed) return;
      // Read the token at CONNECT time, not from the mount-time closure: when the
      // access token expires the server drops the stream, and the retry below must
      // reconnect with the token lib/api.ts stored after its 401→refresh — a
      // captured 12h-old token would just 401 forever.
      const token = tokens.access;
      if (!token) {
        // No token YET, not "no session": the access token lives in memory, so a
        // component that mounts while the auth provider is still probing the
        // refresh cookie sees none. Returning here left the stream dead forever;
        // retry on the same backoff the error path uses.
        retry = Math.min(retry + 1, 6);
        timer = setTimeout(connect, Math.min(1000 * 2 ** retry, 30000));
        return;
      }
      const url =
        `${api.defaults.baseURL}/realtime/vms-events` + `?token=${encodeURIComponent(token)}`;
      es = new EventSource(url);

      es.addEventListener("vms.popup", (e) => {
        let data: VmsPopupFrame | null = null;
        try {
          data = JSON.parse(e.data) as VmsPopupFrame;
        } catch {
          return;
        }
        if (data) push(data);
      });

      es.onopen = () => {
        retry = 0;
      };
      es.onerror = () => {
        es?.close();
        if (closed) return;
        retry = Math.min(retry + 1, 6);
        timer = setTimeout(connect, Math.min(1000 * 2 ** retry, 30000));
      };
    };

    connect();
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      es?.close();
    };
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
