"use client";

// Pan/zoom viewport for the SOP canvas. Owns scale + offset + measured size,
// wires the ResizeObserver, a cursor-anchored non-passive wheel zoom, a
// centered zoomBy, fit-to-view, and a one-time auto-fit when states first load.
// The caller owns the actual pointer drag/pan (it's interleaved with node drag +
// connect), reading/writing offset via the returned setter.
import { useCallback, useEffect, useRef, useState } from "react";
import { MIN_SCALE, MAX_SCALE, computeFit } from "../lib/canvasGeometry";

export function usePanZoom(states) {
  const wrapRef = useRef(null);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 40, y: 40 });
  const [size, setSize] = useState({ w: 0, h: 0 });
  const didFitRef = useRef(false);

  /* ── measure container ── */
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setSize({ w: el.clientWidth, h: el.clientHeight });
    });
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  /* ── auto-fit once states first load ── */
  useEffect(() => {
    if (didFitRef.current || !states.length || !size.w) return;
    const fit = computeFit(states, size.w, size.h);
    if (fit) {
      setScale(fit.scale);
      setOffset(fit.offset);
      didFitRef.current = true;
    }
  }, [states, size]);

  const doFit = useCallback(() => {
    const fit = computeFit(states, size.w, size.h);
    if (fit) {
      setScale(fit.scale);
      setOffset(fit.offset);
    } else {
      setScale(1);
      setOffset({ x: 40, y: 40 });
    }
  }, [states, size]);

  const screenToWorld = useCallback(
    (sx, sy) => ({ x: (sx - offset.x) / scale, y: (sy - offset.y) / scale }),
    [offset, scale],
  );

  /* ── wheel zoom (non-passive, anchored to cursor) ── */
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      setScale((prev) => {
        const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, prev * factor));
        setOffset((off) => {
          const wx = (mx - off.x) / prev;
          const wy = (my - off.y) / prev;
          return { x: mx - wx * next, y: my - wy * next };
        });
        return next;
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const zoomBy = useCallback(
    (factor) => {
      const cx = size.w / 2;
      const cy = size.h / 2;
      setScale((prev) => {
        const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, prev * factor));
        setOffset((off) => {
          const wx = (cx - off.x) / prev;
          const wy = (cy - off.y) / prev;
          return { x: cx - wx * next, y: cy - wy * next };
        });
        return next;
      });
    },
    [size],
  );

  return { wrapRef, scale, offset, setOffset, size, screenToWorld, zoomBy, doFit };
}

export default usePanZoom;
