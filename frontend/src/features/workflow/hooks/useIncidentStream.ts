"use client";

// Live incident stream via the core realtime-bridge SSE endpoint
// (GET /api/v1/realtime/incidents?token=<jwt>). Replaces the old 10s polling.
// Fires onEvent({ type, data }) for each `incident.created` / `trigger.fired`
// frame. EventSource can't set headers, so the JWT rides as a ?token= query.
// Auto-reconnects with capped backoff; cleans up on unmount.
import { useEffect, useRef } from "react";

import { api, tokens } from "@/lib/api";
import type { IncidentStreamEvent } from "../types";

const EVENTS = ["incident.created", "trigger.fired"];

export interface IncidentStreamOptions {
  enabled?: boolean;
  /** True on open, false on error (before the reconnect). */
  onStatus?: (connected: boolean) => void;
}

export function useIncidentStream(
  onEvent: (evt: IncidentStreamEvent) => void,
  { enabled = true, onStatus }: IncidentStreamOptions = {},
) {
  // Seeded with the current callbacks and refreshed after each commit, so the
  // long-lived EventSource handlers below never need re-subscribing to see a new
  // one — and no ref is written during render.
  const cbRef = useRef(onEvent);
  const statusRef = useRef(onStatus);
  useEffect(() => {
    cbRef.current = onEvent;
    statusRef.current = onStatus;
  });

  useEffect(() => {
    if (!enabled || typeof window === "undefined" || typeof EventSource === "undefined") return;

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
      const url = `${api.defaults.baseURL}/realtime/incidents?token=${encodeURIComponent(token)}`;
      es = new EventSource(url);

      const handler = (type: string) => (e: MessageEvent<string>) => {
        let data: IncidentStreamEvent["data"] = null;
        try { data = JSON.parse(e.data); } catch { /* keepalive/comment — ignore */ }
        cbRef.current?.({ type, data });
      };
      for (const type of EVENTS) es.addEventListener(type, handler(type));

      es.onopen = () => { retry = 0; statusRef.current?.(true); };
      es.onerror = () => {
        es?.close();
        statusRef.current?.(false);
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
