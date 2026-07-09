"use client";

// usePlaybackSession — owns a RECORDED PlaybackSession for a single camera over
// a time window. Unlike a live session (a rolling stream), a recorded session is
// pinned to a `[from, to]` window; SEEKING to a timestamp outside the loaded
// window = requesting a NEW session at the new `from`. The scrub bar drives that
// by calling `load({ from, to })`.
//
// Backend contract (P4-A):
//   POST /vms/cameras/{id}/playback { from, to, profile? } →
//        { session_id, hls_url (carries "?token="), token, from, to, ranges,
//          expires_at }.
//
// A source override (`sourceFn`) lets the same hook drive NVR-footage playback,
// which returns the same session shape from a different endpoint.
//
// The media token expires (~5 min), so long scrubbing sessions re-issue the
// session a little before expiry — same MediaMTX playback path, fresh token.
import { useCallback, useEffect, useRef, useState } from "react";

import { apiError } from "@/lib/api";
import { vms } from "../api";

const RENEW_LEAD_MS = 45_000;

export function usePlaybackSession(
  cameraId,
  { profile = "main", sourceFn = null, enabled = true } = {},
) {
  const [session, setSession] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const sessionRef = useRef(null);
  const windowRef = useRef(null); // last requested { from, to }
  const renewTimerRef = useRef(null);
  const disposedRef = useRef(false);
  const attemptRef = useRef(0);

  // Prefer an explicit source (NVR footage) else the camera playback endpoint.
  const issue = useCallback(
    (win) => (sourceFn ? sourceFn(win) : vms.playback.session(cameraId, { ...win, profile })),
    [cameraId, profile, sourceFn],
  );

  const clearRenew = () => {
    if (renewTimerRef.current) {
      clearTimeout(renewTimerRef.current);
      renewTimerRef.current = null;
    }
  };

  const scheduleRenew = useCallback(
    (sess) => {
      clearRenew();
      const expMs = sess?.expires_at ? new Date(sess.expires_at).getTime() : 0;
      if (!expMs) return;
      const delay = Math.max(5_000, expMs - Date.now() - RENEW_LEAD_MS);
      renewTimerRef.current = setTimeout(async () => {
        const win = windowRef.current;
        if (disposedRef.current || !win) return;
        try {
          const next = await issue(win);
          if (disposedRef.current) return;
          sessionRef.current = next;
          setSession(next);
          scheduleRenew(next);
        } catch {
          // Let the player's own retry loop recover; nothing terminal here.
        }
      }, delay);
    },
    [issue],
  );

  // Load (or re-load) a window — the seek primitive.
  const load = useCallback(
    async (win) => {
      if (!cameraId || !win?.from || !win?.to) return;
      disposedRef.current = false;
      windowRef.current = win;
      setLoading(true);
      setError(null);
      const myAttempt = ++attemptRef.current;
      try {
        const sess = await issue(win);
        if (disposedRef.current || myAttempt !== attemptRef.current) return;
        sessionRef.current = sess;
        setSession(sess);
        setLoading(false);
        scheduleRenew(sess);
      } catch (e) {
        if (disposedRef.current || myAttempt !== attemptRef.current) return;
        setError(apiError(e, "Could not load recorded video for this range"));
        setLoading(false);
        setSession(null);
      }
    },
    [cameraId, issue, scheduleRenew],
  );

  const clear = useCallback(() => {
    clearRenew();
    attemptRef.current += 1;
    windowRef.current = null;
    sessionRef.current = null;
    setSession(null);
    setError(null);
    setLoading(false);
  }, []);

  // Reset when the camera changes / disabled.
  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      clearRenew();
    };
  }, [cameraId, enabled]);

  return {
    session,
    hlsUrl: session?.hls_url || null,
    ranges: session?.ranges || [],
    from: session?.from || windowRef.current?.from || null,
    to: session?.to || windowRef.current?.to || null,
    loading,
    error,
    load,
    clear,
  };
}

export default usePlaybackSession;
