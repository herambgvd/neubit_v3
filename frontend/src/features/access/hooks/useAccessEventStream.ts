"use client";

// Live access-event stream via the core realtime-bridge SSE endpoint
// (GET /api/v1/realtime/access-events?token=<jwt>&instance_id=<id>). Replaces the
// old 5s polling in EventsFeed. Accumulates each `access.event` frame into a
// bounded, newest-first buffer and exposes { events, connected }. EventSource
// can't set headers, so the JWT rides as a ?token= query. Auto-reconnects with
// capped backoff; closes when `paused`/`enabled` is false or on unmount.
import { useEffect, useState } from "react";

import { api, tokens } from "@/lib/api";
import type { AccessEventFrame } from "../types";

// Cap the live buffer so a long-lived stream can't grow unbounded.
const MAX_EVENTS = 500;

export interface AccessEventStreamOptions {
  enabled?: boolean;
  max?: number;
}

export function useAccessEventStream(
  instanceId: string | null | undefined,
  { enabled = true, max = MAX_EVENTS }: AccessEventStreamOptions = {},
) {
  const [events, setEvents] = useState<AccessEventFrame[]>([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!enabled || !instanceId) {
      setConnected(false);
      return;
    }
    if (typeof window === "undefined" || typeof EventSource === "undefined") return;

    let es: EventSource | null = null;
    let closed = false;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (closed) return;
      // Read the token at CONNECT time, not from the mount-time closure: when
      // the access token expires the server drops the stream, and this retry
      // must reconnect with the token lib/api.ts stored after its 401→refresh —
      // a captured 12h-old token would just 401 forever. Same fix as
      // useVmsPopups; the five hooks share this shape.
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
        `${api.defaults.baseURL}/realtime/access-events` +
        `?token=${encodeURIComponent(token)}&instance_id=${encodeURIComponent(instanceId)}`;
      es = new EventSource(url);

      es.addEventListener("access.event", (e) => {
        // The frame is the compact JSON realtime_access._compact emits; the
        // parse is only narrowed to "an object" before it is trusted as one.
        let data: unknown = null;
        try {
          data = JSON.parse(e.data);
        } catch {
          return; // keepalive/comment — ignore
        }
        if (!data || typeof data !== "object") return;
        const frame = data as AccessEventFrame;
        setEvents((prev) => [frame, ...prev].slice(0, max));
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
