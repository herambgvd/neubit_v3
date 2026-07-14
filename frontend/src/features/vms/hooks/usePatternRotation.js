"use client";

// usePatternRotation — the pattern-mode engine for the video wall. Given a
// loaded pattern (its camera_group_ids + dwell seconds) and the camera-group
// catalog, it resolves each group → { layout, camera_ids } and drives the wall
// by calling `applyWallPreset({ layout, tiles })` on a dwell interval, looping.
//
// Robustness: groups referenced but missing (deleted), groups with no cameras,
// and cameras that no longer exist are all skipped gracefully — the rotation
// only ever visits groups that can render something, and if NONE can it stops
// cleanly instead of flashing empty grids.
//
// Session lifecycle: the engine ONLY mutates wall cells via applyWallPreset. The
// per-tile useLiveSession (mounted by each WallTile) owns start/renew/release —
// swapping groups remounts tiles whose cameraId changed, which releases the old
// sessions and starts the new ones. The engine never touches sessions directly.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { mapGroupLayout } from "../videoWall";

export function usePatternRotation({ pattern, groupById, cameraIdSet, applyWallPreset }) {
  const [active, setActive] = useState(false);
  const [paused, setPaused] = useState(false);
  const [index, setIndex] = useState(0);
  const applyRef = useRef(applyWallPreset);
  useEffect(() => {
    applyRef.current = applyWallPreset;
  });

  const seconds = Math.max(1, Number(pattern?.seconds) || 10);

  // Resolve the pattern's group ids → renderable stops. A stop is one group with
  // at least one *existing* camera; unresolvable groups are dropped so rotation
  // never lands on an empty grid.
  const stops = useMemo(() => {
    if (!pattern) return [];
    const ids = pattern.camera_group_ids || [];
    const out = [];
    for (const gid of ids) {
      const g = groupById?.get(gid);
      if (!g) continue; // deleted group
      const cams = (g.camera_ids || []).filter((cid) => !cameraIdSet || cameraIdSet.has(cid));
      if (cams.length === 0) continue; // empty / all-deleted group
      out.push({
        groupId: gid,
        name: g.name,
        layoutKey: g.layout,
        wallLayout: mapGroupLayout(g.layout),
        cameraIds: cams,
      });
    }
    return out;
  }, [pattern, groupById, cameraIdSet]);

  const applyStop = useCallback((stop) => {
    if (!stop) return;
    applyRef.current?.({ layout: stop.wallLayout, tiles: stop.cameraIds });
  }, []);

  // Start / stop from callers.
  const start = useCallback(() => {
    setActive(true);
    setPaused(false);
    setIndex(0);
  }, []);
  const stop = useCallback(() => {
    setActive(false);
    setPaused(false);
    setIndex(0);
  }, []);
  const togglePause = useCallback(() => setPaused((p) => !p), []);

  const go = useCallback(
    (dir) => {
      setIndex((cur) => {
        if (stops.length === 0) return cur;
        return (cur + dir + stops.length) % stops.length;
      });
    },
    [stops.length],
  );
  const next = useCallback(() => go(1), [go]);
  const prev = useCallback(() => go(-1), [go]);

  // When the pattern changes or rotation (re)starts, snap to a valid index and
  // paint the current stop.
  useEffect(() => {
    if (!active) return;
    if (stops.length === 0) {
      // Nothing renderable — bail out so we don't loop on empties.
      setActive(false);
      return;
    }
    setIndex((cur) => (cur >= stops.length ? 0 : cur));
  }, [active, stops.length]);

  // Paint whenever the current stop changes (index or resolved stops).
  const current = stops.length ? stops[Math.min(index, stops.length - 1)] : null;
  useEffect(() => {
    if (active && current) applyStop(current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, current?.groupId, current?.cameraIds.join(",")]);

  // Dwell timer — advance to the next stop every `seconds`, unless paused or
  // there's only one stop (nothing to rotate to).
  useEffect(() => {
    if (!active || paused || stops.length <= 1) return undefined;
    const id = setInterval(() => {
      setIndex((cur) => (cur + 1) % stops.length);
    }, seconds * 1000);
    return () => clearInterval(id);
  }, [active, paused, stops.length, seconds]);

  return {
    active,
    paused,
    index,
    total: stops.length,
    current,
    seconds,
    start,
    stop,
    togglePause,
    next,
    prev,
  };
}

export default usePatternRotation;
