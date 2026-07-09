"use client";

// useWallStream — the video-wall shared-state SSE hook. Mirrors the VMS
// useVmsEventStream / useVmsPopups pattern (EventSource + ?token= query, capped
// backoff reconnect), but listens on the WALL bridge:
//
//   GET /api/v1/realtime/wall-events?token=<jwt>&wall_id=<id>
//   event: wall.state   data: { wall_id, state, rows?, cols?, action?, actor_id? }
//
// The wall's live state is a single atomic blob { monitor_id: { cell_index: camera_id } }.
// On each `wall.state` frame the caller REPLACES its local state with payload.state —
// so every operator console and every display-client kiosk stays byte-for-byte in
// sync with the server (shared control-room wall). We never merge; we replace.
//
// `wallId` narrows the stream server-side to one wall (the kiosk + a single console
// pass it). The hook exposes { state, connected, lastFrame } — `state` is the latest
// full wall state (or null until the first frame), and `lastFrame` carries the
// envelope (action/actor_id) for lightweight "who changed it" affordances.
import { useEffect, useRef, useState } from "react";

import { api, tokens } from "@/lib/api";

export function useWallStream(wallId, { enabled = true } = {}) {
  const [state, setState] = useState(null); // latest full wall state, or null
  const [lastFrame, setLastFrame] = useState(null); // { action, actor_id, rows, cols }
  const [connected, setConnected] = useState(false);
  // Keep the freshest state without re-subscribing when a consumer re-renders.
  const stateRef = useRef(null);

  useEffect(() => {
    if (!enabled || !wallId) {
      setConnected(false);
      return undefined;
    }
    if (typeof window === "undefined" || typeof EventSource === "undefined") return undefined;
    const token = tokens.access;
    if (!token) return undefined;

    let es = null;
    let closed = false;
    let retry = 0;
    let timer = null;

    const connect = () => {
      if (closed) return;
      const url =
        `${api.defaults.baseURL}/realtime/wall-events` +
        `?token=${encodeURIComponent(token)}&wall_id=${encodeURIComponent(wallId)}`;
      es = new EventSource(url);

      es.addEventListener("wall.state", (e) => {
        let data = null;
        try {
          data = JSON.parse(e.data);
        } catch {
          return; // keepalive / comment — ignore
        }
        if (!data || (data.wall_id && data.wall_id !== wallId)) return;
        const next = data.state || {};
        stateRef.current = next;
        setState(next); // REPLACE — shared state is authoritative
        setLastFrame({
          action: data.action || null,
          actor_id: data.actor_id || null,
          rows: data.rows ?? null,
          cols: data.cols ?? null,
        });
      });

      es.onopen = () => {
        retry = 0;
        setConnected(true);
      };
      es.onerror = () => {
        setConnected(false);
        es?.close();
        if (closed) return;
        // Capped-backoff reconnect (also recovers from an expired/rotated token).
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
  }, [wallId, enabled]);

  return { state, lastFrame, connected };
}

export default useWallStream;
