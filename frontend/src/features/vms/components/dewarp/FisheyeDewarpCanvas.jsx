"use client";

// FisheyeDewarpCanvas — the visible surface that renders a de-warped fisheye view
// on top of a (hidden) live <video>. It owns a WebGL renderer (see fisheyeGl.js),
// drives it once per delivered video frame via requestVideoFrameCallback (rAF
// fallback), and keeps its backing store matched to the container via a
// ResizeObserver. It runs the GL loop ONLY while active + playing + document-
// visible, so it costs nothing on tiles whose dewarp is off.
//
// If the <video> can't be textured (cross-origin / CORS-tainted frame throws on
// texImage2D) it calls onUnavailable() ONCE and stops — LivePlayer then reveals
// the raw video plus an honest "de-warp unavailable" note. No faked output.

import { useEffect, useRef } from "react";

import { createDewarpRenderer } from "./fisheyeGl";

export default function FisheyeDewarpCanvas({
  videoRef,
  canvasRef, // optional: parent ref for snapshotting the de-warped output
  view,
  mount,
  zoom = 1,
  active = true,
  className = "",
  style,
  onUnavailable,
}) {
  const localCanvas = useRef(null);
  const rendererRef = useRef(null);
  // Latest render params in a ref so the rVFC loop reads them without re-subscribing.
  const paramsRef = useRef({ view, mount, zoom });
  paramsRef.current = { view, mount, zoom };
  const onUnavailableRef = useRef(onUnavailable);
  onUnavailableRef.current = onUnavailable;

  const setCanvas = (el) => {
    localCanvas.current = el;
    if (canvasRef) canvasRef.current = el;
  };

  useEffect(() => {
    const canvas = localCanvas.current;
    const video = videoRef?.current;
    if (!canvas || !video || !active) return undefined;

    const renderer = createDewarpRenderer(canvas);
    if (!renderer) {
      onUnavailableRef.current?.("webgl-unsupported");
      return undefined;
    }
    rendererRef.current = renderer;

    // Keep the GL backing store matched to the displayed size (DPR-capped at 2).
    const ro = new ResizeObserver(() => {
      const r = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      renderer.resize(r.width * dpr, r.height * dpr);
    });
    ro.observe(canvas);
    {
      const r = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      renderer.resize((r.width || 640) * dpr, (r.height || 360) * dpr);
    }

    let stopped = false;
    let rvfcHandle = null;
    let rafHandle = null;
    const hasRVFC = typeof video.requestVideoFrameCallback === "function";

    const draw = () => {
      if (stopped) return;
      // Idle while paused or the tab/pane is hidden — no wasted GPU on the wall.
      if (!video.paused && document.visibilityState !== "hidden") {
        const ok = renderer.render(video, paramsRef.current);
        if (!ok) {
          stopped = true;
          onUnavailableRef.current?.("cors");
          return;
        }
      }
      schedule();
    };
    const schedule = () => {
      if (stopped) return;
      if (hasRVFC) rvfcHandle = video.requestVideoFrameCallback(draw);
      else rafHandle = requestAnimationFrame(draw);
    };
    schedule();

    return () => {
      stopped = true;
      ro.disconnect();
      if (rvfcHandle != null && video.cancelVideoFrameCallback) {
        try {
          video.cancelVideoFrameCallback(rvfcHandle);
        } catch {}
      }
      if (rafHandle != null) cancelAnimationFrame(rafHandle);
      renderer.dispose();
      rendererRef.current = null;
    };
    // videoRef is stable; re-init when the pane goes active or off.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  return <canvas ref={setCanvas} className={className} style={style} />;
}
