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
import { skipToken, useQueries, useQuery } from "@tanstack/react-query";
import { Icon } from "@iconify/react";

import { Button, Select } from "@/components/ui/kit";
import { apiError } from "@/lib/api";
import { vms } from "../api";
import type {
  FederatedCamera,
  FederatedTimeline,
  PlaybackSourceFn,
  RecordingDaysResponse,
  TimelineMarker,
} from "../types";
import PlaybackPlayer from "./PlaybackPlayer";
import PlaybackCalendar from "./PlaybackCalendar";
import PlaybackChannelPicker, { type PickerGroup } from "./PlaybackChannelPicker";
import type { ExportRequest } from "./playbackTypes";
import ScrubBar, {
  LEGEND_TYPES,
  TIMELINE_PALETTE,
  triggerToLegend,
  legendKeyForEventType,
  type LegendType,
} from "./ScrubBar";

const DAY_MS = 86_400_000;
const SPEEDS = [0.5, 1, 2, 4, 8, 16];
// The grid caps at 4 sources (2×2 max), but ADAPTS to the number actually loaded:
// 1→single full player, 2→side-by-side, 3/4→2×2 (with a single empty cell at 3).
const MAX_TILES = 4;

// Adaptive grid geometry — columns × rows for the number of LOADED sources.
// 1 → 1×1 (one big player, no empty cells) · 2 → 2×1 side-by-side · 3/4 → 2×2.
// Only the real tiles are rendered (3 uses 2×2 and leaves ONE cell empty).
const gridDims = (n: number) => {
  if (n <= 1) return { cols: 1, rows: 1 };
  if (n === 2) return { cols: 2, rows: 1 };
  return { cols: 2, rows: 2 }; // 3 or 4
};
// Stream profiles offered by the Stream selector — Sub default (bandwidth), like
// the reference NVR. The chosen profile drives the recorded-playback session.
const STREAMS = [
  { value: "sub", label: "Sub stream" },
  { value: "main", label: "Main stream" },
];
// Event-type filters (3b: wired to the seekbar — hide unchecked coverage bars +
// event markers). The timeline legend's own list (ScrubBar LEGEND_TYPES), so the
// two can never disagree on order or labels.
const EVENT_TYPES = LEGEND_TYPES;

// LOCAL calendar date (not UTC) — toISOString() would roll to the wrong day near
// local midnight in offset zones (e.g. 00:30 IST is still the previous UTC day).
const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const dayStartMs = (d: string) => new Date(`${d}T00:00:00`).getTime();
const iso = (ms: number) => new Date(ms).toISOString();
const readout = (ms: number | null) =>
  ms == null ? "--:--:--" : new Date(ms).toLocaleTimeString(undefined, { hour12: false });
// Human duration for the selection readout — mm:ss under a minute-of-hours, else h:mm:ss.
const durReadout = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
};

// A tile descriptor. There is ONE kind, and that is the point: every camera is
// owned by a recorder, which is where its footage is and where every question
// about that footage is answered. The 'camera' kind — this platform's own pooled
// recordings — is gone with the recording and storage data-plane it belonged to.
//   key      unique tile id
//   name     label shown on the tile
//   cameraId synthetic `${nodeId}:${realId}` — satisfies the player's id guards
//   nodeId/realId  the camera's address on its recorder
interface FederatedTile {
  kind: "federated";
  key: string;
  name: string;
  cameraId: string;
  nodeId: string;
  realId: string;
  federated: true;
}
type PlaybackTile = FederatedTile;

// kind='federated' → a recorder-owned / 3rd-party-NVR (e.g. Lumina) camera surfaced
// through the federation proxy. nodeId/realId address it on the remote node; the
// synthetic `cameraId` (like nvrTile's) satisfies the player's truthy-id guards +
// query keys — the real request is overridden by tileSource's sourceFn.
// vms.federation.cameras() returns each camera's node-side id as `id` (there is no
// `real_id` on the raw payload — that alias only exists after the Streaming console
// remaps it). Use `id` (fall back to real_id if a caller pre-mapped it) so the tile
// key + playback target are never `undefined`.
const fedTile = (c: FederatedCamera): FederatedTile => {
  const realId = typeof c.real_id === "string" ? c.real_id : c.id;
  return {
    key: `fed:${c.node_id}:${realId}`,
    kind: "federated",
    name: c.name,
    cameraId: `${c.node_id}:${realId}`,
    nodeId: c.node_id,
    realId,
    federated: true,
  };
};

// Federated nodes expose NO recording-days endpoint, so DERIVE the month's footage
// days client-side from a month-wide timeline: every returned range's local-day span
// (a range may cross midnight → mark each local day it covers) is bucketed into
// day-of-month numbers. Local Date methods honor the operator's tz (== TZ_OFFSET_MIN),
// matching the server-side branches. Resilient to no footage (days:[]).
async function fedRecordingDays(nodeId: string, realId: string, calMonth: string): Promise<RecordingDaysResponse> {
  const [y, m] = calMonth.split("-").map(Number); // m is 1-based
  const monthStart = new Date(y, m - 1, 1, 0, 0, 0, 0);
  const monthEnd = new Date(y, m, 0, 23, 59, 59, 999); // day 0 of next month = last day
  const tl = await vms.federation.timeline(nodeId, realId, {
    from: monthStart.toISOString(),
    to: monthEnd.toISOString(),
  });
  const days = new Set<number>();
  for (const r of tl?.ranges || []) {
    if (!r?.start) continue;
    const startMs = new Date(r.start).getTime();
    const endMs = startMs + (r.duration || 0) * 1000;
    const cur = new Date(startMs);
    cur.setHours(0, 0, 0, 0); // walk from the range's local start-day midnight
    while (cur.getTime() <= endMs) {
      if (cur.getFullYear() === y && cur.getMonth() === m - 1) days.add(cur.getDate());
      cur.setDate(cur.getDate() + 1); // DST-safe local day step
    }
  }
  return { year: y, month: m, days: [...days].sort((a, b) => a - b) };
}

// The footage-days marks for the calendar. Derived from the recorder's own
// timeline — see fedRecordingDays; nodes expose no recording-days endpoint.
function recordingDaysFor(t: PlaybackTile, month: string): Promise<RecordingDaysResponse> {
  return fedRecordingDays(t.nodeId, t.realId, month);
}

// A source's coverage over the day, from the recorder that wrote it.
type SourceCoverage = { kind: "federated"; tl: FederatedTimeline };

async function coverageFor(s: PlaybackTile, range: { from: string; to: string }): Promise<SourceCoverage> {
  return {
    kind: "federated",
    tl: await vms.federation.timeline(s.nodeId, s.realId, { from: range.from, to: range.to }),
  };
}

/** A merged span in epoch ms, keeping the backend trigger_type for its colour. */
interface MsSpan {
  s: number;
  e: number;
  trigger: string;
}

export interface UnifiedPlaybackProps {
  /** Open the export dialog for a window of one camera. */
  onExportRange?: (req: ExportRequest) => void;
}

export default function UnifiedPlayback({ onExportRange }: UnifiedPlaybackProps) {
  const [day, setDay] = useState(todayStr());
  const [sources, setSources] = useState<PlaybackTile[]>([]); // tile descriptors (loaded on Search)
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [clock, setClock] = useState(dayStartMs(todayStr())); // shared epoch ms
  const [seekMs, setSeekMs] = useState<number | null>(null);
  const [seekNonce, setSeekNonce] = useState(0); // bumped ONLY on an explicit user scrub
  const [focusKey, setFocusKey] = useState<string | null>(null); // tile expanded to full player
  // Searching, grouping and collapse live in PlaybackChannelPicker: the rail
  // is one recorder › camera tree, so the state that drove two pickers and a
  // server-side camera search went with them.
  // The id a deep link named that no list could resolve — shown instead of an
  // empty workspace that looks like nothing was picked.
  const [deepLinkMiss, setDeepLinkMiss] = useState<string | null>(null);

  // ── Rail composer state (drives the Search → load) ───────────────────────
  // Default to MAIN — that's the profile we record (sub is the live web/WHEP stream, not
  // recorded), so a playback page must open on main or it shows "No footage" by default.
  const [stream, setStream] = useState("main"); // 'main' | 'sub' — recorded profile
  const [eventFilter, setEventFilter] = useState(() => new Set<LegendType>(EVENT_TYPES)); // 3b: filters seekbar
  const [checked, setChecked] = useState<PlaybackTile[]>([]); // ≤4 pending tile descriptors (pre-Search)
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
  const [selFrom, setSelFrom] = useState<number | null>(null);
  const [selTo, setSelTo] = useState<number | null>(null);

  const windowStart = dayStartMs(day);
  const windowEnd = windowStart + DAY_MS;
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const gridWrapRef = useRef<HTMLDivElement | null>(null); // fullscreen target (the grid/focus body)
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Reset the shared clock into the window when the day changes.
  useEffect(() => {
    setPlaying(false);
    setClock(windowStart);
    setSeekMs(windowStart);
    setSelFrom(null); // the old day's selection is meaningless in the new window
    setSelTo(null);
  }, [windowStart]);

  // ── Deep-link ?camera=<id>[&t=<iso>] → open that camera as the sole tile ──
  const deepHandled = useRef(false);




  // There is no NVR picker any more.
  //
  // A third-party NVR's channels are not a separate kind of source: the recorder
  // that fronts the appliance turns each channel into a proxy CAMERA during
  // onboarding, so they arrive in the federated camera list and play through the
  // federated camera routes like anything else. The picker built its channel list
  // from this service's own Camera rows, of which a single-ownership estate has
  // none — so it had been showing "No mapped channels" for every NVR.
  //
  // Which appliances exist is still worth seeing; that lives on the Recorders page,
  // read from the recorder that owns them.

  // ── Federated (recorder-owned) picker data ───────────────────────────────
  // Cameras owned by remote recorder nodes (3rd-party NVR channels, e.g. Lumina),
  // surfaced through the federation proxy. Each carries node_id/real_id (its address
  // on the node) + node_name/site_name for the label.
  const fedCamsQ = useQuery({
    queryKey: ["vms-federation-cameras", "playback-picker"],
    queryFn: () => vms.federation.cameras(),
    staleTime: 60_000,
  });
  const fedCameras = useMemo(() => fedCamsQ.data?.items ?? [], [fedCamsQ.data]);

  // DEEP LINK — ?camera=<id>[&t=<iso>], from an alarm's "watch the recording", the
  // camera-event row and the linkage popup.
  //
  // It used to resolve the id against THIS platform's own camera rows and give up
  // silently on a miss (`catch { return }`). Those rows do not exist — the
  // recorder owns every camera — so `GET /vms/cameras/{id}` 404'd and the link
  // opened an empty Playback with no explanation: the alarm's most useful action,
  // doing nothing.
  //
  // The alarm and event rows carry the NODE-SIDE camera id, which is what the
  // federated list is keyed by. An id in neither shape is SAID, because a link
  // that leads nowhere must not look like an operator forgetting to pick a camera.
  useEffect(() => {
    if (deepHandled.current || typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const camera = params.get("camera");
    const t = params.get("t");
    if (!camera) return;
    // Wait for the list to settle: resolving before it lands would report a miss
    // for a camera that is in it.
    if (fedCamsQ.isLoading) return;

    let cancelled = false;
    (async () => {
      const fed = fedCameras.find(
        (c) => c.id === camera || (typeof c.real_id === "string" && c.real_id === camera),
      );
      const tile: PlaybackTile | null = fed ? fedTile(fed) : null;

      if (cancelled || deepHandled.current) return;
      deepHandled.current = true;

      if (!tile) {
        setDeepLinkMiss(camera);
        return;
      }

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
  }, [fedCameras, fedCamsQ.isLoading]);

  // ── Calendar footage marks ───────────────────────────────────────────────
  // The calendar tracks the FIRST-selected channel's footage-days for the month
  // in view (a checked channel takes priority; else the first loaded source). No
  // channel chosen yet → no marks (fine). `month` is the visible YYYY-MM.
  const calMonth = `${calView.year}-${String(calView.month + 1).padStart(2, "0")}`;
  const calTrack: PlaybackTile | null = checked[0] || sources[0] || null;
  const recordingDaysQ = useQuery({
    queryKey: ["vms-recording-days", calTrack?.key, calMonth],
    queryFn: calTrack ? () => recordingDaysFor(calTrack, calMonth) : skipToken,
    staleTime: 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const footageDays = useMemo(
    () => new Set<number>(recordingDaysQ.data?.days || []),
    [recordingDaysQ.data],
  );

  // ── Union coverage across every selected source ──────────────────────────
  const range = useMemo(() => ({ from: iso(windowStart), to: iso(windowEnd) }), [windowStart, windowEnd]);
  const coverageQs = useQueries({
    queries: sources.map((s) => ({
      queryKey: ["vms-pb-coverage", s.key, day],
      queryFn: () => coverageFor(s, range),
      enabled: !!s.key,
      staleTime: 30_000,
      retry: false,
      refetchOnWindowFocus: false,
    })),
  });

  // EVENT MARKERS FOR RECORDER-OWNED CAMERAS.
  //
  // A federated timeline carries coverage ranges and their trigger_type — enough to
  // COLOUR the bars — but no event markers, so the flags on the master timeline (and
  // the legend that filters them) were empty for every recorder-owned camera, which
  // on a single-ownership estate is all of them.
  //
  // They do not need a new federated call: the event supervisor already mirrors each
  // recorder's ONVIF ledger into this service's own `vms_events`, keyed by the
  // node-side camera id — which is exactly the id a federated tile holds. One query
  // per loaded federated source, over the same window as the coverage.
  const fedMarkerQs = useQueries({
    queries: sources
      .filter((s): s is FederatedTile => s.kind === "federated")
      .map((s) => ({
        queryKey: ["vms-pb-fed-events", s.realId, range.from, range.to],
        queryFn: () =>
          vms.events.list({ camera_id: s.realId, from: range.from, to: range.to, limit: 500 }),
        staleTime: 30_000,
        retry: false,
        refetchOnWindowFocus: false,
      })),
  });

  const fedMarkers: TimelineMarker[] = useMemo(() => {
    const out: TimelineMarker[] = [];
    for (const q of fedMarkerQs) {
      for (const e of q.data?.items || []) {
        // `occurred_at` is when it HAPPENED; `created_at` is when this service heard
        // about it, which on a poll can be a minute later and would plant the flag
        // somewhere the footage does not match.
        const at = e.occurred_at || e.created_at;
        if (!at) continue;
        out.push({
          t: at,
          event_type: e.event_type,
          severity: e.severity,
          event_id: e.id,
          camera_id: e.camera_id,
        });
      }
    }
    return out;
  }, [fedMarkerQs]);

  // Union coverage + markers across the ≤4 sources, KEEPING each span's trigger_type
  // so the seekbar can color it (via the shared palette). NVR footage has no trigger
  // → default "continuous" (Normal). Merging only fuses TOUCHING spans of the SAME
  // trigger; different triggers stay separate items (matches the backend model), so a
  // motion span never gets swallowed into a continuous one. The event-type filter then
  // hides coverage/markers whose legend bucket is unchecked.
  // WHICH SOURCES COULD NOT BE READ.
  //
  // The merge below skips a query with no data (`if (!d) return`), so an
  // unreachable recorder produced exactly the same empty timeline as a camera
  // that recorded nothing — and "no footage" is the reading an operator acts on.
  // These are counted so the bar can say the difference out loud.
  const coverageFailures = useMemo(
    () =>
      coverageQs
        .map((q, i) => (q.error ? { name: sources[i]?.name || "a source", error: q.error } : null))
        .filter(Boolean) as { name: string; error: unknown }[],
    [coverageQs, sources],
  );

  const { mergedCoverage, markers } = useMemo(() => {
    const spans: MsSpan[] = []; // { s, e, trigger } (trigger = backend trigger_type)
    const marks: TimelineMarker[] = [];
    coverageQs.forEach((q) => {
      const d = q.data;
      if (!d) return;
      // The recorder's timeline: ranges carry {start, duration(sec), trigger_type}
      // → one [start, start+duration] span each, keeping the trigger for its colour.
      for (const r of d.tl.ranges || []) {
        if (!r?.start) continue;
        const sMs = new Date(r.start).getTime();
        spans.push({
          s: sMs,
          e: sMs + (r.duration || 0) * 1000,
          trigger: r.trigger_type || "continuous",
        });
      }
    });

    // Filter coverage by the event-type filter (trigger_type → legend bucket), then
    // sort + merge same-trigger touching spans (leaving different triggers distinct).
    const kept = spans.filter((sp) => eventFilter.has(triggerToLegend(sp.trigger)));
    kept.sort((a, b) => a.s - b.s || a.e - b.e);
    const merged: MsSpan[] = [];
    for (const sp of kept) {
      const last = merged[merged.length - 1];
      if (last && sp.trigger === last.trigger && sp.s <= last.e) {
        last.e = Math.max(last.e, sp.e); // fuse touching same-trigger spans
      } else {
        merged.push({ ...sp });
      }
    }

    // Filter markers by the same event-filter (event_type → legend bucket). The
    // federated ones come from this service's mirror of each recorder's ledger.
    const keptMarks = [...marks, ...fedMarkers].filter((m) =>
      eventFilter.has(legendKeyForEventType(m.event_type)),
    );

    return {
      mergedCoverage: merged.map((m) => ({ start: iso(m.s), end: iso(m.e), trigger_type: m.trigger })),
      markers: keptMarks,
    };
  }, [coverageQs, fedMarkers, eventFilter]);

  // Default the playhead to first coverage when it appears (and not playing).
  const firstCoverageMs = useMemo(() => {
    let min: number | null = null;
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
  const atCap = checked.length >= MAX_TILES;
  const toggleCheck = (tile: PlaybackTile) => {
    setChecked((prev) => {
      const already = prev.some((t) => t.key === tile.key);
      if (already) return prev.filter((t) => t.key !== tile.key);
      if (prev.length >= MAX_TILES) return prev; // enforce ≤4
      return [...prev, tile];
    });
  };

  // ── The rail's one channel list: recorder › camera ────────────────────────
  //
  // Grouped by the RECORDER that owns the camera, because that is the only
  // grouping the estate has (single ownership — the VMS onboards nothing) and
  // because a recorder holds many channels: a flat list of every channel on every
  // recorder is unusable in a 25% rail at the moment an operator needs it.
  //
  // There is no VMS-owned branch, and there is no VMS-owned anything: footage
  // lives on the recorder that wrote it. That is why the recording, retention and
  // storage data-plane was taken out of this service in the first place, and a
  // picker offering a second store would put it back in the operator's head.
  const tileByKey = useMemo(() => {
    const m = new Map<string, PlaybackTile>();
    for (const c of fedCameras) {
      const t = fedTile(c);
      m.set(t.key, t);
    }
    return m;
  }, [fedCameras]);

  const pickerGroups = useMemo<PickerGroup[]>(() => {
    const byNode = new Map<string, PickerGroup>();
    for (const c of fedCameras) {
      const nodeId = String(c.node_id);
      let g = byNode.get(nodeId);
      if (!g) {
        g = {
          key: `node:${nodeId}`,
          label: c.node_name || "recorder",
          icon: "heroicons-outline:server-stack",
          rows: [],
        };
        byNode.set(nodeId, g);
      }
      g.rows.push({ key: fedTile(c).key, name: c.name, status: c.status });
    }
    const groups = [...byNode.values()].sort((a, b) => a.label.localeCompare(b.label));
    groups.forEach((g) => g.rows.sort((a, b) => a.name.localeCompare(b.name)));

    return groups;
  }, [fedCameras]);

  const checkedKeys = useMemo(() => new Set(checked.map((t) => t.key)), [checked]);

  const toggleByKey = (key: string) => {
    const tile = tileByKey.get(key);
    if (tile) toggleCheck(tile);
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

  const removeTile = (key: string) => {
    setSources((s) => s.filter((x) => x.key !== key));
    setChecked((c) => c.filter((x) => x.key !== key)); // keep the rail in sync
    if (focusKey === key) setFocusKey(null);
  };

  const onScrub = useCallback((ms: number) => {
    setPlaying(false);
    setClock(ms);
    setSeekMs(ms);
    setSeekNonce((n) => n + 1); // explicit user scrub → NVR tiles re-request the replay
  }, []);
  const skip = (sec: number) => onScrub(Math.max(windowStart, Math.min(windowEnd, clock + sec * 1000)));

  const focusTile = focusKey ? (sources.find((s) => s.key === focusKey) ?? null) : null;
  // The focused tile's own coverage answer — what its full player's timeline shows.
  const focusData = focusTile ? coverageQs[sources.findIndex((s) => s.key === focusTile.key)]?.data : undefined;

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
      const ctx = canvas.getContext("2d");
      if (!ctx) return; // same outcome as the catch below: nothing to snapshot
      ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
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
  // export flow the focus player uses (`onExportRange`).
  //
  // Federated tiles USED to be skipped here alongside NVR tiles, on the grounds that
  // they had "no native VMS export path". They have one — the recorder's, which is
  // the only place an export can be produced anyway — and since every camera is
  // owned by a recorder, skipping them disabled the button for all of them.
  //
  // NVR tiles stay skipped, and for a real reason: a third-party NVR channel is
  // proxied for viewing, and this platform does not drive an export job on somebody
  // else's recorder.
  const downloadActive = useCallback(() => {
    if (!activeSource || activeSource.kind !== "federated") return;
    onExportRange?.({
      from: iso(windowStart),
      to: iso(windowEnd),
      nodeId: activeSource.nodeId,
      cameraId: activeSource.realId,
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
  // the same onExportRange flow as the window-download — and gated identically, so
  // the two cannot drift into disagreeing about what is exportable.
  const extractClip = useCallback(() => {
    if (!hasSelection || !activeSource || activeSource.kind !== "federated") return;
    onExportRange?.({
      from: iso(selFrom),
      to: iso(selTo),
      nodeId: activeSource.nodeId,
      cameraId: activeSource.realId,
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

  // Per-tile source overrides. NVR tiles pull from the client-NVR footage endpoint;
  // federated tiles pull through the node proxy — which returns EITHER hls_url +
  // webrtc_url (mediamtx proxy channels, same as live) OR playback_url (locally-
  // recorded recorder cams, fmp4). Adapt whichever is present into the session shape
  // usePlaybackSession/PlaybackPlayer consume (hls_url, webrtc_url, ranges, from, expires_at).
  const tileSource = (s: PlaybackTile): PlaybackSourceFn | null => {
    if (s.kind === "federated")
      return (win) =>
        vms.federation.playback(s.nodeId, s.realId, win).then((r) => ({
          hls_url: r.hls_url || r.playback_url,
          webrtc_url: r.webrtc_url,
          ranges: r.ranges,
          from: r.start,
          expires_at: r.expires_at,
        }));
    return null;
  };



  return (
    // transform:translateZ(0) — pin this whole surface to its own GPU compositing
    // layer. Fixes a Chrome scroll-repaint glitch where, after scrolling the channel
    // rail + re-rendering (checking a box), the browser leaves stale white below the
    // fold even though the DOM is full-height (verified: shell/main/aside all correct).
    // Isolating the layer forces a clean repaint. No fixed-positioned descendants here
    // (ExportDialog is a sibling), so this is safe.
    <div
      className="flex h-full min-h-0 w-full gap-3 p-3 text-[#f2f6ff] [transform:translateZ(0)]"
      style={{ background: "radial-gradient(1200px 700px at 50% 115%, #14284f 0%, #0c1530 55%)" }}
    >
      {/* ── Composer rail ──────────────────────────────────────────────────
          Calendar → Stream → Event filters → Channel multi-select (≤4) → Search. */}
      <aside className="flex w-80 shrink-0 flex-col rounded-xl border border-[rgba(160,150,245,.22)] bg-[rgba(8,15,34,.55)] backdrop-blur-xs [transform:translateZ(0)]">
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
          {/* An unmarked calendar means "no footage that month" OR "we could not
              ask" — and only one of those is a reason to pick another day. */}
          {recordingDaysQ.error && calTrack && (
            <p className="mt-1 px-1 text-[10.5px] leading-relaxed text-amber-200">
              Footage days could not be read for {calTrack.name} — days are unmarked
              because the recorder did not answer, not because it has nothing.
            </p>
          )}

          {/* ── Stream (Main / Sub) ── */}
          <div className="mt-4">
            <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-[#9db0d8]">Stream</p>
            <div className="flex gap-1">
              {STREAMS.map((s) => (
                <button
                  key={s.value}
                  type="button"
                  onClick={() => setStream(s.value)}
                  className={`flex-1 rounded-lg px-2 py-1.5 text-[12px] transition ${
                    stream === s.value
                      ? "bg-foreground font-medium text-background"
                      : "text-[#9db0d8] hover:bg-[rgba(150,180,245,.07)] hover:text-[#67e8f9]"
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>

          {/* ── Event-type filters — filter the seekbar coverage bars + markers ── */}
          <div className="mt-4">
            <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-[#9db0d8]">
              Event types
            </p>
            <div className="grid grid-cols-2 gap-x-2 gap-y-1">
              {EVENT_TYPES.map((et) => {
                const on = eventFilter.has(et);
                return (
                  <label
                    key={et}
                    className="flex cursor-pointer items-center gap-1.5 rounded-md px-1 py-0.5 text-[12px] text-[#f2f6ff] hover:bg-[rgba(150,180,245,.07)]"
                  >
                    <span
                      className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm border transition ${
                        on ? "border-foreground bg-foreground text-background" : "border-[rgba(150,180,245,.28)]"
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
                          const next = new Set<LegendType>(prev);
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
              <p className="text-[11px] font-medium uppercase tracking-wide text-[#9db0d8]">Channels</p>
              <span className={`text-[11px] ${atCap ? "text-red-400" : "text-[#9db0d8]"}`}>
                {checked.length}/{MAX_TILES}
              </span>
            </div>

            <PlaybackChannelPicker
              groups={pickerGroups}
              checkedKeys={checkedKeys}
              onToggle={toggleByKey}
              max={MAX_TILES}
              loading={fedCamsQ.isLoading}
              error={
                fedCamsQ.error
                  ? apiError(fedCamsQ.error, "Could not reach the recorders")
                  : null
              }
            />
          </div>
        </div>

        {/* ── Search / Load ── */}
        <div className="shrink-0 border-t border-[rgba(160,150,245,.22)] p-2">
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
      <div className="flex min-h-0 min-w-0 flex-1 flex-col rounded-xl border border-[rgba(160,150,245,.22)] bg-[rgba(8,15,34,.55)] backdrop-blur-xs">
        {/* selected day + focus/clear (day is driven by the rail calendar now) */}
        <div className="flex shrink-0 items-center gap-2 border-b border-[rgba(160,150,245,.22)] px-3 py-2">
          <Icon icon="heroicons-outline:calendar-days" className="text-sm text-[#9db0d8]" />
          <span className="text-sm font-medium text-[#f2f6ff] tabular-nums">{day}</span>
          <span className="text-xs text-[#9db0d8]">· 2×2 synchronized playback</span>
          {focusTile && (
            <button
              type="button"
              onClick={() => setFocusKey(null)}
              className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-[rgba(160,150,245,.22)] px-2.5 py-1 text-[13px] text-[#9db0d8] transition hover:bg-[rgba(150,180,245,.07)] hover:text-[#67e8f9]"
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
              className="ml-auto text-[13px] text-[#9db0d8] transition hover:text-[#67e8f9]"
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
          } ${isFullscreen ? "bg-[rgba(8,15,34,.55)] backdrop-blur-xs" : ""}`}
        >
          {sources.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center text-center text-[#9db0d8]">
              <Icon
                icon={deepLinkMiss ? "heroicons:exclamation-triangle" : "heroicons-outline:play"}
                className={`mb-3 text-5xl ${deepLinkMiss ? "text-red-400/70" : "opacity-40"}`}
              />
              <p className="font-medium text-[#f2f6ff]">
                {deepLinkMiss ? "That camera is not in this estate" : "No sources loaded"}
              </p>
              <p className="mt-1 text-sm">
                {deepLinkMiss
                  ? `Nothing here owns camera ${deepLinkMiss}. It may have been removed, or belong to a recorder this account cannot see.`
                  : "Pick a day, check up to 4 channels on the left, and hit Search to play them in sync."}
              </p>
            </div>
          ) : focusTile ? (
            /* Focus mode — the FULL standalone player for one source (all tools). */
            <PlaybackPlayer
              key={focusTile.key}
              cameraId={focusTile.cameraId}
              // The recorder and the camera's id ON it — needed by anything that asks
              // the recorder to act on the footage. `cameraId` above stays the id the
              // VMS keys its own records on (bookmarks, evidence holds), and the two
              // are NOT interchangeable for a federated tile.
              nodeId={focusTile.kind === "federated" ? focusTile.nodeId : null}
              realCameraId={focusTile.kind === "federated" ? focusTile.realId : null}
              cameraName={focusTile.name}
              sourceFn={tileSource(focusTile)}
              profile={stream}
              timelineFn={
                focusTile.kind === "federated"
                  ? () => ({
                      coverage: (focusData?.kind === "federated" ? focusData.tl.ranges || [] : []).map((r) => ({
                        start: r.start,
                        end: iso(new Date(r.start).getTime() + (r.duration || 0) * 1000),
                      })),
                    })
                  : null
              }
              // Only a federated tile can raise an export: the recorder that owns the
              // camera is what produces one. A third-party NVR channel is proxied for
              // viewing and this platform does not run a job on somebody else's box.
              onExportRange={
                focusTile.kind === "federated"
                  ? (r) =>
                      onExportRange?.({
                        ...r,
                        nodeId: focusTile.nodeId,
                        cameraId: focusTile.realId,
                        cameraName: focusTile.name,
                      })
                  : undefined
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
                      <span className="rounded-sm bg-black/60 px-2 py-0.5 text-xs font-medium text-white">
                        {s.name}
                      </span>
                      {s.kind === "federated" && (
                        <span className="rounded-sm bg-violet-500/70 px-1.5 py-0.5 text-[10px] font-medium uppercase text-white">
                          REC
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
          <div className="shrink-0 border-t border-[rgba(160,150,245,.22)] p-3">
            {/* A source that did not answer is NAMED. Without this the timeline for
                an unreachable recorder is indistinguishable from one that recorded
                nothing — and the operator acts on "no footage". */}
            {coverageFailures.length > 0 && (
              <div className="mb-2 flex items-start gap-2 rounded-lg border border-[rgba(251,191,36,.4)] bg-[rgba(251,191,36,.1)] px-2.5 py-1.5">
                <Icon
                  icon="heroicons:exclamation-triangle"
                  className="mt-0.5 shrink-0 text-[13px] text-amber-300"
                />
                <p className="text-[11px] leading-relaxed text-amber-200">
                  Coverage could not be read for{" "}
                  {coverageFailures.map((f) => f.name).join(", ")} — the timeline
                  below is missing {coverageFailures.length === 1 ? "that source" : "those sources"}, not
                  showing that {coverageFailures.length === 1 ? "it has" : "they have"} no footage.
                </p>
              </div>
            )}
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
                        const next = new Set<LegendType>(prev);
                        if (next.has(t)) next.delete(t);
                        else next.add(t);
                        return next;
                      })
                    }
                    className={`inline-flex items-center gap-1.5 text-[11px] transition ${
                      on ? "text-[#f2f6ff]" : "text-[#9db0d8] line-through opacity-50"
                    }`}
                  >
                    <span className={`h-2.5 w-3.5 rounded-xs ${TIMELINE_PALETTE[t].cls}`} />
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
              <span className="mx-2 font-mono text-sm tabular-nums text-[#f2f6ff]">{readout(clock)}</span>
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
              <div className="ml-2 flex items-center gap-1 border-l border-[rgba(160,150,245,.22)] pl-2">
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
                    activeSource && activeSource.kind !== "federated"
                      ? "Clip extract is unavailable for third-party NVR channels"
                      : !hasSelection
                        ? "Mark in + out to select a section to extract"
                        : `Extract clip ${readout(selFrom)}–${readout(selTo)}${
                            activeSource ? ` · ${activeSource.name}` : ""
                          }`
                  }
                  onClick={extractClip}
                  disabled={!hasSelection || !activeSource || activeSource.kind !== "federated"}
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
              <div className="ml-2 flex items-center gap-1 border-l border-[rgba(160,150,245,.22)] pl-2">
                <ToolBtn
                  icon="heroicons-outline:camera"
                  title={`Snapshot${activeSource ? ` · ${activeSource.name}` : ""}`}
                  onClick={snapshotActive}
                />
                <ToolBtn
                  icon="heroicons-outline:arrow-down-tray"
                  title={
                    activeSource && activeSource.kind !== "federated"
                      ? "Export is unavailable for third-party NVR channels"
                      : `Download this whole window${activeSource ? ` · ${activeSource.name}` : ""}`
                  }
                  onClick={downloadActive}
                  disabled={!activeSource || activeSource.kind !== "federated"}
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
                {activeSource && activeSource.kind !== "federated" && (
                  <span className="text-[11px] text-[#9db0d8]">
                    Clip extract is unavailable for third-party NVR channels.
                  </span>
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
interface ToolBtnProps {
  icon?: string;
  label?: string;
  title?: string;
  onClick?: () => void;
  disabled?: boolean;
}

function ToolBtn({ icon, label, title, onClick, disabled }: ToolBtnProps) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-[rgba(160,150,245,.22)] text-[#9db0d8] transition hover:bg-[rgba(150,180,245,.07)] hover:text-[#67e8f9] disabled:pointer-events-none disabled:opacity-40"
    >
      {label ? (
        <span className="text-[11px] font-semibold tracking-wide">{label}</span>
      ) : icon ? (
        <Icon icon={icon} className="text-base" />
      ) : null}
    </button>
  );
}
