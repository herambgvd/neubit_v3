"use client";

// UnifiedPlayback — ONE synchronized playback workspace (CTOCAM/Lumina NVR style)
// that replaces the old Single / Multi / NVR-footage tabs. An operator uses the
// LEFT RAIL to compose a query — pick a DAY on the month calendar (footage days
// are marked), a STREAM (Main/Sub), event-type filters, and CHECK up to 4 sources
// (recorded cameras from our pooled storage, or 3rd-party NVR channels) — then hits
// SEARCH to load them into a LOCKED 2×2 synced grid that plays on ONE master
// timeline with ONE shared transport (play/pause, speed, skip).
//
//   • Left rail          — [Recorded | NVR] kind · month calendar · Main/Sub stream
//                          · event-type filters · ≤4 checkbox channel multi-select · Search.
//   • Grid (center)      — fixed 2×2, ≤4 slaved PlaybackPlayer tiles + placeholders.
//   • Master timeline    — union coverage across every loaded source + event markers.
//   • Focus (⤢)          — expand one tile to the FULL standalone player
//                          (scrub, bookmarks, evidence lock, motion search, export).
//
// NOTE (3b): the colored-by-trigger seekbar now carries trigger_type through the
// merge; a shared palette (ScrubBar TIMELINE_PALETTE) drives both the bars and the
// legend under the master timeline; `eventFilter` actually filters coverage bars +
// event markers; and the master transport carries an inline snapshot/download/
// fullscreen toolbar (CTOCAM/Lumina). `stream` still drives the recorded profile.
//
// Deep-linkable via ?camera=<id>[&t=<iso>] (from the Recordings/Events "Play" action):
// opens that camera as the sole tile and seeks the shared clock to that instant.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Icon } from "@iconify/react";

import { Button, Select } from "@/components/ui/kit";
import { asItems } from "@/lib/format";
import { sites as sitesApi } from "@/lib/api/sites";
import { vms } from "../api";
import PlaybackPlayer from "./PlaybackPlayer";
import PlaybackCalendar from "./PlaybackCalendar";
import ScrubBar, {
  LEGEND_TYPES,
  TIMELINE_PALETTE,
  triggerToLegend,
  legendKeyForEventType,
} from "./ScrubBar";

const DAY_MS = 86_400_000;
const SPEEDS = [0.5, 1, 2, 4, 8, 16];
// The grid caps at 4 sources (2×2 max), but ADAPTS to the number actually loaded:
// 1→single full player, 2→side-by-side, 3/4→2×2 (with a single empty cell at 3).
const MAX_TILES = 4;

// Adaptive grid geometry — columns × rows for the number of LOADED sources.
// 1 → 1×1 (one big player, no empty cells) · 2 → 2×1 side-by-side · 3/4 → 2×2.
// Only the real tiles are rendered (3 uses 2×2 and leaves ONE cell empty).
const gridDims = (n) => {
  if (n <= 1) return { cols: 1, rows: 1 };
  if (n === 2) return { cols: 2, rows: 1 };
  return { cols: 2, rows: 2 }; // 3 or 4
};
// Client offset FROM UTC in minutes (getTimezoneOffset is the negation), sent to
// the recording-days API so day marks land on the operator's LOCAL calendar.
const TZ_OFFSET_MIN = -new Date().getTimezoneOffset();
// Stream profiles offered by the Stream selector — Sub default (bandwidth), like
// the reference NVR. The chosen profile drives the recorded-playback session.
const STREAMS = [
  { value: "sub", label: "Sub stream" },
  { value: "main", label: "Main stream" },
];
// Event-type filters (3b: wired to the seekbar — hide unchecked coverage bars +
// event markers). Same order/labels as the timeline legend (ScrubBar LEGEND_TYPES).
const EVENT_TYPES = ["Normal", "Motion", "IO", "PIR", "AI", "Alarm", "Manual", "ANR"];

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
// Human duration for the selection readout — mm:ss under a minute-of-hours, else h:mm:ss.
const durReadout = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
};

// A tile descriptor. kind='camera' → our recording; kind='nvr' → device storage.
//   key      unique tile id
//   name     label shown on the tile
//   cameraId real camera id | synthetic `${nvrId}:${channel}` for nvr tiles
//   nvrId/channel present only for nvr tiles
const cameraTile = (c) => ({ key: `cam:${c.id}`, kind: "camera", name: c.name, cameraId: c.id });

// Split a camera name like "NVR 45.64.11.69 - Channel 1" into a clear channel label
// (primary) + its source (muted subtitle) so the sidebar rows don't truncate to "…Chann…".
// Falls back to the whole name as primary when there's no "<source> - <channel>" shape.
const splitCamName = (name = "") => {
  const m = name.match(/^(.*\S)\s*[-·]\s*(.+)$/);
  return m ? { primary: m[2].trim(), secondary: m[1].trim() } : { primary: name, secondary: null };
};
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
  const [sources, setSources] = useState([]); // tile descriptors (loaded on Search)
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [clock, setClock] = useState(dayStartMs(todayStr())); // shared epoch ms
  const [seekMs, setSeekMs] = useState(null);
  const [seekNonce, setSeekNonce] = useState(0); // bumped ONLY on an explicit user scrub
  const [focusKey, setFocusKey] = useState(null); // tile expanded to full player
  const [pickerKind, setPickerKind] = useState("camera"); // 'camera' | 'nvr'
  // Recorded picker scaling (200+ cams): server-side search + site filter so the
  // rail never renders a wall of checkboxes. `camSearch` is the raw input;
  // `debouncedCamSearch` (250ms) is what the camera query actually keys on.
  const [camSearch, setCamSearch] = useState("");
  const [debouncedCamSearch, setDebouncedCamSearch] = useState("");
  const [camSiteFilter, setCamSiteFilter] = useState(""); // "" = all sites
  // Recorded picker tree (Default › Site › Camera) — collapsed branch keys. Empty
  // ⇒ all expanded. While searching we force-expand so every match is visible.
  const [pbCollapsed, setPbCollapsed] = useState(() => new Set());

  // ── Rail composer state (drives the Search → load) ───────────────────────
  // Default to MAIN — that's the profile we record (sub is the live web/WHEP stream, not
  // recorded), so a playback page must open on main or it shows "No footage" by default.
  const [stream, setStream] = useState("main"); // 'main' | 'sub' — recorded profile
  const [eventFilter, setEventFilter] = useState(() => new Set(EVENT_TYPES)); // 3b: filters seekbar
  const [checked, setChecked] = useState([]); // ≤4 pending tile descriptors (pre-Search)
  // Calendar view month (independent of the selected day so paging doesn't re-load).
  const [calView, setCalView] = useState(() => {
    const d = new Date();
    return { year: d.getFullYear(), month: d.getMonth() };
  });

  // ── Timeline range selection (mark-in / mark-out) → clip extract ──────────
  // The operator marks IN (selection start = playhead) and OUT (end = playhead)
  // to pick a sub-range on the master timeline, then "Extract clip" exports JUST
  // that span via the same onExportRange flow the window-download uses. Stored as
  // epoch ms; a valid selection needs both marks AND out > in.
  const [selFrom, setSelFrom] = useState(null);
  const [selTo, setSelTo] = useState(null);

  const windowStart = dayStartMs(day);
  const windowEnd = windowStart + DAY_MS;
  const tickRef = useRef(null);
  const gridWrapRef = useRef(null); // fullscreen target (the grid/focus body)
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Reset the shared clock into the window when the day changes.
  useEffect(() => {
    setPlaying(false);
    setClock(windowStart);
    setSeekMs(windowStart);
    setSelFrom(null); // the old day's selection is meaningless in the new window
    setSelTo(null);
  }, [windowStart]);

  // Debounce the Recorded-picker search into the query key (250ms) so typing
  // doesn't fire a request per keystroke.
  useEffect(() => {
    const id = setTimeout(() => setDebouncedCamSearch(camSearch.trim()), 250);
    return () => clearTimeout(id);
  }, [camSearch]);

  // ── Deep-link ?camera=<id>[&t=<iso>] → open that camera as the sole tile ──
  const deepHandled = useRef(false);
  // Recorded cameras — filtered SERVER-SIDE by the rail's search + site filter so
  // the list stays small at 200+ cameras. Selections live in `checked` (keyed by
  // tile.key) independent of this list, so filtering away a checked camera and
  // back preserves the selection.
  // The filters apply ONLY to the Recorded picker: the NVR channel list + deep-link
  // resolution both derive from `cameras`, so on the NVR picker we drop the filters
  // to get the unfiltered set (a stale Recorded search must not narrow NVR channels).
  const camFiltering = pickerKind === "camera";
  const camQ = camFiltering ? debouncedCamSearch : "";
  const camSite = camFiltering ? camSiteFilter : "";
  const camerasQ = useQuery({
    queryKey: ["vms-cameras", "playback-picker", camQ, camSite],
    queryFn: () =>
      vms.cameras.list({
        q: camQ || undefined,
        site_id: camSite || undefined,
        limit: 200,
      }),
    staleTime: 60_000,
  });
  const cameras = useMemo(() => asItems(camerasQ.data), [camerasQ.data]);

  // Sites for the picker's site-filter dropdown + per-camera group headers. Same
  // source Cameras.jsx uses (site_id → name).
  const sitesQ = useQuery({
    queryKey: ["sites-list"],
    queryFn: () => sitesApi.list({ limit: 200 }),
    staleTime: 60_000,
    enabled: pickerKind === "camera",
  });
  const sites = useMemo(() => asItems(sitesQ.data), [sitesQ.data]);
  const siteNames = useMemo(() => {
    const m = {};
    for (const s of sites) m[s.site_id] = s.name;
    return m;
  }, [sites]);

  useEffect(() => {
    if (deepHandled.current || typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const camera = params.get("camera");
    const t = params.get("t");
    if (!camera) return;
    // The picker list is now server-filtered + capped at 200, so the deep-linked
    // camera may NOT be in it (large tenant / active filter). Resolve from the list
    // when present, else fetch that one camera by id — the deep-link must always open.
    let cancelled = false;
    (async () => {
      let c = cameras.find((x) => x.id === camera);
      if (!c) {
        try {
          c = await vms.cameras.get(camera);
        } catch {
          return;
        }
      }
      if (cancelled || !c || deepHandled.current) return;
      deepHandled.current = true;
      const tile = cameraTile(c);
      setSources([tile]);
      setChecked([tile]); // reflect the deep-linked source in the rail's multi-select
      if (t) {
        const d = new Date(t);
        if (!Number.isNaN(d.getTime())) {
          setDay(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);
          setCalView({ year: d.getFullYear(), month: d.getMonth() }); // page the calendar to it
          const ms = d.getTime();
          setClock(ms);
          setSeekMs(ms);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
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

  // ── Calendar footage marks ───────────────────────────────────────────────
  // The calendar tracks the FIRST-selected channel's footage-days for the month
  // in view (a checked channel takes priority; else the first loaded source). No
  // channel chosen yet → no marks (fine). `month` is the visible YYYY-MM.
  const calMonth = `${calView.year}-${String(calView.month + 1).padStart(2, "0")}`;
  const calTrack = checked[0] || sources[0] || null;
  const recordingDaysQ = useQuery({
    queryKey: ["vms-recording-days", calTrack?.key, calMonth],
    queryFn: () =>
      calTrack?.kind === "nvr"
        ? vms.nvrFootage.recordingDays(calTrack.nvrId, calTrack.channel, {
            month: calMonth,
            tzOffsetMinutes: TZ_OFFSET_MIN,
          })
        : vms.playback.recordingDays(calTrack.cameraId, {
            month: calMonth,
            tzOffsetMinutes: TZ_OFFSET_MIN,
          }),
    enabled: !!calTrack,
    staleTime: 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const footageDays = useMemo(
    () => new Set(recordingDaysQ.data?.days || []),
    [recordingDaysQ.data],
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

  // Union coverage + markers across the ≤4 sources, KEEPING each span's trigger_type
  // so the seekbar can color it (via the shared palette). NVR footage has no trigger
  // → default "continuous" (Normal). Merging only fuses TOUCHING spans of the SAME
  // trigger; different triggers stay separate items (matches the backend model), so a
  // motion span never gets swallowed into a continuous one. The event-type filter then
  // hides coverage/markers whose legend bucket is unchecked.
  const { mergedCoverage, markers } = useMemo(() => {
    const spans = []; // { s, e, trigger } (trigger = backend trigger_type)
    const marks = [];
    coverageQs.forEach((q, i) => {
      const s = sources[i];
      const d = q.data;
      if (!d) return;
      if (s?.kind === "nvr") {
        // 3rd-party NVR ranges carry no trigger → neutral "continuous" (Normal).
        for (const r of asItems(d)) {
          if (!r?.start) continue;
          spans.push({
            s: new Date(r.start).getTime(),
            e: r.end ? new Date(r.end).getTime() : new Date(r.start).getTime(),
            trigger: r.trigger_type || r.trigger || "continuous",
          });
        }
      } else {
        const cov = Array.isArray(d) ? d : d.coverage || [];
        for (const c of cov) {
          if (!c?.start) continue;
          spans.push({
            s: new Date(c.start).getTime(),
            e: c.end ? new Date(c.end).getTime() : new Date(c.start).getTime(),
            trigger: c.trigger_type || c.trigger || "continuous",
          });
        }
        for (const m of Array.isArray(d) ? [] : d.markers || []) marks.push(m);
      }
    });

    // Filter coverage by the event-type filter (trigger_type → legend bucket), then
    // sort + merge same-trigger touching spans (leaving different triggers distinct).
    const kept = spans.filter((sp) => eventFilter.has(triggerToLegend(sp.trigger)));
    kept.sort((a, b) => a.s - b.s || a.e - b.e);
    const merged = [];
    for (const sp of kept) {
      const last = merged[merged.length - 1];
      if (last && sp.trigger === last.trigger && sp.s <= last.e) {
        last.e = Math.max(last.e, sp.e); // fuse touching same-trigger spans
      } else {
        merged.push({ ...sp });
      }
    }

    // Filter markers by the same event-filter (event_type → legend bucket).
    const keptMarks = marks.filter((m) => eventFilter.has(legendKeyForEventType(m.event_type)));

    return {
      mergedCoverage: merged.map((m) => ({ start: iso(m.s), end: iso(m.e), trigger_type: m.trigger })),
      markers: keptMarks,
    };
  }, [coverageQs, sources, day, eventFilter]);

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
      // Pull any live NVR tiles to this instant too, so the picture matches the clock
      // (their real-time WHEP replays can't seek — only a re-pull moves them).
      setSeekNonce((n) => n + 1);
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

  // ── Rail multi-select (pre-Search) ───────────────────────────────────────
  // The operator CHECKS up to 4 channels in the rail; nothing loads until Search.
  const isChecked = (key) => checked.some((t) => t.key === key);
  const atCap = checked.length >= MAX_TILES;
  const toggleCheck = (tile) => {
    setChecked((prev) => {
      const already = prev.some((t) => t.key === tile.key);
      if (already) return prev.filter((t) => t.key !== tile.key);
      if (prev.length >= MAX_TILES) return prev; // enforce ≤4
      return [...prev, tile];
    });
  };

  // ── Search — load the checked (≤4) channels into the 2×2 grid ─────────────
  // Replaces the current grid with the checked selection for the selected day.
  // NVR tiles are real-time WHEP replays that can't seek, so line every tile up to
  // the SAME footage-instant by re-pulling from the shared clock (seekNonce bump);
  // the day-change effect + firstCoverage default handle the initial playhead.
  const loadSelection = () => {
    if (checked.length === 0) return;
    setSources(checked.slice(0, MAX_TILES));
    setFocusKey(null);
    const syncMs = windowStart;
    setPlaying(false);
    setClock(syncMs);
    setSeekMs(syncMs);
    setSeekNonce((n) => n + 1);
  };

  const removeTile = (key) => {
    setSources((s) => s.filter((x) => x.key !== key));
    setChecked((c) => c.filter((x) => x.key !== key)); // keep the rail in sync
    if (focusKey === key) setFocusKey(null);
  };

  const onScrub = useCallback((ms) => {
    setPlaying(false);
    setClock(ms);
    setSeekMs(ms);
    setSeekNonce((n) => n + 1); // explicit user scrub → NVR tiles re-request the replay
  }, []);
  const skip = (sec) => onScrub(Math.max(windowStart, Math.min(windowEnd, clock + sec * 1000)));

  const focusTile = focusKey ? sources.find((s) => s.key === focusKey) : null;

  // ── Inline master toolbar actions (snapshot / download / fullscreen) ───────
  // The active source = the focused tile, else the first loaded tile — the one the
  // toolbar operates on. Snapshot + Download target it.
  const activeSource = focusTile || sources[0] || null;

  // Snapshot: controlled tiles don't expose a snapshot callback, so grab the frame
  // straight off the active tile's <video> element in the grid (first tile = first
  // <video> in the grid wrapper). Draws it to a canvas and downloads a PNG.
  const snapshotActive = useCallback(() => {
    const root = gridWrapRef.current;
    const v = root?.querySelector("video");
    if (!v || !v.videoWidth) return; // nothing decodable yet
    try {
      const canvas = document.createElement("canvas");
      canvas.width = v.videoWidth;
      canvas.height = v.videoHeight;
      canvas.getContext("2d").drawImage(v, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((blob) => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        const stamp = readout(clock).replace(/:/g, "-");
        a.href = url;
        a.download = `${activeSource?.name || "snapshot"}-${stamp}.png`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, "image/png");
    } catch {
      /* frame not readable (cross-origin / not yet decoded) */
    }
  }, [clock, activeSource]);

  // Download / clip: export the visible window of the ACTIVE source, reusing the same
  // export flow the focus player uses (`onExportRange`). Camera tiles export by real
  // cameraId; NVR tiles don't have a native VMS export path → skip (button disabled).
  const downloadActive = useCallback(() => {
    if (!activeSource || activeSource.kind === "nvr") return;
    onExportRange?.({
      from: iso(windowStart),
      to: iso(windowEnd),
      cameraId: activeSource.cameraId,
      cameraName: activeSource.name,
    });
  }, [activeSource, onExportRange, windowStart, windowEnd]);

  // ── Mark-in / mark-out selection → clip extract ──────────────────────────
  // "Mark in" plants the selection start at the current playhead; "Mark out" the
  // end. Marking OUT before IN (or a to earlier than from) auto-swaps so the band
  // is always [min,max]. A valid selection = both set AND to > from.
  const markIn = useCallback(() => {
    setSelFrom(clock);
    // If an out-mark already sits at/before the new in-mark, drop it (stale).
    setSelTo((prev) => (prev != null && prev <= clock ? null : prev));
  }, [clock]);
  const markOut = useCallback(() => {
    // If no in-mark yet, or the playhead is before it, treat this click as setting
    // the earlier bound (in) so the operator can mark in either order.
    setSelFrom((prevFrom) => {
      if (prevFrom == null || clock < prevFrom) {
        setSelTo(prevFrom); // the old in becomes the out when we cross behind it
        return clock;
      }
      setSelTo(clock);
      return prevFrom;
    });
  }, [clock]);
  const clearSelection = useCallback(() => {
    setSelFrom(null);
    setSelTo(null);
  }, []);

  // A valid selection = both marks present and out strictly after in.
  const hasSelection = selFrom != null && selTo != null && selTo > selFrom;
  const selDurationMs = hasSelection ? selTo - selFrom : 0;

  // Extract clip: export ONLY the selected sub-range of the ACTIVE source, reusing
  // the same onExportRange flow as the window-download. Camera tiles only (NVR has
  // no native VMS export path) — gated the same as downloadActive.
  const extractClip = useCallback(() => {
    if (!hasSelection || !activeSource || activeSource.kind === "nvr") return;
    onExportRange?.({
      from: iso(selFrom),
      to: iso(selTo),
      cameraId: activeSource.cameraId,
      cameraName: activeSource.name,
    });
  }, [hasSelection, activeSource, onExportRange, selFrom, selTo]);

  // Fullscreen: toggle the Fullscreen API on the grid/focus body wrapper.
  const toggleFullscreen = useCallback(() => {
    const el = gridWrapRef.current;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen?.();
    else el.requestFullscreen?.();
  }, []);
  useEffect(() => {
    const onFs = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  // Per-tile source/timeline overrides for NVR tiles.
  const tileSource = (s) =>
    s.kind === "nvr" ? (win) => vms.nvrFootage.playback(s.nvrId, s.channel, win) : null;

  // ── Rail channel list — recorded cameras (checkbox multi-select) ──────────
  // Cameras arrive already filtered server-side (search + site). Group them by
  // site for scannable sticky sub-headers; cameras with no placement site fall
  // into an "Unassigned" group pinned to the end.
  const railCameras = cameras;
  const camGroups = useMemo(() => {
    const bySite = new Map(); // site_id → { name, cameras: [] }
    let unassigned = null;
    for (const c of railCameras) {
      const sid = c.placement?.site_id;
      if (sid) {
        if (!bySite.has(sid)) bySite.set(sid, { key: sid, name: siteNames[sid] || "Site", cameras: [] });
        bySite.get(sid).cameras.push(c);
      } else {
        if (!unassigned) unassigned = { key: "__unassigned", name: "Unassigned", cameras: [] };
        unassigned.cameras.push(c);
      }
    }
    const groups = Array.from(bySite.values()).sort((a, b) => a.name.localeCompare(b.name));
    if (unassigned) groups.push(unassigned);
    return groups;
  }, [railCameras, siteNames]);

  return (
    // transform:translateZ(0) — pin this whole surface to its own GPU compositing
    // layer. Fixes a Chrome scroll-repaint glitch where, after scrolling the channel
    // rail + re-rendering (checking a box), the browser leaves stale white below the
    // fold even though the DOM is full-height (verified: shell/main/aside all correct).
    // Isolating the layer forces a clean repaint. No fixed-positioned descendants here
    // (ExportDialog is a sibling), so this is safe.
    <div className="flex h-full min-h-0 w-full gap-3 [transform:translateZ(0)]">
      {/* ── Composer rail ──────────────────────────────────────────────────
          Calendar → Stream → Event filters → Channel multi-select (≤4) → Search. */}
      <aside className="flex w-64 shrink-0 flex-col rounded-xl border border-card-border bg-card [transform:translateZ(0)]">
        {/* composer — calendar · stream · event filters · channel multi-select */}
        <div className="scroll-themed min-h-0 flex-1 overflow-y-auto p-3">
          {/* ── Month calendar (footage days marked) ── */}
          <PlaybackCalendar
            viewYear={calView.year}
            viewMonth={calView.month}
            selected={day}
            footageDays={footageDays}
            onSelectDay={setDay}
            onPrevMonth={() =>
              setCalView((v) =>
                v.month === 0
                  ? { year: v.year - 1, month: 11 }
                  : { ...v, month: v.month - 1 },
              )
            }
            onNextMonth={() =>
              setCalView((v) =>
                v.month === 11
                  ? { year: v.year + 1, month: 0 }
                  : { ...v, month: v.month + 1 },
              )
            }
          />

          {/* ── Stream (Main / Sub) ── */}
          <div className="mt-4">
            <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted">Stream</p>
            <div className="flex gap-1">
              {STREAMS.map((s) => (
                <button
                  key={s.value}
                  type="button"
                  onClick={() => setStream(s.value)}
                  className={`flex-1 rounded-lg px-2 py-1.5 text-[12px] transition ${
                    stream === s.value
                      ? "bg-foreground font-medium text-background"
                      : "text-muted hover:bg-hover hover:text-foreground"
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>

          {/* ── Event-type filters — filter the seekbar coverage bars + markers ── */}
          <div className="mt-4">
            <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted">
              Event types
            </p>
            <div className="grid grid-cols-2 gap-x-2 gap-y-1">
              {EVENT_TYPES.map((et) => {
                const on = eventFilter.has(et);
                return (
                  <label
                    key={et}
                    className="flex cursor-pointer items-center gap-1.5 rounded-md px-1 py-0.5 text-[12px] text-foreground hover:bg-hover"
                  >
                    <span
                      className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border transition ${
                        on ? "border-foreground bg-foreground text-background" : "border-field"
                      }`}
                    >
                      {on && <Icon icon="heroicons-solid:check" className="text-[10px]" />}
                    </span>
                    <input
                      type="checkbox"
                      className="sr-only"
                      checked={on}
                      onChange={() =>
                        setEventFilter((prev) => {
                          const next = new Set(prev);
                          if (next.has(et)) next.delete(et);
                          else next.add(et);
                          return next;
                        })
                      }
                    />
                    {et}
                  </label>
                );
              })}
            </div>
          </div>

          {/* ── Channel / camera multi-select (≤4) ── */}
          <div className="mt-4">
            <div className="mb-1.5 flex items-center justify-between">
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted">Channels</p>
              <span className={`text-[11px] ${atCap ? "text-red-400" : "text-muted"}`}>
                {checked.length}/{MAX_TILES}
              </span>
            </div>

            {/* kind toggle [Recorded | NVR] */}
            <div className="mb-2 flex gap-1">
              {[
                { k: "camera", label: "Recorded", icon: "heroicons-outline:video-camera" },
                { k: "nvr", label: "NVR", icon: "heroicons:server-stack" },
              ].map((t) => (
                <button
                  key={t.k}
                  type="button"
                  onClick={() => setPickerKind(t.k)}
                  className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-[12px] transition ${
                    pickerKind === t.k
                      ? "bg-hover font-medium text-foreground"
                      : "text-muted hover:bg-hover hover:text-foreground"
                  }`}
                >
                  <Icon icon={t.icon} className="text-sm" />
                  {t.label}
                </button>
              ))}
            </div>

            {atCap && (
              <p className="mb-1.5 text-[11px] text-red-400">Max 4 channels — uncheck one to add another.</p>
            )}

            {pickerKind === "camera" ? (
              <div className="space-y-2">
                {/* Server-side search + site filter keep the list navigable at 200+ cams. */}
                <label className="relative block">
                  <Icon
                    icon="heroicons-outline:magnifying-glass"
                    className="absolute left-2.5 top-1/2 -translate-y-1/2 text-sm text-muted"
                  />
                  <input
                    value={camSearch}
                    onChange={(e) => setCamSearch(e.target.value)}
                    placeholder="Search cameras…"
                    className="h-8 w-full rounded-lg border border-field bg-transparent pl-8 pr-3 text-[13px] text-foreground placeholder:text-muted outline-none focus:border-muted"
                  />
                </label>
                <Select
                  value={camSiteFilter}
                  onChange={(e) => setCamSiteFilter(e.target.value)}
                  options={[
                    { value: "", label: "All sites" },
                    ...sites.map((s) => ({ value: s.site_id, label: s.name })),
                  ]}
                  className="!h-8 !py-1"
                />

                {camerasQ.isLoading ? (
                  <p className="px-2 py-6 text-center text-xs text-muted">Loading…</p>
                ) : railCameras.length === 0 ? (
                  <p className="px-2 py-6 text-center text-xs text-muted">No cameras.</p>
                ) : (
                  (() => {
                    // Tree: Default › Site › Camera (scales for many cameras). Search
                    // (server-side) force-expands via pbSearching.
                    const pbSearching = camSearch.trim().length > 0;
                    const pbOpen = (k) => pbSearching || !pbCollapsed.has(k);
                    const pbToggle = (k) =>
                      setPbCollapsed((prev) => {
                        const n = new Set(prev);
                        n.has(k) ? n.delete(k) : n.add(k);
                        return n;
                      });
                    const renderCamRow = (c) => {
                      const { primary, secondary } = splitCamName(c.name);
                      const tile = cameraTile(c);
                      const on = isChecked(tile.key);
                      return (
                        <label
                          key={c.id}
                          title={c.name}
                          className={`flex w-full cursor-pointer items-center gap-2 rounded-lg py-1.5 pl-2 pr-2 text-left text-[13px] text-foreground transition hover:bg-hover ${
                            !on && atCap ? "opacity-40" : ""
                          }`}
                        >
                          <input
                            type="checkbox"
                            className="sr-only"
                            checked={on}
                            disabled={!on && atCap}
                            onChange={() => toggleCheck(tile)}
                          />
                          <span
                            className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border transition ${
                              on ? "border-foreground bg-foreground text-background" : "border-field"
                            }`}
                          >
                            {on && <Icon icon="heroicons-solid:check" className="text-[11px]" />}
                          </span>
                          {c.nvr_channel_number != null && (
                            <span className="flex h-5 min-w-[1.5rem] shrink-0 items-center justify-center rounded bg-hover px-1 font-mono text-[11px] font-semibold tabular-nums text-muted">
                              {c.nvr_channel_number}
                            </span>
                          )}
                          <span className="min-w-0 flex-1">
                            <span className="block truncate">{primary}</span>
                            {secondary && (
                              <span className="block truncate text-[11px] text-muted">{secondary}</span>
                            )}
                          </span>
                        </label>
                      );
                    };
                    const rootOpen = pbOpen("__pb_root__");
                    return (
                      <div>
                        <button
                          type="button"
                          onClick={() => pbToggle("__pb_root__")}
                          className="flex w-full items-center gap-1.5 rounded-lg px-1.5 py-1.5 text-left transition hover:bg-hover"
                        >
                          <Icon
                            icon="heroicons-mini:chevron-right"
                            className={`shrink-0 text-sm text-muted transition-transform ${rootOpen ? "rotate-90" : ""}`}
                          />
                          <Icon icon="heroicons-outline:building-office-2" className="shrink-0 text-sm text-muted" />
                          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-foreground">Default</span>
                          <span className="shrink-0 rounded-full bg-hover px-1.5 text-[10px] font-semibold tabular-nums text-muted">
                            {railCameras.length}
                          </span>
                        </button>
                        {rootOpen && (
                          <div className="mt-0.5 space-y-0.5 border-l border-card-border/60 pl-1.5">
                            {camGroups.map((g) => {
                              const open = pbOpen(g.key);
                              return (
                                <div key={g.key}>
                                  <button
                                    type="button"
                                    onClick={() => pbToggle(g.key)}
                                    className="flex w-full items-center gap-1.5 rounded-lg px-1.5 py-1.5 text-left transition hover:bg-hover"
                                  >
                                    <Icon
                                      icon="heroicons-mini:chevron-right"
                                      className={`shrink-0 text-sm text-muted transition-transform ${open ? "rotate-90" : ""}`}
                                    />
                                    <Icon
                                      icon={g.key === "__unassigned" ? "heroicons-outline:inbox" : "heroicons-outline:map-pin"}
                                      className="shrink-0 text-sm text-muted"
                                    />
                                    <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">{g.name}</span>
                                    <span className="shrink-0 rounded-full bg-hover px-1.5 text-[10px] font-semibold tabular-nums text-muted">
                                      {g.cameras.length}
                                    </span>
                                  </button>
                                  {open && (
                                    <div className="border-l border-card-border/60 pl-1.5">
                                      {g.cameras.map(renderCamRow)}
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })()
                )}
              </div>
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
                      // The NVR is already chosen in the dropdown above, so strip the
                      // redundant "<nvr name> - " prefix → clean per-channel label. A
                      // CH-number chip stays always visible.
                      const raw = c.name || `Channel ${val}`;
                      const clean =
                        pickNvrName && raw.startsWith(pickNvrName)
                          ? raw.slice(pickNvrName.length).replace(/^\s*[-·:]\s*/, "").trim() ||
                            `Channel ${val}`
                          : raw;
                      const tile = nvrTile(pickNvrId, ch, pickNvrName);
                      const on = isChecked(tile.key);
                      return (
                        <label
                          key={val}
                          title={c.name || `Channel ${val}`}
                          className={`flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] text-foreground transition hover:bg-hover ${
                            !on && atCap ? "opacity-40" : ""
                          }`}
                        >
                          <input
                            type="checkbox"
                            className="sr-only"
                            checked={on}
                            disabled={!on && atCap}
                            onChange={() => toggleCheck(tile)}
                          />
                          <span
                            className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border transition ${
                              on ? "border-foreground bg-foreground text-background" : "border-field"
                            }`}
                          >
                            {on && <Icon icon="heroicons-solid:check" className="text-[11px]" />}
                          </span>
                          <span className="flex h-5 min-w-[1.5rem] shrink-0 items-center justify-center rounded bg-hover px-1 font-mono text-[11px] font-semibold tabular-nums text-muted">
                            {val}
                          </span>
                          <span className="truncate">{clean}</span>
                        </label>
                      );
                    })
                  ))}
              </div>
            )}
          </div>
        </div>

        {/* ── Search / Load ── */}
        <div className="shrink-0 border-t border-card-border p-2">
          <Button
            variant="primary"
            icon="heroicons-outline:magnifying-glass"
            onClick={loadSelection}
            disabled={checked.length === 0}
            className="w-full justify-center"
          >
            Search
          </Button>
        </div>
      </aside>

      {/* ── Main: grid (or focus) + master transport ────────────────────── */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col rounded-xl border border-card-border bg-card">
        {/* selected day + focus/clear (day is driven by the rail calendar now) */}
        <div className="flex shrink-0 items-center gap-2 border-b border-card-border px-3 py-2">
          <Icon icon="heroicons-outline:calendar-days" className="text-sm text-muted" />
          <span className="text-sm font-medium text-foreground tabular-nums">{day}</span>
          <span className="text-xs text-muted">· 2×2 synchronized playback</span>
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
              onClick={() => {
                setSources([]);
                setChecked([]);
              }}
              className="ml-auto text-[13px] text-muted transition hover:text-foreground"
            >
              Clear all
            </button>
          )}
        </div>

        {/* body — grid mode FILLS the height (no scroll); focus mode scrolls (tall player).
            gridWrapRef is the Fullscreen API target + the root the toolbar snapshots. */}
        <div
          ref={gridWrapRef}
          className={`min-h-0 flex-1 p-3 ${
            focusTile ? "scroll-themed overflow-y-auto" : "overflow-hidden"
          } ${isFullscreen ? "bg-card" : ""}`}
        >
          {sources.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center text-center text-muted">
              <Icon icon="heroicons-outline:play" className="mb-3 text-5xl opacity-40" />
              <p className="font-medium text-foreground">No sources loaded</p>
              <p className="mt-1 text-sm">
                Pick a day, check up to 4 channels on the left, and hit Search to play them in sync.
              </p>
            </div>
          ) : focusTile ? (
            /* Focus mode — the FULL standalone player for one source (all tools). */
            <PlaybackPlayer
              key={focusTile.key}
              cameraId={focusTile.cameraId}
              cameraName={focusTile.name}
              sourceFn={tileSource(focusTile)}
              profile={stream}
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
            /* ADAPTIVE grid — sizes to the number of LOADED sources (capped 2×2):
               1→single full player · 2→side-by-side · 3/4→2×2. Only the real tiles
               render (no empty placeholders for 1/2; 3 leaves ONE 2×2 cell blank). */
            <div
              className="grid h-full min-h-0 gap-3"
              style={{
                gridTemplateColumns: `repeat(${gridDims(sources.length).cols}, minmax(0, 1fr))`,
                gridTemplateRows: `repeat(${gridDims(sources.length).rows}, minmax(0, 1fr))`,
              }}
            >
              {sources.map((s) => {
                return (
                  // h-full → fill the grid CELL (don't let the <video>'s intrinsic size
                  // dictate height); overflow-hidden + min-h-0 → the cell can shrink so the
                  // flex body absorbs a taller transport (e.g. the selection readout row)
                  // instead of overflowing the bounded pane and breaking the page layout.
                  <div key={s.key} className="group relative h-full min-h-0 overflow-hidden">
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
                      {/* Focus → the full standalone player (evidence-lock, bookmarks,
                          motion-search) is the ONLY access point for a specific camera's
                          advanced tools in MULTI-cam. It's redundant for a single loaded
                          source (that tile already fills the full-area player), so hide it. */}
                      {sources.length > 1 && (
                        <button
                          type="button"
                          title="Focus (full tools)"
                          onClick={() => setFocusKey(s.key)}
                          className="rounded-full bg-black/60 p-1 text-white/90 transition hover:bg-black/80"
                        >
                          <Icon icon="heroicons-outline:arrows-pointing-out" className="text-sm" />
                        </button>
                      )}
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
                      profile={stream}
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
                );
              })}
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
              selectionStart={selFrom}
              selectionEnd={selTo}
            />

            {/* Legend — swatch → label for the 8 event-type buckets, sharing the SAME
                palette as the seekbar bars. Unchecked types are dimmed (they're
                filtered out of the timeline above). Click toggles the filter too. */}
            <div className="mt-2 flex flex-wrap items-center justify-center gap-x-3 gap-y-1">
              {LEGEND_TYPES.map((t) => {
                const on = eventFilter.has(t);
                return (
                  <button
                    key={t}
                    type="button"
                    title={on ? `Hide ${t}` : `Show ${t}`}
                    onClick={() =>
                      setEventFilter((prev) => {
                        const next = new Set(prev);
                        if (next.has(t)) next.delete(t);
                        else next.add(t);
                        return next;
                      })
                    }
                    className={`inline-flex items-center gap-1.5 text-[11px] transition ${
                      on ? "text-foreground" : "text-muted line-through opacity-50"
                    }`}
                  >
                    <span className={`h-2.5 w-3.5 rounded-sm ${TIMELINE_PALETTE[t].cls}`} />
                    {TIMELINE_PALETTE[t].label}
                  </button>
                );
              })}
            </div>

            {/* Master transport + inline player toolbar (CTOCAM/Lumina). Left: skip /
                play-pause / skip + clock + speed. Right (toolbar): snapshot · download
                (clip export) · fullscreen — always visible while sources are loaded. */}
            <div className="relative mt-3 flex flex-wrap items-center justify-center gap-2">
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

              {/* Clip-selection group — Mark in / Mark out plant the selection band
                  on the timeline; Extract clip exports JUST that sub-range. */}
              <div className="ml-2 flex items-center gap-1 border-l border-card-border pl-2">
                <ToolBtn
                  label="IN"
                  title={`Mark in (selection start) · ${readout(clock)}`}
                  onClick={markIn}
                />
                <ToolBtn
                  label="OUT"
                  title={`Mark out (selection end) · ${readout(clock)}`}
                  onClick={markOut}
                />
                <ToolBtn
                  icon="heroicons-outline:scissors"
                  title={
                    activeSource?.kind === "nvr"
                      ? "Clip extract unavailable for NVR channels"
                      : !hasSelection
                        ? "Mark in + out to select a section to extract"
                        : `Extract clip ${readout(selFrom)}–${readout(selTo)}${
                            activeSource ? ` · ${activeSource.name}` : ""
                          }`
                  }
                  onClick={extractClip}
                  disabled={!hasSelection || !activeSource || activeSource.kind === "nvr"}
                />
                {hasSelection && (
                  <ToolBtn
                    icon="heroicons-outline:x-mark"
                    title="Clear selection"
                    onClick={clearSelection}
                  />
                )}
              </div>

              {/* Snapshot / whole-window download / fullscreen — operate on the
                  active tile (focused, else first). */}
              <div className="ml-2 flex items-center gap-1 border-l border-card-border pl-2">
                <ToolBtn
                  icon="heroicons-outline:camera"
                  title={`Snapshot${activeSource ? ` · ${activeSource.name}` : ""}`}
                  onClick={snapshotActive}
                />
                <ToolBtn
                  icon="heroicons-outline:arrow-down-tray"
                  title={
                    activeSource?.kind === "nvr"
                      ? "Export unavailable for NVR channels"
                      : `Download this whole window${activeSource ? ` · ${activeSource.name}` : ""}`
                  }
                  onClick={downloadActive}
                  disabled={!activeSource || activeSource.kind === "nvr"}
                />
                <ToolBtn
                  icon={
                    isFullscreen
                      ? "heroicons-outline:arrows-pointing-in"
                      : "heroicons-outline:arrows-pointing-out"
                  }
                  title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
                  onClick={toggleFullscreen}
                />
              </div>
            </div>

            {/* Selection readout — the marked [from–to] span + duration, with the
                Extract-clip affordance echoed as text for clarity. Only shown once a
                valid section is marked. */}
            {hasSelection && (
              <div className="mt-2 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-[12px]">
                <span className="inline-flex items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 font-mono tabular-nums text-amber-300">
                  <Icon icon="heroicons-outline:scissors" className="text-[13px]" />
                  {readout(selFrom)} – {readout(selTo)}
                  <span className="text-amber-400/70">({durReadout(selDurationMs)})</span>
                </span>
                {activeSource?.kind === "nvr" && (
                  <span className="text-[11px] text-muted">Clip extract is unavailable for NVR channels.</span>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// Toolbar button — matches PlaybackPlayer's CtrlBtn "plain" skin so the master
// toolbar reads the same as the focus player's controls. Renders an icon by
// default; pass `label` for a short TEXT affordance instead (e.g. "IN"/"OUT",
// used by mark-in/out — guaranteed-visible, no icon-set dependency).
function ToolBtn({ icon, label, title, onClick, disabled }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-card-border text-muted transition hover:bg-hover hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
    >
      {label ? (
        <span className="text-[11px] font-semibold tracking-wide">{label}</span>
      ) : (
        <Icon icon={icon} className="text-base" />
      )}
    </button>
  );
}
