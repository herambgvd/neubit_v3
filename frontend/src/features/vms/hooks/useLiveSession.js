"use client";

// useLiveSession — owns the PlaybackSession lifecycle for a single camera:
//   start → (auto-renew before expiry) → release-on-unmount.
//
// Backend contract (P2-B):
//   POST   /vms/cameras/{id}/live {profile}      → { session_id, hls_url,
//          webrtc_url, token, expires_at, ready } — URLs already gateway-routed
//          and already carrying "?token="; webrtc_url already ends in "/whep".
//   POST   /vms/cameras/{id}/live/{session}/renew → new token + expiry.
//   DELETE /vms/live/{session}                    → release.
//
// "ready:false" means MediaMTX has the path but the upstream RTSP source is
// still warming up (WHEP 404 / HLS 404 until the first segment). We poll a few
// times by re-issuing the session until `ready` flips — the player itself also
// tolerates the cold-start window, so this is belt-and-braces for the wall.
import { useCallback, useEffect, useRef, useState } from "react";

import { apiError } from "@/lib/api";
import { vms } from "../api";

// Renew this many ms before the token actually expires (TTL ~300s).
const RENEW_LEAD_MS = 45_000;
// Cap how long we keep re-issuing while the source warms up.
const READY_POLL_MAX = 6;
const READY_POLL_DELAY_MS = 2_000;

export function useLiveSession(cameraId, { profile = "sub", enabled = true } = {}) {
  const [session, setSession] = useState(null); // PlaybackSessionPublic
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  // Live refs so timers/cleanup read the freshest values without re-subscribing.
  const sessionRef = useRef(null);
  const renewTimerRef = useRef(null);
  const readyPollRef = useRef(null);
  const disposedRef = useRef(false);
  const attemptRef = useRef(0);

  const clearTimers = () => {
    if (renewTimerRef.current) {
      clearTimeout(renewTimerRef.current);
      renewTimerRef.current = null;
    }
    if (readyPollRef.current) {
      clearTimeout(readyPollRef.current);
      readyPollRef.current = null;
    }
  };

  // Schedule an auto-renew a little before the token expires. Renew keeps the
  // SAME MediaMTX path — it only re-mints the media token so long views (video
  // wall left open for hours) don't 401 mid-segment.
  const scheduleRenew = useCallback(
    (sess) => {
      if (renewTimerRef.current) clearTimeout(renewTimerRef.current);
      const expMs = sess?.expires_at ? new Date(sess.expires_at).getTime() : 0;
      const delay = Math.max(5_000, expMs - Date.now() - RENEW_LEAD_MS);
      renewTimerRef.current = setTimeout(async () => {
        const cur = sessionRef.current;
        if (disposedRef.current || !cur?.session_id) return;
        try {
          const next = await vms.live.renew(cameraId, cur.session_id);
          if (disposedRef.current) return;
          sessionRef.current = next;
          setSession(next);
          scheduleRenew(next);
        } catch {
          // Renew failed (session reaped server-side) — start a fresh one so
          // playback recovers rather than freezing on a stale token.
          if (!disposedRef.current) start();
        }
      }, delay);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cameraId],
  );

  const start = useCallback(async () => {
    if (!cameraId) return;
    disposedRef.current = false;
    setLoading(true);
    setError(null);
    const myAttempt = ++attemptRef.current;
    try {
      const sess = await vms.live.start(cameraId, profile);
      if (disposedRef.current || myAttempt !== attemptRef.current) return;
      sessionRef.current = sess;
      setSession(sess);
      setLoading(false);
      scheduleRenew(sess);

      // Warm-up poll: re-issue until the upstream source is ready. The path is
      // idempotent (nvr ensure = upsert), so this just returns a fresh token +
      // ready flag without spinning up a second stream.
      let polls = 0;
      const poll = async () => {
        if (disposedRef.current || myAttempt !== attemptRef.current) return;
        const cur = sessionRef.current;
        if (!cur || cur.ready || polls >= READY_POLL_MAX) return;
        polls += 1;
        try {
          const refreshed = await vms.live.start(cameraId, profile);
          if (disposedRef.current || myAttempt !== attemptRef.current) return;
          sessionRef.current = refreshed;
          setSession(refreshed);
          scheduleRenew(refreshed);
          if (!refreshed.ready) {
            readyPollRef.current = setTimeout(poll, READY_POLL_DELAY_MS);
          }
        } catch {
          // Ignore — the player's own retry loop covers the source warming up.
        }
      };
      if (!sess.ready) {
        readyPollRef.current = setTimeout(poll, READY_POLL_DELAY_MS);
      }
    } catch (e) {
      if (disposedRef.current || myAttempt !== attemptRef.current) return;
      setError(apiError(e, "Could not start the live stream"));
      setLoading(false);
    }
  }, [cameraId, profile, scheduleRenew]);

  const retry = useCallback(() => {
    clearTimers();
    start();
  }, [start]);

  // Kick off / tear down with the camera + enabled flag.
  useEffect(() => {
    if (!enabled || !cameraId) return undefined;
    disposedRef.current = false;
    start();
    return () => {
      disposedRef.current = true;
      attemptRef.current += 1;
      clearTimers();
      const cur = sessionRef.current;
      sessionRef.current = null;
      setSession(null);
      // Fire-and-forget release so the MediaMTX path is reaped once nobody's
      // watching. Never awaited — unmount must not block.
      if (cur?.session_id) vms.live.release(cur.session_id).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraId, profile, enabled]);

  return {
    session,
    hlsUrl: session?.hls_url || null,
    webrtcUrl: session?.webrtc_url || null,
    ready: !!session?.ready,
    loading,
    error,
    retry,
  };
}

export default useLiveSession;
