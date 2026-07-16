"use client";

// H265WebPlayer — a browser-side HEVC/H.265 (and H.264) decoder tile, wrapping the
// h265web.js PRO SDK (WASM decoder). This is our ZERO-server-transcode path: instead of
// MediaMTX ffmpeg transcoding H.265→H.264 (CPU on the server), the SDK decodes HEVC in
// the browser (WebCodecs hardware where available, else WASM+SIMD). Used ONLY for H.265
// streams — H.264 stays on the lightweight hls.js/native path (see PlaybackPlayer).
//
// The SDK is a global UMD bundle served from /public/h265web/ (h265web.js + the WASM
// decoder + demux ext files). We inject it once, then per-tile: H265webjsPlayer().build()
// → load_media(url) → play(). The media URL carries our ?token= (ForwardAuth-gated),
// exactly like the hls.js path.
import { useEffect, useId, useRef, useState } from "react";
import { Icon } from "@iconify/react";

// ── one-time SDK loader ────────────────────────────────────────────────────
// The bundle exposes window.H265webjsPlayer. We inject the <script> once and share
// the load promise across every tile.
const SDK_SRC = "/h265web/h265web.js";
let sdkPromise = null;

function loadSdk() {
  if (typeof window === "undefined") return Promise.reject(new Error("no window"));
  if (window.H265webjsPlayer) return Promise.resolve(window.H265webjsPlayer);
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${SDK_SRC}"]`);
    const onload = () => {
      if (window.H265webjsPlayer) resolve(window.H265webjsPlayer);
      else reject(new Error("h265web SDK loaded but H265webjsPlayer missing"));
    };
    if (existing) {
      existing.addEventListener("load", onload, { once: true });
      existing.addEventListener("error", () => reject(new Error("h265web SDK failed to load")), { once: true });
      if (window.H265webjsPlayer) onload();
      return;
    }
    const s = document.createElement("script");
    s.src = SDK_SRC;
    s.async = true;
    s.onload = onload;
    s.onerror = () => {
      sdkPromise = null; // allow a retry on a later mount
      reject(new Error("h265web SDK failed to load"));
    };
    document.head.appendChild(s);
  });
  return sdkPromise;
}

// Base dir the SDK loads its WASM + ext bundles from (Next serves /public at root).
const BASE_URL = "/h265web/";

export default function H265WebPlayer({
  url, // the media URL (HLS m3u8 or fMP4) — carries ?token=
  playing = true,
  muted = true,
  speed = 1,
  // Controlled seek: epoch-ms target + the window start so we can map to a stream offset.
  seekMs = null,
  windowStart = null,
  onTime, // (epochMs) => void — playhead reporting (maps pts + windowStart)
  onReady, // () => void
  onError, // (err) => void — parent can fall back to hls.js / transcode
  className = "",
}) {
  const reactId = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const containerId = `h265-${reactId}`;
  const playerRef = useRef(null);
  const [status, setStatus] = useState("loading"); // loading | ready | error
  const playingRef = useRef(playing);
  const winStartRef = useRef(windowStart);
  useEffect(() => {
    playingRef.current = playing;
  }, [playing]);
  useEffect(() => {
    winStartRef.current = windowStart;
  }, [windowStart]);

  // Build the player for the current URL. Rebuilds when the URL changes (a new session).
  useEffect(() => {
    if (!url) return undefined;
    let disposed = false;
    let player = null;
    setStatus("loading");

    loadSdk()
      .then((factory) => {
        if (disposed) return;
        try {
          player = factory();
          playerRef.current = player;
          player.build({
            player_id: containerId,
            base_url: BASE_URL,
            wasm_js_uri: "h265web_wasm.js",
            wasm_wasm_uri: "h265web_wasm.wasm",
            ext_src_js_uri: "extjs.js",
            ext_wasm_js_uri: "extwasm.js",
            width: "100%",
            height: "100%",
            color: "#000000",
            auto_play: true,
            readframe_multi_times: -1,
            ignore_audio: !!muted,
          });
          // Playhead reporting: on_play_time gives the stream PTS (seconds) — map to
          // absolute epoch ms via the window start (VOD) so the shared timeline follows.
          player.on_play_time = (pts) => {
            if (winStartRef.current != null && typeof onTime === "function") {
              onTime(winStartRef.current + Number(pts || 0) * 1000);
            }
          };
          player.on_ready_show_done_callback = () => {
            if (disposed) return;
            setStatus("ready");
            onReady?.();
            try {
              if (!playingRef.current) player.pause();
            } catch {}
          };
          player.load_media(url);
        } catch (e) {
          if (!disposed) {
            setStatus("error");
            onError?.(e);
          }
        }
      })
      .catch((e) => {
        if (!disposed) {
          setStatus("error");
          onError?.(e);
        }
      });

    return () => {
      disposed = true;
      try {
        player?.release?.();
      } catch {}
      playerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, muted]);

  // Controlled play/pause.
  useEffect(() => {
    const p = playerRef.current;
    if (!p || status !== "ready") return;
    try {
      if (playing) p.play();
      else p.pause();
    } catch {}
  }, [playing, status]);

  // Controlled speed (best-effort — the SDK may expose set_playback_rate).
  useEffect(() => {
    const p = playerRef.current;
    if (!p || status !== "ready") return;
    try {
      p.set_playback_rate?.(speed);
    } catch {}
  }, [speed, status]);

  // Controlled seek (VOD): map epoch-ms → stream offset seconds.
  useEffect(() => {
    const p = playerRef.current;
    if (!p || status !== "ready" || seekMs == null || windowStart == null) return;
    const offset = (seekMs - windowStart) / 1000;
    if (offset < 0) return;
    try {
      p.seek?.(offset);
    } catch {}
  }, [seekMs, windowStart, status]);

  return (
    <div className={`relative h-full w-full overflow-hidden bg-black ${className}`}>
      {/* The SDK renders its canvas inside this container. */}
      <div id={containerId} className="h-full w-full" />
      {status === "loading" && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/50 text-white/80">
          <Icon icon="svg-spinners:180-ring" className="text-xl" />
        </div>
      )}
      {status === "error" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-black/70 text-center text-[11px] text-red-300">
          <Icon icon="heroicons-outline:exclamation-triangle" className="text-xl" />
          HEVC decoder unavailable
        </div>
      )}
    </div>
  );
}
