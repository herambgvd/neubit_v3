"use client";

// Live VMS camera-event stream via the core realtime-bridge SSE endpoint
// (GET /api/v1/realtime/vms-events?token=<jwt>&camera_id=<id>). Mirrors the access
// feature's useAccessEventStream: accumulates each `vms.event` frame into a bounded,
// newest-first buffer and exposes { events, connected }. EventSource can't set
// headers, so the JWT rides as a ?token= query. Auto-reconnects with capped backoff;
// closes when `enabled` is false or on unmount.
//
// `cameraId` is optional — pass it to narrow the stream server-side to one camera
// (the Camera-events surface passes it when a camera filter is active; omitting it
// streams every camera's events in the tenant).
import { useEffect, useState } from "react";

import { api, tokens } from "@/lib/api";

// Cap the live buffer so a long-lived stream can't grow unbounded.
const MAX_EVENTS = 500;

export function useVmsEventStream({ cameraId = null, enabled = true, max = MAX_EVENTS } = {}) {
  const [events, setEvents] = useState([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!enabled) {
      setConnected(false);
      return;
    }
    if (typeof window === "undefined" || typeof EventSource === "undefined") return;
    const token = tokens.access;
    if (!token) return;

    let es = null;
    let closed = false;
    let retry = 0;
    let timer = null;

    const connect = () => {
      if (closed) return;
      let url =
        `${api.defaults.baseURL}/realtime/vms-events` + `?token=${encodeURIComponent(token)}`;
      if (cameraId) url += `&camera_id=${encodeURIComponent(cameraId)}`;
      es = new EventSource(url);

      es.addEventListener("vms.event", (e) => {
        let data = null;
        try {
          data = JSON.parse(e.data);
        } catch {
          return; // keepalive/comment — ignore
        }
        if (!data) return;
        setEvents((prev) => [data, ...prev].slice(0, max));
      });

      es.onopen = () => {
        retry = 0;
        setConnected(true);
      };
      es.onerror = () => {
        setConnected(false);
        es?.close();
        if (closed) return;
        // Manual capped-backoff reconnect (also covers an expired/rotated token).
        retry = Math.min(retry + 1, 6);
        timer = setTimeout(connect, Math.min(1000 * 2 ** retry, 30000));
      };
    };

    connect();
    return () => {
      closed = true;
      setConnected(false);
      if (timer) clearTimeout(timer);
      es?.close();
    };
  }, [cameraId, enabled, max]);

  return { events, connected };
}

export default useVmsEventStream;
