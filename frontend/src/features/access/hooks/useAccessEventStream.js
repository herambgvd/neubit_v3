"use client";

// Live access-event stream via the core realtime-bridge SSE endpoint
// (GET /api/v1/realtime/access-events?token=<jwt>&instance_id=<id>). Replaces the
// old 5s polling in EventsFeed. Accumulates each `access.event` frame into a
// bounded, newest-first buffer and exposes { events, connected }. EventSource
// can't set headers, so the JWT rides as a ?token= query. Auto-reconnects with
// capped backoff; closes when `paused`/`enabled` is false or on unmount.
import { useEffect, useRef, useState } from "react";

import { api, tokens } from "@/lib/api";

// Cap the live buffer so a long-lived stream can't grow unbounded.
const MAX_EVENTS = 500;

export function useAccessEventStream(instanceId, { enabled = true, max = MAX_EVENTS } = {}) {
  const [events, setEvents] = useState([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!enabled || !instanceId) {
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
      const url =
        `${api.defaults.baseURL}/realtime/access-events` +
        `?token=${encodeURIComponent(token)}&instance_id=${encodeURIComponent(instanceId)}`;
      es = new EventSource(url);

      es.addEventListener("access.event", (e) => {
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
  }, [instanceId, enabled, max]);

  return { events, connected };
}

export default useAccessEventStream;
