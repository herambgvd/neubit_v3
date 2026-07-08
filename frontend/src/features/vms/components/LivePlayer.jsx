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
import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@iconify/react";

import { useLiveSession } from "../hooks/useLiveSession";

const WHEP_MAX_ATTEMPTS = 8;
const WHEP_RETRY_MS = 2_000;
const HLS_COLD_RETRIES = 8;

export default function LivePlayer({
  cameraId,
  cameraName,
  profile = "sub",
  autoPlay = true,
  muted = true,
  preferWebrtc = true,
  minimal = false, // hide chrome (used for dense wall tiles / thumbnails)
  className = "",
  onReady,
  onSnapshot,
}) {
  const { hlsUrl, webrtcUrl, ready, loading: sessionLoading, error: sessionError, retry: retrySession } =
    useLiveSession(cameraId, { profile });

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

    setLoading(true);
    setError(null);

    const cleanup = () => {
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
    const startWebRTC = async () => {
      if (!webrtcUrl) {
        startHLS();
        return;
      }
      setMode("webrtc");

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
            // Fall back to HLS rather than erroring outright.
            if (hlsUrl) startHLS();
            else {
              setError("Stream is unavailable right now.");
              setLoading(false);
            }
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

          // webrtcUrl is the full WHEP endpoint + already carries "?token=".
          // MediaMTX WHEP CORS only allows Authorization/Content-Type/If-Match
          // — never add extra headers here.
          const res = await fetch(webrtcUrl, {
            method: "POST",
            headers: { "Content-Type": "application/sdp" },
            body: pc.localDescription.sdp,
          });

          // 404 = MediaMTX has the path but the RTSP source isn't ready yet.
          if (res.status === 404 && attempt < WHEP_MAX_ATTEMPTS && !disposed) {
            try {
              pc.close();
            } catch {}
            await new Promise((r) => setTimeout(r, WHEP_RETRY_MS));
            if (!disposed) sendOffer(attempt + 1);
            return;
          }
          if (!res.ok) throw new Error(`WHEP ${res.status}`);

          const answer = await res.text();
          await pc.setRemoteDescription({ type: "answer", sdp: answer });
        } catch (e) {
          if (disposed) return;
          if (attempt < WHEP_MAX_ATTEMPTS) {
            try {
              pc.close();
            } catch {}
            await new Promise((r) => setTimeout(r, WHEP_RETRY_MS));
            if (!disposed) sendOffer(attempt + 1);
            return;
          }
          // Exhausted WebRTC — try HLS before giving up.
          if (hlsUrl) startHLS();
          else {
            setError("Stream is unavailable right now.");
            setLoading(false);
          }
        }
      };

      sendOffer(1);
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
          onReady?.("hls");
          if (autoPlay) video.play().catch(() => {});
        };
        nativeError = () => {
          if (disposed) return;
          if (webrtcUrl) startWebRTC();
          else {
            setError("Stream is unavailable right now.");
            setLoading(false);
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
            // HLS won't come up — try WebRTC (delivers HEVC where HLS can't).
            if (webrtcUrl) {
              startWebRTC();
              return;
            }
            setError("Stream is unavailable right now.");
            setLoading(false);
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
                // HEVC trips MEDIA_ERROR in Chromium — hop to WebRTC.
                if (webrtcUrl) {
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
                }
                break;
              default:
                if (webrtcUrl) {
                  try {
                    hls.destroy();
                  } catch {}
                  hlsRef.current = null;
                  startWebRTC();
                  return;
                }
                setError("Stream is unavailable right now.");
                setLoading(false);
            }
          }
        });
      } catch {
        if (!disposed) {
          setError("Player failed to initialise.");
          setLoading(false);
        }
      }
    };

    if (preferWebrtc && webrtcUrl) startWebRTC();
    else startHLS();

    return () => {
      disposed = true;
      cleanup();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hlsUrl, webrtcUrl, attach]);

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
            {mode === "webrtc" ? (
              <span className="ml-1.5 rounded bg-white/15 px-1 py-0.5 text-[9px] uppercase tracking-wide">
                WebRTC
              </span>
            ) : (
              <span className="ml-1.5 rounded bg-white/15 px-1 py-0.5 text-[9px] uppercase tracking-wide">
                HLS
              </span>
            )}
          </span>
          <div className="pointer-events-auto flex items-center gap-0.5">
            <ChromeBtn icon={isMuted ? "heroicons-outline:speaker-x-mark" : "heroicons-outline:speaker-wave"} title={isMuted ? "Unmute" : "Mute"} onClick={() => setIsMuted((m) => !m)} />
            <ChromeBtn icon="heroicons-outline:camera" title="Snapshot" onClick={snapshot} />
            <ChromeBtn icon={isFullscreen ? "heroicons-outline:arrows-pointing-in" : "heroicons-outline:arrows-pointing-out"} title="Fullscreen" onClick={toggleFullscreen} />
          </div>
        </div>
      )}
    </div>
  );
}

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
