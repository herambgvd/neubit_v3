"use client";

// Live incident stream via the core realtime-bridge SSE endpoint
// (GET /api/v1/realtime/incidents?token=<jwt>). Replaces the old 10s polling.
// Fires onEvent({ type, data }) for each `incident.created` / `trigger.fired`
// frame. EventSource can't set headers, so the JWT rides as a ?token= query.
// Auto-reconnects with capped backoff; cleans up on unmount.
import { useEffect, useRef } from "react";

import { api, tokens } from "@/lib/api";

const EVENTS = ["incident.created", "trigger.fired"];

export function useIncidentStream(onEvent, { enabled = true } = {}) {
  const cbRef = useRef(onEvent);
  cbRef.current = onEvent;

  useEffect(() => {
    if (!enabled || typeof window === "undefined" || typeof EventSource === "undefined") return;
    const token = tokens.access;
    if (!token) return;

    let es = null;
    let closed = false;
    let retry = 0;
    let timer = null;

    const connect = () => {
      if (closed) return;
      const url = `${api.defaults.baseURL}/realtime/incidents?token=${encodeURIComponent(token)}`;
      es = new EventSource(url);

      const handler = (type) => (e) => {
        let data = null;
        try { data = JSON.parse(e.data); } catch { /* keepalive/comment — ignore */ }
        cbRef.current?.({ type, data });
      };
      for (const type of EVENTS) es.addEventListener(type, handler(type));

      es.onopen = () => { retry = 0; };
      es.onerror = () => {
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
      if (timer) clearTimeout(timer);
      es?.close();
    };
  }, [enabled]);
}

export default useIncidentStream;
