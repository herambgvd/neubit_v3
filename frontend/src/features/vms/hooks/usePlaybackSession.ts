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
import type { IsoWindow, PlayableSession, PlaybackSourceFn } from "../types";

const RENEW_LEAD_MS = 45_000;

export interface UsePlaybackSessionOptions {
  /** Kept for callers that pass it; the owning recorder decides the profile now. */
  profile?: string;
  sourceFn?: PlaybackSourceFn | null;
  enabled?: boolean;
}

export function usePlaybackSession(
  cameraId: string | null | undefined,
  { sourceFn = null, enabled = true }: UsePlaybackSessionOptions = {},
) {
  const [session, setSession] = useState<PlayableSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const sessionRef = useRef<PlayableSession | null>(null);
  const windowRef = useRef<IsoWindow | null>(null); // last requested { from, to }
  const renewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const disposedRef = useRef(false);
  const attemptRef = useRef(0);

  // The session comes from whoever OWNS the footage — always the recorder, handed
  // in as `sourceFn`. There is no VMS-owned fallback: this service records nothing
  // and stores nothing (the recording and storage data-plane was removed from it),
  // so a default endpoint here would be a request that can only 404 or answer
  // empty. Without a source there is no session, which the player renders as "no
  // footage" rather than as a spinner.
  const issue = useCallback(
    (win: IsoWindow): Promise<PlayableSession> =>
      sourceFn
        ? sourceFn(win)
        : Promise.reject(new Error("no playback source for this camera")),
    [sourceFn],
  );

  const clearRenew = () => {
    if (renewTimerRef.current) {
      clearTimeout(renewTimerRef.current);
      renewTimerRef.current = null;
    }
  };

  // `scheduleRenew` re-arms itself, which means referring to a `const` from
  // inside its own initialiser. The ref holds the latest one instead, so nothing
  // reads a binding before it exists. Written in an effect, never during render.
  const scheduleRenewRef = useRef<((sess: PlayableSession | null) => void) | null>(null);

  const scheduleRenew = useCallback(
    (sess: PlayableSession | null) => {
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
          scheduleRenewRef.current?.(next);
        } catch {
          // Let the player's own retry loop recover; nothing terminal here.
        }
      }, delay);
    },
    [issue],
  );

  // Load (or re-load) a window — the seek primitive.
  const load = useCallback(
    async (win: IsoWindow | null | undefined) => {
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

  // Keep the cycle-breaking ref pointing at the current callback.
  useEffect(() => {
    scheduleRenewRef.current = scheduleRenew;
  }, [scheduleRenew]);

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

  /* eslint-disable react-hooks/refs -- `windowRef` holds the window the caller
     ASKED for, which is set inside the async load and is deliberately not state:
     making it state would re-render every consumer at request time rather than
     when the session lands. It is read here only as the fallback that keeps
     from/to populated during that gap. */
  // A SESSION WITH NO PLAYABLE URL IS AN ANSWER, NOT A PENDING REQUEST.
  //
  // A recorder answers 200 with an empty `playback_url` and `ranges: []` when the
  // window holds no footage — a normal, common reply, not a failure. The hook
  // reported it as a success with a null url, and every consumer's "no url yet"
  // branch is a SPINNER, so a camera with nothing recorded spun forever. On an
  // estate where nothing was recording that was every tile on the page. Naming the
  // state lets a player say "no footage in this window" instead.
  const settled = !loading && !error && session != null;
  const playable = Boolean(session?.hls_url || session?.webrtc_url);

  return {
    session,
    /** True when the recorder answered but had nothing to play in this window. */
    empty: settled && !playable,
    hlsUrl: session?.hls_url || null,
    // NVR-footage sessions also expose a WHEP (WebRTC) endpoint on the same MediaMTX
    // path — the preferred NVR playback transport (codec-proof: H.264 direct, H.265 via
    // on-demand transcode; no HLS relative-URL fragility).
    webrtcUrl: session?.webrtc_url || null,
    ranges: session?.ranges || [],
    from: session?.from || windowRef.current?.from || null,
    to: session?.to || windowRef.current?.to || null,
    loading,
    error,
    load,
    clear,
  };
  /* eslint-enable react-hooks/refs */
}

export default usePlaybackSession;
