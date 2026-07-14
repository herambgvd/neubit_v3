"use client";

// MultiPlayback — synchronized multi-camera recorded playback. 2–4 cameras on
// ONE shared timeline + ONE shared transport (play/pause, seek, speed apply to
// all). Each cell is a PlaybackPlayer in `controlled` mode slaved to a shared
// clock (epoch ms). The scrub bar shows the UNION of the selected cameras'
// coverage. Ported from gvd_nvr's MultiCameraPlayback, reskinned to v3.
//
// The shared clock is driven by a rAF-ish interval scaled by speed while
// playing; scrubbing sets a `seekMs` the cells follow.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Icon } from "@iconify/react";

import { Button, Select } from "@/components/ui/kit";
import { asItems } from "@/lib/format";
import { vms } from "../api";
import PlaybackPlayer from "./PlaybackPlayer";
import ScrubBar from "./ScrubBar";

const DAY_MS = 86_400_000;
const SPEEDS = [0.5, 1, 2, 4];
const MAX_CAMS = 4;

const todayStr = () => new Date().toISOString().slice(0, 10);
const dayStartMs = (d) => new Date(`${d}T00:00:00`).getTime();
const readout = (ms) => (ms == null ? "--:--:--" : new Date(ms).toLocaleTimeString(undefined, { hour12: false }));

export default function MultiPlayback() {
  const [day, setDay] = useState(todayStr());
  const [selected, setSelected] = useState([]); // camera ids
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [clock, setClock] = useState(dayStartMs(todayStr())); // shared epoch ms
  const [seekMs, setSeekMs] = useState(null); // pushed to cells on scrub

  const windowStart = dayStartMs(day);
  const windowEnd = windowStart + DAY_MS;
  const tickRef = useRef(null);

  // Reset the clock into the window whenever the day changes.
  useEffect(() => {
    setPlaying(false);
    setClock(windowStart);
    setSeekMs(windowStart);
  }, [windowStart]);

  // ── Cameras (picker) ─────────────────────────────────────────────────────
  const camerasQ = useQuery({
    queryKey: ["vms-cameras", "multi-playback"],
    queryFn: () => vms.cameras.list({ limit: 500 }),
    staleTime: 60_000,
  });
  const cameras = useMemo(() => asItems(camerasQ.data), [camerasQ.data]);
  const cameraNames = useMemo(() => {
    const m = {};
    for (const c of cameras) m[c.id] = c.name;
    return m;
  }, [cameras]);

  // ── Merged coverage across selected cameras ──────────────────────────────
  const timelineQs = useQueries({
    queries: selected.map((id) => ({
      queryKey: ["vms-timeline", id, day, "multi"],
      queryFn: () => vms.playback.timeline(id, { day }),
      enabled: !!id,
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    })),
  });

  const mergedCoverage = useMemo(() => {
    const spans = [];
    for (const q of timelineQs) {
      const d = q.data;
      const cov = Array.isArray(d) ? d : d?.coverage || [];
      for (const c of cov) {
        if (!c?.start) continue;
        spans.push([new Date(c.start).getTime(), c.end ? new Date(c.end).getTime() : new Date(c.start).getTime()]);
      }
    }
    spans.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const [s, e] of spans) {
      const last = merged[merged.length - 1];
      if (last && s <= last[1]) last[1] = Math.max(last[1], e);
      else merged.push([s, e]);
    }
    return merged.map(([s, e]) => ({ start: new Date(s).toISOString(), end: new Date(e).toISOString() }));
  }, [timelineQs]);

  const firstCoverageMs = useMemo(() => {
    let min = null;
    for (const c of mergedCoverage) {
      const s = new Date(c.start).getTime();
      if (min == null || s < min) min = s;
    }
    return min;
  }, [mergedCoverage]);

  // Default the clock to first coverage when it appears.
  useEffect(() => {
    if (firstCoverageMs != null && !playing) {
      setClock(firstCoverageMs);
      setSeekMs(firstCoverageMs);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstCoverageMs]);

  // ── Shared clock ticker ──────────────────────────────────────────────────
  useEffect(() => {
    if (!playing) {
      if (tickRef.current) clearInterval(tickRef.current);
      return undefined;
    }
    tickRef.current = setInterval(() => {
      setClock((prev) => {
        const next = prev + 1000 * speed;
        if (next >= windowEnd) {
          setPlaying(false);
          return windowEnd;
        }
        return next;
      });
    }, 1000);
    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
    };
  }, [playing, speed, windowEnd]);

  const addCamera = (id) => {
    if (!id) return;
    setSelected((s) => (s.includes(id) || s.length >= MAX_CAMS ? s : [...s, id]));
  };
  const removeCamera = (id) => setSelected((s) => s.filter((x) => x !== id));

  const onScrub = useCallback((ms) => {
    setPlaying(false);
    setClock(ms);
    setSeekMs(ms);
  }, []);

  const skip = (sec) => onScrub(Math.max(windowStart, Math.min(windowEnd, clock + sec * 1000)));

  const available = cameras.filter((c) => !selected.includes(c.id));
  const gridCls = selected.length <= 1 ? "grid-cols-1" : "grid-cols-1 sm:grid-cols-2";

  return (
    <div className="rounded-xl border border-card-border bg-card">
      {/* Header: date + camera picker */}
      <div className="flex flex-wrap items-center gap-2 border-b border-card-border p-3">
        <input
          type="date"
          value={day}
          max={todayStr()}
          onChange={(e) => setDay(e.target.value)}
          className="h-9 rounded-lg border border-field bg-transparent px-3 text-sm text-foreground outline-none focus:border-muted"
        />
        <div className="w-56">
          <Select
            value=""
            onChange={(e) => addCamera(e.target.value)}
            placeholder={selected.length >= MAX_CAMS ? `Max ${MAX_CAMS} cameras` : "Add camera…"}
            disabled={selected.length >= MAX_CAMS || available.length === 0}
            options={available.map((c) => ({ value: c.id, label: c.name }))}
            className="!h-9 !py-1.5"
          />
        </div>
        <span className="text-xs text-muted">
          {selected.length}/{MAX_CAMS} cameras · union of coverage on the shared timeline
        </span>
      </div>

      {/* Video grid */}
      <div className="p-3">
        {selected.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-card-border py-20 text-center text-muted">
            <Icon icon="heroicons-outline:squares-2x2" className="mb-3 text-4xl opacity-50" />
            <p className="font-medium text-foreground">No cameras selected</p>
            <p className="mt-1 text-sm">Add up to {MAX_CAMS} cameras to play them back in sync.</p>
          </div>
        ) : (
          <div className={`grid gap-3 ${gridCls}`}>
            {selected.map((id) => (
              <div key={id} className="relative">
                <div className="absolute left-2 top-2 z-10 flex items-center gap-2">
                  <span className="rounded bg-black/60 px-2 py-0.5 text-xs font-medium text-white">
                    {cameraNames[id] || String(id).slice(0, 8)}
                  </span>
                </div>
                <button
                  type="button"
                  title="Remove"
                  onClick={() => removeCamera(id)}
                  className="absolute right-2 top-2 z-10 rounded-full bg-black/60 p-1 text-white/90 transition hover:bg-black/80"
                >
                  <Icon icon="heroicons-outline:x-mark" className="text-sm" />
                </button>
                <PlaybackPlayer
                  cameraId={id}
                  cameraName={cameraNames[id]}
                  controlled
                  playing={playing}
                  speed={speed}
                  seekMs={seekMs}
                  windowStart={windowStart}
                  windowEnd={windowEnd}
                  className="aspect-video"
                />
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Shared transport */}
      {selected.length > 0 && (
        <div className="border-t border-card-border p-3">
          <ScrubBar
            coverage={mergedCoverage}
            windowStart={windowStart}
            windowEnd={windowEnd}
            current={clock}
            onSeek={onScrub}
          />
          <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
            <Button variant="secondary" icon="heroicons-solid:backward" onClick={() => skip(-60)} className="!px-2.5">
              1m
            </Button>
            <Button variant="secondary" onClick={() => skip(-10)} className="!px-2.5">
              10s
            </Button>
            <Button
              variant="primary"
              icon={playing ? "heroicons-solid:pause" : "heroicons-solid:play"}
              onClick={() => setPlaying((p) => !p)}
              className="!px-4"
            >
              {playing ? "Pause" : "Play"}
            </Button>
            <Button variant="secondary" onClick={() => skip(10)} className="!px-2.5">
              10s
            </Button>
            <Button variant="secondary" icon="heroicons-solid:forward" onClick={() => skip(60)} className="!px-2.5">
              1m
            </Button>
            <span className="mx-2 font-mono text-sm tabular-nums text-foreground">{readout(clock)}</span>
            <div className="w-20">
              <Select
                value={String(speed)}
                onChange={(e) => setSpeed(parseFloat(e.target.value))}
                options={SPEEDS.map((s) => ({ value: String(s), label: `${s}×` }))}
                className="!h-8 !py-1"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
