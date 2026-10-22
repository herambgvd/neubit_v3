"use client";

// The live wall's tour: pages of cameras cycled through the layout (SCRUM-339).
import { useCallback, useEffect, useRef, useState } from "react";

import { tourPages, type WallCell } from "../videoWall";
import { prewarmLeadMs } from "./usePatternRotation";

/** The dwell choices, in seconds. */
export const TOUR_DWELLS = [5, 10, 15, 30] as const;
export const DEFAULT_TOUR_DWELL = 10;

/** A remembered dwell, or the default when it is not one of the choices. */
export function tourDwell(v: unknown): number {
  return TOUR_DWELLS.find((s) => s === v) ?? DEFAULT_TOUR_DWELL;
}

/** Why a tour cannot start, or null: it needs more cameras than tiles. */
export function tourBlocked(cameras: number, capacity: number): string | null {
  if (cameras === 0) return "No cameras to tour.";
  if (cameras <= capacity) {
    return `All ${cameras} cameras fit on this wall — a tour needs more cameras than tiles.`;
  }
  return null;
}

/** The page that keeps the current page's first camera on screen at a new page size. */
export function repagedIndex(index: number, fromCapacity: number, toCapacity: number): number {
  return Math.floor((index * fromCapacity) / Math.max(1, toCapacity));
}

interface TourRun {
  ids: string[];
  pages: string[][];
  capacity: number;
  index: number;
  paused: boolean;
  /** Bumped on every page shown; re-arms the dwell. */
  turn: number;
  /** The next page is loading behind the wall. */
  warm: boolean;
}

export interface WallTourOptions {
  /** Paints one page onto the wall. */
  load: (ids: string[]) => void;
  /** The wall as it is now, to put back on Stop. */
  snapshot: () => WallCell[];
  restore: (cells: WallCell[]) => void;
  /** The operator is working a tile (spotlight, PTZ, playback): the page holds. */
  held: boolean;
  /** Seconds per page. */
  seconds: number;
}

export function useWallTour({ load, snapshot, restore, held, seconds }: WallTourOptions) {
  const [run, setRun] = useState<TourRun | null>(null);
  // Which of the wall's two layers is on screen; the other preloads the next page.
  const [slot, setSlot] = useState(0);
  const runRef = useRef(run);
  useEffect(() => {
    runRef.current = run;
  });
  const saved = useRef<WallCell[] | null>(null);

  const show = useCallback(
    (r: TourRun, index: number) => {
      const n = r.pages.length;
      const i = (index + n) % n;
      // That page is already playing behind the wall: swap layers, no reconnect.
      if (r.warm && i === (r.index + 1) % n) setSlot((s) => 1 - s);
      load(r.pages[i]);
      setRun({ ...r, index: i, turn: r.turn + 1, warm: false });
    },
    [load],
  );

  /** Starts paging `ids`; false when they all fit on one page. */
  const start = useCallback(
    (ids: string[], capacity: number) => {
      const pages = tourPages(ids, capacity);
      if (pages.length <= 1) return false;
      saved.current = snapshot();
      show({ ids, pages, capacity, index: 0, paused: false, turn: 0, warm: false }, 0);
      return true;
    },
    [show, snapshot],
  );

  /** Stops and puts the operator's wall back. */
  const stop = useCallback(() => {
    if (saved.current) restore(saved.current);
    saved.current = null;
    setRun(null);
  }, [restore]);

  /** Ends without putting anything back: the operator changed the wall. */
  const end = useCallback(() => {
    saved.current = null;
    setRun(null);
  }, []);

  const step = useCallback(
    (dir: 1 | -1) => {
      const r = runRef.current;
      if (r) show(r, r.index + dir);
    },
    [show],
  );

  const togglePause = useCallback(
    () => setRun((r) => (r ? { ...r, paused: !r.paused, warm: false } : r)),
    [],
  );

  /** Re-pages for a new layout; when everything then fits, shows it all and ends. */
  const relayout = useCallback(
    (capacity: number) => {
      const r = runRef.current;
      if (!r || capacity === r.capacity) return;
      const pages = tourPages(r.ids, capacity);
      if (pages.length <= 1) {
        load(pages[0] ?? []);
        end();
        return;
      }
      show({ ...r, pages, capacity, warm: false }, repagedIndex(r.index, r.capacity, capacity));
    },
    [load, end, show],
  );

  // One page per dwell, the next one preloaded just before; a step, pause or hold re-arms both.
  const ticking = !!run && !run.paused && !held;
  const turn = run?.turn ?? -1;
  useEffect(() => {
    if (!ticking) return undefined;
    const ms = seconds * 1000;
    const warmId = window.setTimeout(
      () => setRun((r) => (r?.turn === turn ? { ...r, warm: true } : r)),
      ms - prewarmLeadMs(ms),
    );
    const nextId = window.setTimeout(() => step(1), ms);
    return () => {
      window.clearTimeout(warmId);
      window.clearTimeout(nextId);
      setRun((r) => (r?.warm ? { ...r, warm: false } : r));
    };
  }, [turn, ticking, seconds, step]);

  return {
    active: !!run,
    paused: !!run?.paused,
    held: !!run && held,
    index: run?.index ?? 0,
    total: run?.pages.length ?? 0,
    slot,
    /** The next page's cameras while it loads behind the wall, else null. */
    preload: ticking && run.warm ? run.pages[(run.index + 1) % run.pages.length] : null,
    start,
    stop,
    end,
    step,
    togglePause,
    relayout,
  };
}

export type WallTour = ReturnType<typeof useWallTour>;
