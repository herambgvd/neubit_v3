"use client";

// LivePlayer — the P2-D live video surface for a single camera.
//
// It owns a PlaybackSession via `useLiveSession` (start → auto-renew → release
// on unmount) and plays it with a **WebRTC/WHEP-first, HLS-fallback** engine
// ported from neubit_v2's `hls-video-player.jsx`, rethemed to v3 tokens and
// adapted to our session contract:
//   • webrtcUrl / hlsUrl come from the session and ALREADY carry "?token=".
//   • webrtcUrl is the full WHEP endpoint (already ends in "/whep") — we POST
//     the SDP offer straight to it (v2 appended "/whep"; ours must NOT).
//   • WHEP 404 / HLS cold-manifest = the upstream RTSP source is still warming
//     up → retry quietly within a budget before surfacing an error.
//
// Preference order:
//   1. WebRTC/WHEP (low latency, plays HEVC that Chromium MSE rejects)
//   2. hls.js (Chrome/Firefox/Edge) — dynamic import, kept out of the bundle
//   3. native HLS (Safari)
//
// Chrome (unless `minimal`): LIVE badge, snapshot, mute, fullscreen, retry.
//
// ── Memo boundary (video-wall render-perf) ──────────────────────────────────
// LivePlayer is wrapped in React.memo so an unrelated parent re-render (SSE wall
// tick, a sibling tile's loading/error state, mute toggle, drag state) does NOT
// re-render this player — and therefore does NOT risk re-running the WebRTC/WHEP
// attach effect. That effect's deps are stable primitives derived from the
// session (`hlsUrl`/`webrtcUrl` are strings off `useLiveSession`'s session, plus
// the internal `attach` counter), so the stream identity (cameraId + profile +
// session url) is what drives a real attach — never an unrelated parent render.
// Props MUST stay referentially stable for the memo to hold: callers pass stable
// primitives + useCallback'd handlers (WallTile / Streaming do this).
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@iconify/react";

import { useLiveSession } from "../hooks/useLiveSession";
import { acquireSlot, releaseSlot } from "../lib/connectGate";
import TalkButton from "./TalkButton";

const WHEP_MAX_ATTEMPTS = 8;
const WHEP_RETRY_MS = 2_000;
const HLS_COLD_RETRIES = 8;

// Silence AbortError rejection NOISE, once, process-wide. When we abort in-flight
// WHEP fetch(es) / body reads on unmount, Chrome reports the rejection to
// `unhandledrejection` in the SAME microtask — sometimes BEFORE the awaiting
// try/catch runs — so Next's dev overlay flashes "Runtime AbortError: LivePlayer
// unmounted" even though the abort is fully handled and intentional. AbortErrors that
// reach here are never actionable (they're always deliberate cancellations), so we
// preventDefault them; every other rejection still surfaces normally. Guarded so it
// registers a single listener no matter how many LivePlayers mount.
if (typeof window !== "undefined" && !window.__neubitAbortSwallow) {
  window.__neubitAbortSwallow = true;
  // CAPTURE phase + stopImmediatePropagation so this runs BEFORE Next's dev-overlay
  // unhandledrejection listener and prevents it from ever showing the AbortError.
  // (preventDefault alone doesn't stop other listeners; Next's overlay was already
  // firing first, so the overlay still appeared on camera switch / unmount.)
  window.addEventListener(
    "unhandledrejection",
    (e) => {
      const r = e?.reason;
      if (r && (r.name === "AbortError" || r instanceof DOMException)) {
        e.stopImmediatePropagation();
        e.preventDefault();
      }
    },
    true,
  );
}

// H265→H264 transcode fallback. Chrome's WebRTC can't decode HEVC, so a direct
// WHEP POST for an H265 camera fails to negotiate (MediaMTX returns 400). We then
// retry ONCE against the transcoded variant — the same WHEP URL with "/h264"
// inserted before the trailing "/whep" segment. MediaMTX runs ffmpeg on demand to
// republish an H264 stream at that path (see deploy/mediamtx.yml). The "?token="
// is preserved (same camera → the media token is valid for the /h264 sub-path).
// Returns null when the URL isn't a WHEP endpoint or already targets /h264.
function toTranscodedWhepUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url, window.location.origin);
    // Path ends in ".../whep" → insert "/h264" before it. Already transcoded → skip.
    if (!/\/whep$/.test(u.pathname) || /\/h264\/whep$/.test(u.pathname)) return null;
    u.pathname = u.pathname.replace(/\/whep$/, "/h264/whep");
    return u.toString();
  } catch {
    return null;
  }
}

// Stream IDENTITY = the session URL WITHOUT its "?token=". useLiveSession renews
// the media token every ~4-5 min (TTL 300s) and hands back the SAME path with a
// FRESH token — which changed the url string and, when used as an effect dep,
// tore down and RECONNECTED a perfectly healthy stream (the "refresh every few
// minutes" the operator saw). An already-established WebRTC connection doesn't
// need the new token (it's only checked at WHEP connect), so we key the attach
// effect on this token-less identity: a token-only renew no longer re-attaches.
function streamKey(url) {
  if (!url) return "";
  try {
    const u = new URL(url, window.location.origin);
    u.searchParams.delete("token");
    return u.toString();
  } catch {
    return url;
  }
}

function LivePlayer({
  cameraId,
  cameraName,
  profile = "sub",
  autoPlay = true,
  muted = true,
  preferWebrtc = true,
  minimal = false, // hide chrome (used for dense wall tiles / thumbnails)
  // G6 — push-to-talk: show the Talk button when the camera is backchannel/
  // two-way capable AND the operator holds vms.live.view. Listen (unmute) is
  // always available regardless of these.
  talkCapable = false,
  canTalk = false,
  className = "",
  onReady,
  onSnapshot,
}) {
  const { hlsUrl, webrtcUrl, ready, loading: sessionLoading, error: sessionError, retry: retrySession } =
    useLiveSession(cameraId, { profile });

  // Keep the freshest session URLs (with the CURRENT token) in refs. The attach
  // effect keys on the token-less stream identity (streamKey) so a token-only
  // renew never re-runs it, but when it DOES run it reads the live token here.
  const hlsUrlRef = useRef(hlsUrl);
  const webrtcUrlRef = useRef(webrtcUrl);
  hlsUrlRef.current = hlsUrl;
  webrtcUrlRef.current = webrtcUrl;
  const hlsKey = streamKey(hlsUrl);
  const webrtcKey = streamKey(webrtcUrl);

  const videoRef = useRef(null);
  const containerRef = useRef(null);
  const hlsRef = useRef(null);
  const pcRef = useRef(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [mode, setMode] = useState(preferWebrtc ? "webrtc" : "hls");
  const [isMuted, setIsMuted] = useState(muted);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showChrome, setShowChrome] = useState(!minimal);
  const [attach, setAttach] = useState(0); // bump to force a fresh attach

  const playError = error || sessionError;

  // ── attach / detach the media engine ──────────────────────────────────
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;
    // Read the freshest session URLs (with live token) from refs. Shadowing the
    // component-scope hlsUrl/webrtcUrl here means every connect path below uses
    // the current token, while the effect only RE-RUNS on a real stream-identity
    // change (streamKey deps) — never on a token-only renew.
    const hlsUrl = hlsUrlRef.current;
    const webrtcUrl = webrtcUrlRef.current;
    // Nothing to play yet — session is still being issued.
    if (!hlsUrl && !webrtcUrl) {
      setLoading(true);
      return undefined;
    }

    let disposed = false;
    let warmedUp = false;
    let nativeLoaded = null;
    let nativeError = null;
    let coldRetries = 0;
    // Set once the WebRTC ladder (direct WHEP + the one /h264 transcode retry)
    // has fully given up. Stops the HLS error handlers from bouncing back to
    // WebRTC — otherwise HLS(HEVC)→WebRTC→transcode-fail→HLS would loop forever.
    let webrtcExhausted = false;
    // Abort in-flight WHEP POST(s) on unmount so navigating away doesn't leave
    // pending requests holding connections (that's what made leaving the wall
    // feel slow). And remember the WHEP session resource (Location header) so we
    // can DELETE it on teardown — ending the MediaMTX reader + reaping the
    // on-demand source/transcode immediately instead of waiting for a timeout.
    const whepAbort = new AbortController();
    let whepResource = null;

    // ── connection-concurrency gate ────────────────────────────────────────
    // We hold ONE slot from `connectGate` while THIS connection is forming, and
    // release it the instant the connection SETTLES — the first of: stream
    // playing/ready, terminal failure (ladder exhausted), or unmount. Releasing
    // hands the slot to the next waiting tile so the wall fills a few at a time
    // instead of bursting the NVR's connection limit. `releaseGate` is idempotent
    // — safe to call from every exit path; only the first call frees the slot.
    let slotReleased = false;
    const releaseGate = () => {
      if (slotReleased) return;
      slotReleased = true;
      releaseSlot();
    };

    setLoading(true);
    setError(null);

    const cleanup = () => {
      try {
        // Pass an explicit reason so the aborted fetch rejects with THIS (not the
        // default "signal is aborted without reason" DOMException the dev overlay
        // flags). The rejection is swallowed in sendOffer's catch below.
        whepAbort.abort(new DOMException("LivePlayer unmounted", "AbortError"));
      } catch {}
      if (whepResource) {
        // Fire-and-forget; keepalive lets it finish during page navigation.
        try {
          fetch(whepResource, { method: "DELETE", keepalive: true });
        } catch {}
        whepResource = null;
      }
      if (hlsRef.current) {
        try {
          hlsRef.current.stopLoad?.();
          hlsRef.current.detachMedia?.();
          hlsRef.current.destroy();
        } catch {}
        hlsRef.current = null;
      }
      if (pcRef.current) {
        try {
          pcRef.current.close();
        } catch {}
        pcRef.current = null;
      }
      if (nativeLoaded) video.removeEventListener("loadedmetadata", nativeLoaded);
      if (nativeError) video.removeEventListener("error", nativeError);
      try {
        video.srcObject = null;
        video.pause();
        video.removeAttribute("src");
        video.load();
      } catch {}
    };

    // ── WebRTC / WHEP ────────────────────────────────────────────────────
    // `url` defaults to the direct WHEP endpoint. On an H265 camera the direct
    // POST fails to negotiate (400 — Chrome can't decode HEVC); we then re-enter
    // this with the transcoded /h264 variant. `transcoded` guards against looping
    // the fallback (only one transcode attempt).
    const startWebRTC = async (url = webrtcUrl, transcoded = false) => {
      if (!url) {
        startHLS();
        return;
      }
      setMode("webrtc");

      // What to do when WHEP on `url` can't be established: try the transcoded
      // /h264 variant once, else HLS, else error. Kept in one place so every
      // give-up branch below routes through the same fallback ladder.
      const fallback = () => {
        if (disposed) return;
        const h264 = transcoded ? null : toTranscodedWhepUrl(url);
        if (h264) {
          // Give-up on the direct (H265) stream → transcode. Show "Starting
          // stream…" while ffmpeg spins up the H264 republish.
          setLoading(true);
          setError(null);
          startWebRTC(h264, true);
          return;
        }
        // No transcode option left → WebRTC (direct + transcode) is done. Mark
        // it so HLS won't bounce back here, then hand off to HLS / error.
        webrtcExhausted = true;
        if (hlsUrl) startHLS();
        else {
          setError("Stream is unavailable right now.");
          setLoading(false);
          releaseGate();
        }
      };

      const sendOffer = async (attempt) => {
        if (disposed) return;
        if (pcRef.current) {
          try {
            pcRef.current.close();
          } catch {}
          pcRef.current = null;
        }
        const pc = new RTCPeerConnection({
          iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
        });
        pcRef.current = pc;
        pc.addTransceiver("video", { direction: "recvonly" });
        pc.addTransceiver("audio", { direction: "recvonly" });
        pc.ontrack = (evt) => {
          if (disposed) return;
          if (evt.streams[0]) {
            video.srcObject = evt.streams[0];
            setLoading(false);
            releaseGate();
            onReady?.("webrtc");
            if (autoPlay) video.play().catch(() => {});
          }
        };
        pc.oniceconnectionstatechange = () => {
          // Only "failed" is terminal; "disconnected" flickers during the
          // initial handshake and self-recovers.
          if (disposed || pc !== pcRef.current) return;
          if (pc.iceConnectionState === "failed") {
            try {
              pc.close();
            } catch {}
            pcRef.current = null;
            // ICE failed — route through the fallback ladder (transcode → HLS).
            fallback();
          }
        };

        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          // Wait for ICE gathering (bounded) so the offer carries candidates.
          await new Promise((resolve) => {
            if (pc.iceGatheringState === "complete") return resolve();
            const check = () => {
              if (pc.iceGatheringState === "complete") {
                pc.removeEventListener("icegatheringstatechange", check);
                resolve();
              }
            };
            pc.addEventListener("icegatheringstatechange", check);
            setTimeout(resolve, 3_000);
          });

          // `url` is the full WHEP endpoint + already carries "?token=".
          // MediaMTX WHEP CORS only allows Authorization/Content-Type/If-Match
          // — never add extra headers here.
          const whepFetch = fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/sdp" },
            body: pc.localDescription.sdp,
            signal: whepAbort.signal,
          });
          // Attach a swallow to the RAW promise so an abort-on-unmount rejection
          // is never reported as "unhandled" — Chrome fires unhandledrejection in
          // the same microtask the fetch aborts, BEFORE the await's catch runs, so
          // the dev overlay would otherwise flash a Runtime AbortError. The await
          // below still routes genuine errors to the catch normally.
          whepFetch.catch(() => {});
          const res = await whepFetch;

          // 404 = MediaMTX has the path but the RTSP source isn't ready yet
          // (also the transcode ffmpeg spinning up) → keep retrying same url.
          if (res.status === 404 && attempt < WHEP_MAX_ATTEMPTS && !disposed) {
            try {
              pc.close();
            } catch {}
            await new Promise((r) => setTimeout(r, WHEP_RETRY_MS));
            if (!disposed) sendOffer(attempt + 1).catch(() => {});
            return;
          }
          // 400 = negotiation failed — the browser can't decode this codec (H265
          // on Chrome). Retrying the SAME url won't help → go straight to the
          // transcode fallback, don't burn the retry budget.
          if (res.status === 400) {
            try {
              pc.close();
            } catch {}
            fallback();
            return;
          }
          if (!res.ok) throw new Error(`WHEP ${res.status}`);

          // Remember the WHEP session resource so cleanup() can DELETE it (ends
          // the MediaMTX reader immediately). Carry the media token for the
          // ForwardAuth gate on the DELETE.
          try {
            const loc = res.headers.get("Location");
            if (loc) {
              const resUrl = new URL(loc, window.location.origin);
              const tok = new URL(url, window.location.origin).searchParams.get("token");
              if (tok && !resUrl.searchParams.get("token")) resUrl.searchParams.set("token", tok);
              whepResource = resUrl.toString();
            }
          } catch {}

          // res.text() reads the body stream (also signal-bound) — swallow on the
          // raw promise so an abort during the read never floats unhandled either.
          const answerP = res.text();
          answerP.catch(() => {});
          const answer = await answerP;
          await pc.setRemoteDescription({ type: "answer", sdp: answer });
        } catch (e) {
          // Aborted (unmount/navigation) → swallow silently; never retry or
          // fall back on an aborted signal. This is the AbortError the dev
          // overlay was surfacing as an unhandled rejection.
          if (disposed || whepAbort.signal.aborted || e?.name === "AbortError") return;
          if (attempt < WHEP_MAX_ATTEMPTS) {
            try {
              pc.close();
            } catch {}
            await new Promise((r) => setTimeout(r, WHEP_RETRY_MS));
            if (!disposed) sendOffer(attempt + 1).catch(() => {});
            return;
          }
          // Exhausted WebRTC on this url — transcode fallback, then HLS.
          fallback();
        }
      };

      // Fire-and-forget: sendOffer owns its own error handling; swallow any
      // stray rejection (e.g. an aborted signal) so it never floats unhandled.
      sendOffer(1).catch(() => {});
    };

    // ── HLS (hls.js / native) ────────────────────────────────────────────
    const startHLS = async () => {
      cleanup();
      setMode("hls");
      if (!hlsUrl) {
        if (webrtcUrl) startWebRTC();
        else {
          setError("Stream is unavailable right now.");
          setLoading(false);
        }
        return;
      }

      // Native HLS (Safari) — no hls.js needed.
      if (video.canPlayType("application/vnd.apple.mpegurl")) {
        video.src = hlsUrl;
        nativeLoaded = () => {
          if (disposed) return;
          setLoading(false);
          releaseGate();
          onReady?.("hls");
          if (autoPlay) video.play().catch(() => {});
        };
        nativeError = () => {
          if (disposed) return;
          if (webrtcUrl) startWebRTC();
          else {
            setError("Stream is unavailable right now.");
            setLoading(false);
            releaseGate();
          }
        };
        video.addEventListener("loadedmetadata", nativeLoaded);
        video.addEventListener("error", nativeError);
        return;
      }

      try {
        const Hls = (await import("hls.js")).default;
        if (disposed) return;
        if (!Hls.isSupported()) {
          if (webrtcUrl) startWebRTC();
          else {
            setError("This browser cannot play the stream.");
            setLoading(false);
            releaseGate();
          }
          return;
        }
        const hls = new Hls({
          enableWorker: false,
          lowLatencyMode: true,
          backBufferLength: 30,
          maxBufferLength: 30,
          manifestLoadingMaxRetry: 2,
          manifestLoadingRetryDelay: 500,
          levelLoadingMaxRetry: 4,
          fragLoadingMaxRetry: 6,
        });
        hlsRef.current = hls;
        hls.loadSource(hlsUrl);
        hls.attachMedia(video);

        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          if (disposed) return;
          warmedUp = true;
          setLoading(false);
          releaseGate();
          onReady?.("hls");
          if (autoPlay) video.play().catch(() => {});
        });

        hls.on(Hls.Events.ERROR, (_e, data) => {
          if (disposed) return;
          const status = data?.response?.code || data?.networkDetails?.status;
          const gone = data?.fatal && (status === 404 || status === 410);
          const warmup =
            data?.fatal &&
            !warmedUp &&
            (data?.type === Hls.ErrorTypes.NETWORK_ERROR ||
              data?.details === Hls.ErrorDetails?.MANIFEST_LOAD_ERROR ||
              data?.details === Hls.ErrorDetails?.MANIFEST_LOAD_TIMEOUT ||
              data?.details === Hls.ErrorDetails?.LEVEL_LOAD_ERROR);

          if (gone || warmup) {
            try {
              hls.stopLoad();
              hls.destroy();
            } catch {}
            hlsRef.current = null;
            if (coldRetries < HLS_COLD_RETRIES) {
              coldRetries += 1;
              setTimeout(() => {
                if (!disposed) startHLS();
              }, 1_500);
              return;
            }
            // HLS won't come up — try WebRTC (delivers HEVC where HLS can't),
            // unless the WebRTC+transcode ladder already gave up.
            if (webrtcUrl && !webrtcExhausted) {
              startWebRTC();
              return;
            }
            setError("Stream is unavailable right now.");
            setLoading(false);
            releaseGate();
            return;
          }

          if (data.fatal) {
            switch (data.type) {
              case Hls.ErrorTypes.NETWORK_ERROR:
                try {
                  hls.startLoad();
                } catch {}
                break;
              case Hls.ErrorTypes.MEDIA_ERROR:
                // HEVC trips MEDIA_ERROR in Chromium — hop to WebRTC (which can
                // transcode), unless the WebRTC+transcode ladder already gave up.
                if (webrtcUrl && !webrtcExhausted) {
                  try {
                    hls.destroy();
                  } catch {}
                  hlsRef.current = null;
                  startWebRTC();
                  return;
                }
                try {
                  hls.recoverMediaError();
                } catch {
                  setError("Stream is unavailable right now.");
                  setLoading(false);
                  releaseGate();
                }
                break;
              default:
                if (webrtcUrl && !webrtcExhausted) {
                  try {
                    hls.destroy();
                  } catch {}
                  hlsRef.current = null;
                  startWebRTC();
                  return;
                }
                setError("Stream is unavailable right now.");
                setLoading(false);
                releaseGate();
            }
          }
        });
      } catch {
        if (!disposed) {
          setError("Player failed to initialise.");
          setLoading(false);
          releaseGate();
        }
      }
    };

    // Gate the START of this connection. `acquireSlot()` resolves immediately
    // when a slot is free (single-camera modal → instant, no user-visible delay);
    // on the wall it queues so connections form a few at a time. If the tile
    // unmounted while we were queued, `disposed` is already true → release the
    // slot we were just handed and bail without opening a connection.
    acquireSlot().then(() => {
      if (disposed) {
        releaseGate();
        return;
      }
      // startWebRTC/startHLS own their errors; swallow any stray rejection
      // (e.g. an aborted signal on unmount) so it never floats unhandled.
      if (preferWebrtc && webrtcUrl) startWebRTC().catch(() => {});
      else startHLS().catch(() => {});
    });

    return () => {
      disposed = true;
      // Unmount is a settle point: free our slot (whether still queued, mid-
      // connect, or already settled — releaseGate is idempotent) so the next
      // tile can proceed and the gate never deadlocks.
      releaseGate();
      cleanup();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hlsKey, webrtcKey, attach]);

  // Keep the <video> mute in sync.
  useEffect(() => {
    if (videoRef.current) videoRef.current.muted = isMuted;
  }, [isMuted]);

  useEffect(() => {
    const onFs = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  // ── controls ───────────────────────────────────────────────────────────
  const snapshot = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    try {
      const canvas = document.createElement("canvas");
      canvas.width = v.videoWidth || 640;
      canvas.height = v.videoHeight || 480;
      canvas.getContext("2d").drawImage(v, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((blob) => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${cameraName || cameraId || "snapshot"}-${new Date()
          .toISOString()
          .slice(0, 19)
          .replace(/:/g, "-")}.png`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, "image/png");
      onSnapshot?.();
    } catch {
      /* video not decodable yet — ignore */
    }
  }, [cameraId, cameraName, onSnapshot]);

  const toggleFullscreen = () => {
    const c = containerRef.current;
    if (!c) return;
    if (!document.fullscreenElement) c.requestFullscreen?.();
    else document.exitFullscreen?.();
  };

  const retry = () => {
    setError(null);
    retrySession();
    setAttach((n) => n + 1);
  };

  const busy = (loading || sessionLoading) && !playError;

  return (
    <div
      ref={containerRef}
      className={`group relative overflow-hidden rounded-lg bg-black ${className}`}
      onMouseEnter={() => !minimal && setShowChrome(true)}
      onMouseLeave={() => !minimal && setShowChrome(false)}
    >
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <video ref={videoRef} className="h-full w-full object-contain" playsInline muted={isMuted} />

      {/* Loading / warming-up overlay */}
      {busy && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-black/60 text-white/85">
          <Icon icon="svg-spinners:180-ring" className="text-2xl" />
          <p className="text-xs">{ready ? "Connecting…" : "Starting stream…"}</p>
        </div>
      )}

      {/* Error / retry overlay */}
      {playError && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-black/85 px-4 text-center">
          <Icon icon="heroicons-outline:exclamation-triangle" className="text-3xl text-red-400" />
          <p className="max-w-sm text-xs text-red-200">{playError}</p>
          <button
            type="button"
            onClick={retry}
            className="inline-flex items-center gap-1.5 rounded-md bg-red-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-red-500"
          >
            <Icon icon="heroicons-outline:arrow-path" className="text-sm" />
            Retry
          </button>
        </div>
      )}

      {/* LIVE badge */}
      {!busy && !playError && (
        <span className="pointer-events-none absolute left-2 top-2 z-10 inline-flex items-center gap-1 rounded-full bg-red-600 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" />
          Live
        </span>
      )}

      {/* Chrome (hover) — hidden entirely in `minimal` mode */}
      {!minimal && !playError && (
        <div
          className={`pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 bg-gradient-to-t from-black/80 to-transparent p-2.5 transition-opacity duration-200 ${
            showChrome ? "opacity-100" : "opacity-0"
          }`}
        >
          <span className="pointer-events-auto truncate text-xs font-medium text-white/90">
            {cameraName || ""}
          </span>
          <div className="pointer-events-auto flex items-center gap-0.5">
            {/* Push-to-talk (G6) — only for a talk-capable camera + vms.live.view. */}
            {talkCapable && canTalk && <TalkButton cameraId={cameraId} />}
            {/* Listen (audio) — the media element starts muted for autoplay; this
                unmutes so the operator hears the camera. Always shown; if the
                stream carries no audio track it just does nothing audible. */}
            <ChromeBtn
              icon={isMuted ? "heroicons-outline:speaker-x-mark" : "heroicons-outline:speaker-wave"}
              title={isMuted ? "Listen (unmute audio)" : "Mute audio"}
              onClick={() => setIsMuted((m) => !m)}
            />
            <ChromeBtn icon="heroicons-outline:camera" title="Snapshot" onClick={snapshot} />
            <ChromeBtn icon={isFullscreen ? "heroicons-outline:arrows-pointing-in" : "heroicons-outline:arrows-pointing-out"} title="Fullscreen" onClick={toggleFullscreen} />
          </div>
        </div>
      )}
    </div>
  );
}

// Memoised: only re-render when THIS player's props change (camera/session/urls,
// flags, or a stabilised callback). Unrelated parent renders are skipped, so the
// attach effect never re-runs off a sibling tile's state change.
export default memo(LivePlayer);

function ChromeBtn({ icon, title, onClick }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="rounded-full p-1.5 text-white/90 transition hover:bg-white/15 hover:text-white"
    >
      <Icon icon={icon} className="text-sm" />
    </button>
  );
}
