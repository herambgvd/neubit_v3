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

// Cap concurrent camera-pops so a burst of popups can't cover the whole screen.
const MAX_ACTIVE = 3;

export function useVmsPopups({ enabled = true } = {}) {
  const [active, setActive] = useState([]); // [{ key, camera_id, reason, event_type, severity, occurred_at }]
  const seenRef = useRef(new Set());

  useEffect(() => {
    if (!enabled) return;
    if (typeof window === "undefined" || typeof EventSource === "undefined") return;
    const token = tokens.access;
    if (!token) return;

    let es = null;
    let closed = false;
    let retry = 0;
    let timer = null;

    const push = (p) => {
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
      const url =
        `${api.defaults.baseURL}/realtime/vms-events` + `?token=${encodeURIComponent(token)}`;
      es = new EventSource(url);

      es.addEventListener("vms.popup", (e) => {
        let data = null;
        try {
          data = JSON.parse(e.data);
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

  const dismiss = (key) => setActive((prev) => prev.filter((p) => p.key !== key));
  const acknowledge = (popup) => {
    // Best-effort ack of the source event so it drops from the unacknowledged feed.
    if (popup?.event_id) {
      import("../api").then(({ vms }) => vms.events.ack(popup.event_id).catch(() => {}));
    }
    dismiss(popup.key);
  };

  return { active, dismiss, acknowledge };
}

export default useVmsPopups;
