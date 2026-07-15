"use client";

// UnifiedPlayback — ONE synchronized playback workspace (video-wall style) that
// replaces the old Single / Multi / NVR-footage tabs. An operator picks 1..N
// SOURCES — recorded cameras (our pooled storage) and/or NVR channels (a 3rd-party
// recorder's on-board storage) — and plays them all back on ONE master timeline
// with ONE shared transport (play/pause, speed, skip). Single-camera is just the
// one-tile case; NVR footage is just another source kind.
//
//   • Source rail (left)  — toggle [Recorded | NVR]; click to add a tile (cap 16).
//   • Grid (center)       — auto-layout tiles, each a slaved PlaybackPlayer.
//   • Master timeline     — union coverage across every source + event markers.
//   • Focus (⤢)           — expand one tile to the FULL standalone player
//                           (scrub, bookmarks, evidence lock, motion search, export).
//
// Deep-linkable via ?camera=<id>[&t=<iso>] (from the Recordings/Events "Play" action):
// opens that camera as the sole tile and seeks the shared clock to that instant.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Icon } from "@iconify/react";

import { Button, Select } from "@/components/ui/kit";
import { asItems } from "@/lib/format";
import { vms } from "../api";
import PlaybackPlayer from "./PlaybackPlayer";
import ScrubBar from "./ScrubBar";

const DAY_MS = 86_400_000;
const SPEEDS = [0.5, 1, 2, 4, 8, 16];
const MAX_TILES = 16;

// LOCAL calendar date (not UTC) — toISOString() would roll to the wrong day near
// local midnight in offset zones (e.g. 00:30 IST is still the previous UTC day).
const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const dayStartMs = (d) => new Date(`${d}T00:00:00`).getTime();
const iso = (ms) => new Date(ms).toISOString();
const readout = (ms) =>
  ms == null ? "--:--:--" : new Date(ms).toLocaleTimeString(undefined, { hour12: false });

// Grid dimensions scale with the tile count — control-room density (like the
// wall). Returns explicit cols AND rows so the grid FILLS the available height
// exactly (no page scroll): tiles are sized to fit, video letterboxes inside.
function gridDims(n) {
  if (n <= 1) return { cols: 1, rows: 1 };
  if (n <= 2) return { cols: 2, rows: 1 };
  if (n <= 4) return { cols: 2, rows: 2 };
  if (n <= 6) return { cols: 3, rows: 2 };
  if (n <= 9) return { cols: 3, rows: 3 };
  if (n <= 12) return { cols: 4, rows: 3 };
  return { cols: 4, rows: 4 };
}

// A tile descriptor. kind='camera' → our recording; kind='nvr' → device storage.
//   key      unique tile id
//   name     label shown on the tile
//   cameraId real camera id | synthetic `${nvrId}:${channel}` for nvr tiles
//   nvrId/channel present only for nvr tiles
const cameraTile = (c) => ({ key: `cam:${c.id}`, kind: "camera", name: c.name, cameraId: c.id });
const nvrTile = (nvrId, ch, nvrName) => ({
  key: `nvr:${nvrId}:${ch.value}`,
  kind: "nvr",
  name: `${nvrName} · ${ch.label || `Ch ${ch.value}`}`,
  cameraId: `${nvrId}:${ch.value}`,
  nvrId,
  channel: ch.value,
});

export default function UnifiedPlayback({ onExportRange }) {
  const [day, setDay] = useState(todayStr());
  const [sources, setSources] = useState([]); // tile descriptors
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [clock, setClock] = useState(dayStartMs(todayStr())); // shared epoch ms
  const [seekMs, setSeekMs] = useState(null);
  const [seekNonce, setSeekNonce] = useState(0); // bumped ONLY on an explicit user scrub
  const [focusKey, setFocusKey] = useState(null); // tile expanded to full player
  const [pickerKind, setPickerKind] = useState("camera"); // 'camera' | 'nvr'

  const windowStart = dayStartMs(day);
  const windowEnd = windowStart + DAY_MS;
  const tickRef = useRef(null);

  // Reset the shared clock into the window when the day changes.
  useEffect(() => {
    setPlaying(false);
    setClock(windowStart);
    setSeekMs(windowStart);
  }, [windowStart]);

  // ── Deep-link ?camera=<id>[&t=<iso>] → open that camera as the sole tile ──
  const deepHandled = useRef(false);
  const camerasQ = useQuery({
    queryKey: ["vms-cameras", "playback-picker"],
    queryFn: () => vms.cameras.list({ limit: 500 }),
    staleTime: 60_000,
  });
  const cameras = useMemo(() => asItems(camerasQ.data), [camerasQ.data]);

  useEffect(() => {
    if (deepHandled.current || typeof window === "undefined" || cameras.length === 0) return;
    const params = new URLSearchParams(window.location.search);
    const camera = params.get("camera");
    const t = params.get("t");
    if (!camera) return;
    const c = cameras.find((x) => x.id === camera);
    if (!c) return;
    deepHandled.current = true;
    setSources([cameraTile(c)]);
    if (t) {
      const d = new Date(t);
      if (!Number.isNaN(d.getTime())) {
        setDay(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);
        const ms = d.getTime();
        setClock(ms);
        setSeekMs(ms);
      }
    }
  }, [cameras]);

  // ── NVR picker data ──────────────────────────────────────────────────────
  const nvrsQ = useQuery({
    queryKey: ["vms-nvrs", "playback-picker"],
    queryFn: () => vms.nvrs.list({ limit: 200 }),
    staleTime: 60_000,
    enabled: pickerKind === "nvr",
  });
  const nvrs = useMemo(() => asItems(nvrsQ.data), [nvrsQ.data]);
  const [pickNvrId, setPickNvrId] = useState("");
  // NVR channels come from OUR already-loaded, mapped cameras (instant) — NOT a live
  // ONVIF re-enumeration of the device each time (that round-trips to the NVR and is
  // slow). Each mapped camera's nvr_channel_number IS the recording-token index.
  const nvrChannels = useMemo(
    () =>
      cameras
        .filter((c) => c.nvr_id === pickNvrId && c.nvr_channel_number != null)
        .sort((a, b) => (a.nvr_channel_number ?? 0) - (b.nvr_channel_number ?? 0)),
    [cameras, pickNvrId],
  );
  const pickNvrName = useMemo(
    () => nvrs.find((n) => n.id === pickNvrId)?.name || "NVR",
    [nvrs, pickNvrId],
  );

  // ── Union coverage across every selected source ──────────────────────────
  const range = useMemo(() => ({ from: iso(windowStart), to: iso(windowEnd) }), [windowStart, windowEnd]);
  const coverageQs = useQueries({
    queries: sources.map((s) => ({
      queryKey: ["vms-pb-coverage", s.key, day],
      queryFn: () =>
        s.kind === "nvr"
          ? vms.nvrFootage.recordings(s.nvrId, s.channel, range)
          : vms.playback.timeline(s.cameraId, { day }),
      enabled: !!s.key,
      staleTime: 30_000,
      retry: false,
      refetchOnWindowFocus: false,
    })),
  });

  const { mergedCoverage, markers } = useMemo(() => {
    const spans = [];
    const marks = [];
    coverageQs.forEach((q, i) => {
      const s = sources[i];
      const d = q.data;
      if (!d) return;
      if (s?.kind === "nvr") {
        for (const r of asItems(d)) {
          if (!r?.start) continue;
          spans.push([new Date(r.start).getTime(), r.end ? new Date(r.end).getTime() : new Date(r.start).getTime()]);
        }
      } else {
        const cov = Array.isArray(d) ? d : d.coverage || [];
        for (const c of cov) {
          if (!c?.start) continue;
          spans.push([new Date(c.start).getTime(), c.end ? new Date(c.end).getTime() : new Date(c.start).getTime()]);
        }
        for (const m of (Array.isArray(d) ? [] : d.markers || [])) marks.push(m);
      }
    });
    spans.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const [s, e] of spans) {
      const last = merged[merged.length - 1];
      if (last && s <= last[1]) last[1] = Math.max(last[1], e);
      else merged.push([s, e]);
    }
    return {
      mergedCoverage: merged.map(([s, e]) => ({ start: iso(s), end: iso(e) })),
      markers: marks,
    };
  }, [coverageQs, sources, day]);

  // Default the playhead to first coverage when it appears (and not playing).
  const firstCoverageMs = useMemo(() => {
    let min = null;
    for (const c of mergedCoverage) {
      const s = new Date(c.start).getTime();
      if (min == null || s < min) min = s;
    }
    return min;
  }, [mergedCoverage]);
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

  // ── Source add / remove ──────────────────────────────────────────────────
  const hasTile = (key) => sources.some((s) => s.key === key);
  const addTile = (tile) => {
    setSources((s) => (hasTile(tile.key) || s.length >= MAX_TILES ? s : [...s, tile]));
  };
  const removeTile = (key) => {
    setSources((s) => s.filter((x) => x.key !== key));
    if (focusKey === key) setFocusKey(null);
  };

  const onScrub = useCallback((ms) => {
    setPlaying(false);
    setClock(ms);
    setSeekMs(ms);
    setSeekNonce((n) => n + 1); // explicit user scrub → NVR tiles re-request the replay
  }, []);
  const skip = (sec) => onScrub(Math.max(windowStart, Math.min(windowEnd, clock + sec * 1000)));

  // Per-tile source/timeline overrides for NVR tiles.
  const tileSource = (s) =>
    s.kind === "nvr" ? (win) => vms.nvrFootage.playback(s.nvrId, s.channel, win) : null;

  const focusTile = focusKey ? sources.find((s) => s.key === focusKey) : null;

  // ── Source rail lists ────────────────────────────────────────────────────
  const availableCameras = cameras.filter((c) => !hasTile(`cam:${c.id}`));

  return (
    <div className="flex h-full min-h-0 w-full gap-3">
      {/* ── Source rail ─────────────────────────────────────────────────── */}
      <aside className="flex w-64 shrink-0 flex-col rounded-xl border border-card-border bg-card">
        {/* toggle */}
        <div className="flex shrink-0 gap-1 border-b border-card-border p-2">
          {[
            { k: "camera", label: "Recorded", icon: "heroicons-outline:video-camera" },
            { k: "nvr", label: "NVR", icon: "heroicons:server-stack" },
          ].map((t) => (
            <button
              key={t.k}
              type="button"
              onClick={() => setPickerKind(t.k)}
              className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-[13px] transition ${
                pickerKind === t.k
                  ? "bg-foreground text-background font-medium"
                  : "text-muted hover:bg-hover hover:text-foreground"
              }`}
            >
              <Icon icon={t.icon} className="text-sm" />
              {t.label}
            </button>
          ))}
        </div>

        {/* list */}
        <div className="scroll-themed min-h-0 flex-1 overflow-y-auto p-2">
          {pickerKind === "camera" ? (
            availableCameras.length === 0 ? (
              <p className="px-2 py-6 text-center text-xs text-muted">
                {cameras.length ? "All cameras added." : "No cameras."}
              </p>
            ) : (
              availableCameras.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  disabled={sources.length >= MAX_TILES}
                  onClick={() => addTile(cameraTile(c))}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] text-foreground transition hover:bg-hover disabled:opacity-40"
                >
                  <Icon icon="heroicons-outline:video-camera" className="shrink-0 text-sm text-muted" />
                  <span className="truncate">{c.name}</span>
                  <Icon icon="heroicons-outline:plus" className="ml-auto shrink-0 text-sm text-muted" />
                </button>
              ))
            )
          ) : (
            <div className="space-y-2">
              <Select
                value={pickNvrId}
                onChange={(e) => setPickNvrId(e.target.value)}
                options={[
                  { value: "", label: nvrs.length ? "Select NVR…" : "No NVRs" },
                  ...nvrs.map((n) => ({ value: n.id, label: n.name })),
                ]}
                className="!h-8 !py-1"
              />
              {pickNvrId &&
                (nvrChannels.length === 0 ? (
                  <p className="px-2 py-4 text-center text-xs text-muted">No mapped channels.</p>
                ) : (
                  nvrChannels.map((c) => {
                    // NVR footage is keyed by the ONVIF video-source index
                    // (== nvr_channel_number == RecordingToken index). Label with name.
                    const val = String(c.nvr_channel_number);
                    const ch = { value: val, label: c.name || `Channel ${val}` };
                    const label = c.name || `Channel ${val}`;
                    const added = hasTile(`nvr:${pickNvrId}:${val}`);
                    return (
                      <button
                        key={val}
                        type="button"
                        disabled={added || sources.length >= MAX_TILES}
                        onClick={() => addTile(nvrTile(pickNvrId, ch, pickNvrName))}
                        className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] text-foreground transition hover:bg-hover disabled:opacity-40"
                      >
                        <Icon icon="heroicons:server-stack" className="shrink-0 text-sm text-muted" />
                        <span className="truncate">{label}</span>
                        <Icon
                          icon={added ? "heroicons-outline:check" : "heroicons-outline:plus"}
                          className="ml-auto shrink-0 text-sm text-muted"
                        />
                      </button>
                    );
                  })
                ))}
            </div>
          )}
        </div>

        <div className="shrink-0 border-t border-card-border px-3 py-2 text-[11px] text-muted">
          {sources.length}/{MAX_TILES} on timeline
        </div>
      </aside>

      {/* ── Main: grid (or focus) + master transport ────────────────────── */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col rounded-xl border border-card-border bg-card">
        {/* day + clear */}
        <div className="flex shrink-0 items-center gap-2 border-b border-card-border px-3 py-2">
          <input
            type="date"
            value={day}
            max={todayStr()}
            onChange={(e) => setDay(e.target.value)}
            className="h-8 rounded-lg border border-field bg-transparent px-2.5 text-sm text-foreground outline-none focus:border-muted"
          />
          <span className="text-xs text-muted">Union of coverage on one synchronized timeline</span>
          {focusTile && (
            <button
              type="button"
              onClick={() => setFocusKey(null)}
              className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-card-border px-2.5 py-1 text-[13px] text-muted transition hover:bg-hover hover:text-foreground"
            >
              <Icon icon="heroicons-outline:squares-2x2" className="text-sm" /> Back to grid
            </button>
          )}
          {!focusTile && sources.length > 0 && (
            <button
              type="button"
              onClick={() => setSources([])}
              className="ml-auto text-[13px] text-muted transition hover:text-foreground"
            >
              Clear all
            </button>
          )}
        </div>

        {/* body — grid mode FILLS the height (no scroll); focus mode scrolls (tall player). */}
        <div
          className={`min-h-0 flex-1 p-3 ${
            focusTile ? "scroll-themed overflow-y-auto" : "overflow-hidden"
          }`}
        >
          {sources.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center text-center text-muted">
              <Icon icon="heroicons-outline:play" className="mb-3 text-5xl opacity-40" />
              <p className="font-medium text-foreground">No sources on the timeline</p>
              <p className="mt-1 text-sm">
                Add recorded cameras or NVR channels from the left to play them back in sync.
              </p>
            </div>
          ) : focusTile ? (
            /* Focus mode — the FULL standalone player for one source (all tools). */
            <PlaybackPlayer
              key={focusTile.key}
              cameraId={focusTile.cameraId}
              cameraName={focusTile.name}
              sourceFn={tileSource(focusTile)}
              timelineFn={
                focusTile.kind === "nvr"
                  ? () => ({
                      coverage: asItems(
                        coverageQs[sources.findIndex((s) => s.key === focusTile.key)]?.data,
                      ).map((r) => ({ start: r.start, end: r.end })),
                    })
                  : null
              }
              onExportRange={(r) =>
                onExportRange?.({ ...r, cameraId: focusTile.cameraId, cameraName: focusTile.name })
              }
            />
          ) : (
            <div
              className="grid h-full min-h-0 gap-3"
              style={{
                gridTemplateColumns: `repeat(${gridDims(sources.length).cols}, minmax(0, 1fr))`,
                gridTemplateRows: `repeat(${gridDims(sources.length).rows}, minmax(0, 1fr))`,
              }}
            >
              {sources.map((s) => (
                <div key={s.key} className="group relative min-h-0">
                  <div className="absolute left-2 top-2 z-10 flex items-center gap-1.5">
                    <span className="rounded bg-black/60 px-2 py-0.5 text-xs font-medium text-white">
                      {s.name}
                    </span>
                    {s.kind === "nvr" && (
                      <span className="rounded bg-sky-500/70 px-1.5 py-0.5 text-[10px] font-medium uppercase text-white">
                        NVR
                      </span>
                    )}
                  </div>
                  <div className="absolute right-2 top-2 z-10 flex items-center gap-1 opacity-0 transition group-hover:opacity-100">
                    <button
                      type="button"
                      title="Focus (full tools)"
                      onClick={() => setFocusKey(s.key)}
                      className="rounded-full bg-black/60 p-1 text-white/90 transition hover:bg-black/80"
                    >
                      <Icon icon="heroicons-outline:arrows-pointing-out" className="text-sm" />
                    </button>
                    <button
                      type="button"
                      title="Remove"
                      onClick={() => removeTile(s.key)}
                      className="rounded-full bg-black/60 p-1 text-white/90 transition hover:bg-black/80"
                    >
                      <Icon icon="heroicons-outline:x-mark" className="text-sm" />
                    </button>
                  </div>
                  <PlaybackPlayer
                    cameraId={s.cameraId}
                    cameraName={s.name}
                    sourceFn={tileSource(s)}
                    controlled
                    playing={playing}
                    speed={speed}
                    seekMs={seekMs}
                    seekNonce={seekNonce}
                    windowStart={windowStart}
                    windowEnd={windowEnd}
                    className="h-full"
                  />
                </div>
              ))}
            </div>
          )}
        </div>

        {/* master transport (grid mode only) */}
        {sources.length > 0 && !focusTile && (
          <div className="shrink-0 border-t border-card-border p-3">
            <ScrubBar
              coverage={mergedCoverage}
              markers={markers}
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
    </div>
  );
}
