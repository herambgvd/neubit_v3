"use client";

// VMS → Streaming: the multi-camera video wall (P2-D), redesigned into an
// immersive control-room surface (Milestone Smart Wall / Genetec / iVMS class).
// The GRID is the hero: near-black full-bleed tiles, minimal chrome, a compact
// top bar, a collapsible camera rail, a fullscreen wall mode, spotlight, tour,
// and drag/swap interactions. Live playback is UNCHANGED — each filled tile
// still owns a PlaybackSession via LivePlayer → useLiveSession.
//
// ── Wall state model (pattern-ready) ─────────────────────────────────────────
// The wall is fully described by { layoutKey, cells:[{cameraId|null}] }. A saved
// "pattern" restores that in one call via `applyWallPreset({layout, tiles})`
// (see videoWall.buildPreset for the {layout, tiles} shape).
//
// Two features ride on that seam:
//   • Saved layouts (localStorage) — a single static grid, recalled in one click.
//   • Patterns (server) — a NAMED ROTATING sequence of camera GROUPS, authored in
//     Config → Patterns. The PatternPickerMenu starts rotation; usePatternRotation
//     resolves each group → cameras + layout and paints the wall via
//     applyWallPreset on a dwell interval. Deep-linkable via
//     ?pattern_id=<id>&autoplay=1. PatternHud gives on-wall prev/pause/next/exit.
//
// ── Session lifecycle ────────────────────────────────────────────────────────
// Only tiles with a cameraId mount a LivePlayer; the player releases its session
// on unmount, so shrinking the layout / paging a tour / removing a tile tears
// down off-screen sessions automatically. Tiles are keyed by STABLE index
// (`tile-i`) so React preserves the mounted player across layout/spotlight
// changes — spotlighting a tile REUSES its session instead of restarting it.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { Button, ConfirmDialog, Input, Modal } from "@/components/ui/kit";
import { asItems } from "@/lib/format";
import { vms } from "./api";
import {
  DEFAULT_LAYOUT_KEY,
  getLayout,
  gridStyle,
  tileStyle,
  heroIndex,
  tourPages,
  tileProfile,
  buildPreset,
  presetTilesForCapacity,
} from "./videoWall";
import CameraRail from "./components/CameraRail";
import WallTile from "./components/WallTile";
import WallToolbar, { QUALITY_LEVELS } from "./components/WallToolbar";
import MapView from "./components/MapView";
import PlayoutBar from "./components/PlayoutBar";
import SpotlightOverlay from "./components/SpotlightOverlay";
import CameraQuickPicker from "./components/CameraQuickPicker";
import PatternPickerMenu from "./components/PatternPickerMenu";
import PatternHud from "./components/PatternHud";
import PatternFormModal from "./components/PatternFormModal";
import SaveWallGroupModal from "./components/SaveWallGroupModal";
import { usePatternRotation } from "./hooks/usePatternRotation";

const LS_LAYOUT = "neubit.vms.wall.layout";
const LS_CELLS = "neubit.vms.wall.cells";
const LS_SAVED = "neubit.vms.wall.saved";
const LS_RAIL = "neubit.vms.wall.rail";
const LS_VIEW = "neubit.vms.wall.view";
const LS_QUALITY = "neubit.vms.wall.quality";

const emptyCell = () => ({ cameraId: null });

// Single-cell grid template used while spotlighting (the one tile fills it).
const SPOTLIGHT_GRID = {
  gridTemplateColumns: "minmax(0, 1fr)",
  gridTemplateRows: "minmax(0, 1fr)",
};

// ── localStorage helpers (SSR-safe) ───────────────────────────────────────
function readLS(key, fallback) {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}
function writeLS(key, value) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* quota / private mode — silent */
  }
}

export default function Streaming() {
  // ── layout + cells (persisted) ──────────────────────────────────────────
  const [layoutKey, setLayoutKey] = useState(() => {
    const k = readLS(LS_LAYOUT, DEFAULT_LAYOUT_KEY);
    return typeof k === "string" ? k : DEFAULT_LAYOUT_KEY;
  });
  const layout = useMemo(() => getLayout(layoutKey), [layoutKey]);

  const [cells, setCells] = useState(() => {
    const cap = getLayout(readLS(LS_LAYOUT, DEFAULT_LAYOUT_KEY)).capacity;
    const saved = readLS(LS_CELLS, null);
    const base = Array.from({ length: cap }, emptyCell);
    if (Array.isArray(saved)) {
      for (let i = 0; i < cap && i < saved.length; i += 1) {
        if (saved[i]?.cameraId) base[i] = { cameraId: saved[i].cameraId };
      }
    }
    return base;
  });

  const [savedLayouts, setSavedLayouts] = useState(() => {
    const s = readLS(LS_SAVED, []);
    return Array.isArray(s) ? s : [];
  });

  // View mode (grid | map | split) + global stream quality + DVR playout bar.
  const [viewMode, setViewMode] = useState(() => {
    const v = readLS(LS_VIEW, "grid");
    return ["grid", "map", "split"].includes(v) ? v : "grid";
  });
  const [quality, setQuality] = useState(() => {
    const qv = readLS(LS_QUALITY, "auto");
    return QUALITY_LEVELS.some((l) => l.key === qv) ? qv : "auto";
  });
  const [playoutOpen, setPlayoutOpen] = useState(false);

  const [railOpen, setRailOpen] = useState(() => readLS(LS_RAIL, true) !== false);
  const [railDragging, setRailDragging] = useState(false);
  const [spotlight, setSpotlight] = useState<any>(null); // tile index or null
  const [allMuted, setAllMuted] = useState(true);
  const [picker, setPicker] = useState<any>({ open: false, tileIndex: null });

  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [confirm, setConfirm] = useState<any>(null);
  // Inline (from the wall) creation surfaces — save current wall → server Camera
  // Group, and build a Pattern — so operators don't have to trip to Config.
  const [saveGroupOpen, setSaveGroupOpen] = useState(false);
  const [patternFormOpen, setPatternFormOpen] = useState(false);
  const qc = useQueryClient();

  const wallRef = useRef<any>(null); // fullscreen-wall target
  const gridRef = useRef<any>(null); // for mute-all DOM sweep

  // ── tour (carousel) ─────────────────────────────────────────────────────
  const [tour, setTour] = useState<any>({ active: false, pages: [], index: 0, seconds: 10 });
  const cellsRef = useRef(cells);
  useEffect(() => {
    cellsRef.current = cells;
  });

  // Persist layout + cell camera-ids (never persist session URLs — short-lived).
  useEffect(() => writeLS(LS_LAYOUT, layoutKey), [layoutKey]);
  useEffect(() => writeLS(LS_CELLS, cells.map((c) => ({ cameraId: c.cameraId || null }))), [cells]);
  useEffect(() => writeLS(LS_SAVED, savedLayouts), [savedLayouts]);
  useEffect(() => writeLS(LS_RAIL, railOpen), [railOpen]);
  useEffect(() => writeLS(LS_VIEW, viewMode), [viewMode]);
  useEffect(() => writeLS(LS_QUALITY, quality), [quality]);

  // ── cameras ─────────────────────────────────────────────────────────────
  const camerasQ = useQuery<any>({
    queryKey: ["vms-wall-cameras"],
    queryFn: () => vms.cameras.list({ limit: 500 }),
    refetchInterval: 20_000,
  });
  // Federated recorder cameras — cameras OWNED by registered NVR nodes, pulled up
  // read-only and streamed THROUGH each node. Merged into the same wall so the
  // camera tree shows recorders as top-level branches alongside local cameras.
  const fedQ = useQuery<any>({
    queryKey: ["vms-wall-federation-cameras"],
    queryFn: () => vms.federation.cameras(),
    refetchInterval: 30_000,
  });
  const cameras = useMemo(() => {
    const local = asItems(camerasQ.data);
    // Each federated camera gets a composite id (`fed:<node>:<cam>`) so it never
    // collides with a local camera id; real_id + node_id drive the node-issued
    // live source (see WallTile). Grouped under its recorder in the rail via
    // site_id/site_name = the node.
    const fed = (fedQ.data?.items || []).map((c) => ({
      id: `fed:${c.node_id}:${c.id}`,
      real_id: c.id,
      name: c.name,
      status: c.status,
      federated: true,
      // PTZ capability as the node reported it (public.ptz.capable) — drives the
      // wall's PTZ overlay gate; commands proxy through the node (operate-through-node).
      ptz_capable: !!(c.ptz && c.ptz.capable),
      node_id: c.node_id,
      node_name: c.node_name,
      site_id: `nvr:${c.node_id}`,
      site_name: c.node_name,
    }));
    return [...fed, ...local];
  }, [camerasQ.data, fedQ.data]);
  const cameraById = useMemo(() => {
    const m = new Map<any, any>();
    cameras.forEach((c) => m.set(c.id, c));
    return m;
  }, [cameras]);

  const mountedIds = useMemo(
    () => new Set<any>(cells.map((c) => c.cameraId).filter(Boolean)),
    [cells],
  );
  const liveCount = mountedIds.size;
  const onlineCount = cameras.filter((c) => c.status === "online").length;

  // Ordered camera ids currently on the wall (for "save wall as group").
  const wallCameraIds = useMemo(
    () => cells.map((c) => c.cameraId).filter(Boolean),
    [cells],
  );

  // Set of camera ids that still EXIST — the rotation engine uses it to skip
  // groups whose cameras were deleted (robustness).
  const cameraIdSet = useMemo(() => new Set<any>(cameras.map((c) => c.id)), [cameras]);

  // Auto-prune tiles whose camera no longer exists (camera / NVR was deleted) so the
  // wall never strands "camera not found" tiles pointing at gone ids. Gated on a
  // SUCCESSFUL fetch — a transient load error or the pre-load mount must NOT clear the
  // wall. Empties the cell (drag-target) rather than error-holding a dead id.
  useEffect(() => {
    if (!camerasQ.isSuccess || !fedQ.isSuccess) return;
    setCells((prev) => {
      let changed = false;
      const next = prev.map((c) => {
        if (c.cameraId && !cameraIdSet.has(c.cameraId)) {
          changed = true;
          return emptyCell();
        }
        return c;
      });
      return changed ? next : prev;
    });
  }, [camerasQ.isSuccess, fedQ.isSuccess, cameraIdSet]);

  // ── layout / assignment ────────────────────────────────────────────────
  const changeLayout = useCallback((key) => {
    const next = getLayout(key);
    setSpotlight(null);
    setLayoutKey(key);
    setCells((prev) => {
      const grown = [...prev];
      while (grown.length < next.capacity) grown.push(emptyCell());
      return grown.slice(0, next.capacity);
    });
  }, []);

  const assignToCell = useCallback((cellIndex, cameraId) => {
    setCells((prev) => {
      const next = [...prev];
      if (next[cellIndex]?.cameraId === cameraId) return prev;
      // If the camera is already on the wall, swap it into this cell.
      const src = next.findIndex((c, i) => i !== cellIndex && c.cameraId === cameraId);
      if (src >= 0) {
        const tmp = next[src];
        next[src] = next[cellIndex];
        next[cellIndex] = tmp;
        return next;
      }
      next[cellIndex] = { cameraId };
      return next;
    });
  }, []);

  // Swap two tiles (tile→tile drag).
  const swapCells = useCallback((from, to) => {
    setCells((prev) => {
      if (from === to) return prev;
      const next = [...prev];
      const tmp = next[from];
      next[from] = next[to];
      next[to] = tmp;
      return next;
    });
  }, []);

  const closeCell = useCallback((cellIndex) => {
    setCells((prev) => {
      const next = [...prev];
      next[cellIndex] = emptyCell();
      return next;
    });
    setSpotlight((s) => (s === cellIndex ? null : s));
  }, []);

  const pickCamera = useCallback(
    (cam) => {
      const idx = cellsRef.current.findIndex((c) => !c.cameraId);
      if (idx === -1) {
        toast.message("Grid full — remove a tile or pick a larger layout.");
        return;
      }
      assignToCell(idx, cam.id);
    },
    [assignToCell],
  );

  // ── Stable, INDEX-BASED tile handlers (video-wall render-perf) ────────────
  // One handler instance shared by every tile — each tile passes its OWN stable
  // `index` when invoking. This replaces the per-render `(x) => fn(i, x)` closures
  // that captured `i` and broke WallTile's React.memo (a fresh function prop each
  // render forced ALL tiles + LivePlayers to re-render on any parent render).
  const handleAssign = useCallback(
    (cameraId, index) => assignToCell(index, cameraId),
    [assignToCell],
  );
  const handleSwap = useCallback((from, index) => swapCells(from, index), [swapCells]);
  const handleClose = useCallback((index) => closeCell(index), [closeCell]);
  const handleSpotlight = useCallback((index) => setSpotlight(index), []);
  const handlePickHere = useCallback(
    (index) => setPicker({ open: true, tileIndex: index }),
    [],
  );

  const clearWall = () =>
    setConfirm({
      title: "Clear wall",
      message: "Remove every camera from the grid? Live sessions are released.",
      confirmLabel: "Clear",
      danger: false,
      onConfirm: () => {
        setCells(Array.from({ length: layout.capacity }, emptyCell));
        setTour((t) => ({ ...t, active: false }));
        setSpotlight(null);
        setConfirm(null);
      },
    });

  // ── pattern-ready hook ───────────────────────────────────────────────────
  // Restore an ENTIRE wall from a preset { layout, tiles:[cameraId|null] } in a
  // single call. This is the seam a future saved-pattern feature plugs into:
  // load a pattern → applyWallPreset(pattern) and the wall reflects it. Nothing
  // else needs to know how cells/profiles are structured.
  const applyWallPreset = useCallback((preset) => {
    if (!preset) return;
    const key = preset.layout || DEFAULT_LAYOUT_KEY;
    const cap = getLayout(key).capacity;
    const ids = presetTilesForCapacity(preset.tiles, cap);
    setSpotlight(null);
    setLayoutKey(key);
    setCells(ids.map((id) => (id ? { cameraId: id } : emptyCell())));
    setTour((t) => ({ ...t, active: false }));
  }, []);

  // ── server patterns + camera-groups (the real pattern feature) ───────────
  // A pattern rotates through camera GROUPS, each painting the wall via
  // applyWallPreset. Camera groups carry their own grid layout.
  const patternsQ = useQuery<any>({
    queryKey: ["vms-patterns"],
    queryFn: () => vms.patterns.list({ is_active: true }),
    staleTime: 30_000,
  });
  const groupsQ = useQuery<any>({
    queryKey: ["vms-camera-groups"],
    queryFn: () => vms.groups.list(),
    staleTime: 30_000,
  });
  const patterns = useMemo(() => asItems(patternsQ.data), [patternsQ.data]);
  const groups = useMemo(() => asItems(groupsQ.data), [groupsQ.data]);
  const groupById = useMemo(() => {
    const m = new Map<any, any>();
    groups.forEach((g) => m.set(g.id, g));
    return m;
  }, [groups]);

  const [activePattern, setActivePattern] = useState<any>(null);
  const rotation = usePatternRotation({
    pattern: activePattern,
    groupById,
    cameraIdSet,
    applyWallPreset,
  });

  const startPattern = useCallback(
    (pattern, { fullscreen = false }: any = {}) => {
      if (!pattern) return;
      setActivePattern(pattern);
      setSpotlight(null);
      setTour((t) => ({ ...t, active: false }));
      rotation.start();
      if (fullscreen) {
        // Defer to next frame so the wall element exists before requesting FS.
        requestAnimationFrame(() => wallRef.current?.requestFullscreen?.());
      }
    },
    [rotation],
  );

  const exitPattern = useCallback(() => {
    rotation.stop();
    setActivePattern(null);
  }, [rotation]);

  // Deep-link: ?pattern_id=<id>&autoplay=1 → load + start (optionally FS). Read
  // from window.location to sidestep the useSearchParams Suspense rule. Waits for
  // the pattern list so the referenced pattern resolves.
  const deepLinkHandled = useRef(false);
  useEffect(() => {
    if (deepLinkHandled.current || typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const pid = params.get("pattern_id");
    if (!pid) return;
    if (patternsQ.isLoading) return; // wait for the list
    deepLinkHandled.current = true;
    const found = patterns.find((p) => p.id === pid);
    if (found) {
      const autoplay = params.get("autoplay") === "1";
      startPattern(found, { fullscreen: autoplay });
    } else {
      toast.error("Pattern not found.");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patternsQ.isLoading, patterns]);

  // If the user manually edits the wall (assign/clear/tour) while a pattern is
  // running, the pattern picker still reflects the active pattern; explicit exit
  // (HUD ✕ / picker Stop) tears it down. No implicit exit — keeps it predictable.

  // ── saved layouts (browser-local recall of a single static grid) ─────────
  const saveCurrent = () => {
    const name = saveName.trim();
    if (!name) return;
    // Saved layouts remain a fast, browser-local recall of a single static grid
    // (complementary to server Patterns, which rotate through camera groups).
    const preset = buildPreset(layoutKey, cells);
    const entry = { id: `${Date.now()}`, name, ...preset };
    setSavedLayouts((prev) => [entry, ...prev.filter((s) => s.name !== name)]);
    setSaveName("");
    setSaveOpen(false);
    toast.success(`Saved layout “${name}”`);
  };

  const applySaved = (entry) =>
    // Newer entries ARE presets ({layout, tiles}); tolerate the legacy
    // {layoutKey, cameraIds} shape from before the redesign.
    applyWallPreset({
      layout: entry.layout || entry.layoutKey,
      tiles: entry.tiles || entry.cameraIds,
    });
  const deleteSaved = (id) => setSavedLayouts((prev) => prev.filter((s) => s.id !== id));

  // ── tour / carousel ─────────────────────────────────────────────────────
  const loadCameraIds = useCallback((ids) => {
    setCells((prev) => {
      const next = Array.from({ length: prev.length }, emptyCell);
      ids.slice(0, prev.length).forEach((id, i) => {
        next[i] = { cameraId: id };
      });
      return next;
    });
  }, []);

  const startTour = () => {
    const ids = [...cameras]
      .sort((a, b) => (a.status === "online" ? -1 : 1) - (b.status === "online" ? -1 : 1))
      .map((c) => c.id);
    const pages = tourPages(ids, layout.capacity);
    if (pages.length === 0) {
      toast.message("No cameras to tour.");
      return;
    }
    setSpotlight(null);
    setTour((t) => ({ ...t, active: true, pages, index: 0 }));
    loadCameraIds(pages[0]);
  };
  const stopTour = () => setTour((t) => ({ ...t, active: false }));
  const setTourInterval = (s) => setTour((t) => ({ ...t, seconds: s }));

  useEffect(() => {
    if (!tour.active || tour.pages.length <= 1) return undefined;
    const ms = Math.max(3, tour.seconds) * 1000;
    const id = setInterval(() => {
      setTour((t) => {
        if (!t.active || t.pages.length === 0) return t;
        const nextIndex = (t.index + 1) % t.pages.length;
        loadCameraIds(t.pages[nextIndex]);
        return { ...t, index: nextIndex };
      });
    }, ms);
    return () => clearInterval(id);
  }, [tour.active, tour.pages, tour.seconds, loadCameraIds]);

  // ── fullscreen wall ──────────────────────────────────────────────────────
  const toggleFullscreenWall = () => {
    const el = wallRef.current;
    if (!el) return;
    if (!document.fullscreenElement) el.requestFullscreen?.();
    else document.exitFullscreen?.();
  };

  // ── mute-all: sweep the wall's <video> elements (LivePlayer stays untouched,
  // so we drive its media element directly rather than remounting it). ────────
  useEffect(() => {
    const root = gridRef.current;
    if (!root) return;
    root.querySelectorAll("video").forEach((v) => {
      v.muted = allMuted;
    });
  }, [allMuted, cells]);

  // ESC exits spotlight (fullscreen exit is handled natively by the browser).
  useEffect(() => {
    if (spotlight == null) return undefined;
    const onKey = (e) => e.key === "Escape" && setSpotlight(null);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [spotlight]);

  // ── spotlight navigation (prev/next through FILLED tiles) ─────────────────
  const filledIndexes = useMemo(
    () => cells.map((c, i) => (c.cameraId ? i : -1)).filter((i) => i >= 0),
    [cells],
  );
  const stepSpotlight = (dir) => {
    if (spotlight == null || filledIndexes.length === 0) return;
    const pos = filledIndexes.indexOf(spotlight);
    const nextPos = (pos + dir + filledIndexes.length) % filledIndexes.length;
    setSpotlight(filledIndexes[nextPos]);
  };

  const hero = heroIndex(layout);

  // Global quality override → forces the media profile (Auto defers to the
  // per-tile grid heuristic). eco/balanced → sub-stream, high/turbo → main.
  const qualityProfile = useMemo(
    () => QUALITY_LEVELS.find((l) => l.key === quality)?.profile || null,
    [quality],
  );

  // Per-tile grid-area styles, memoised so each tile gets a REFERENTIALLY STABLE
  // `style` prop (tileStyle() builds a fresh {gridArea} object for spotlight
  // layouts each call — that alone would defeat WallTile's memo). Symmetric
  // layouts yield undefined (already stable). Rebuilds only when the layout
  // changes. tileStyleFor(i) reads from this frozen array.
  const tileStyles = useMemo(
    () => Array.from({ length: layout.capacity }, (_, i) => tileStyle(layout, i)),
    [layout],
  );
  const tileStyleFor = useCallback((i) => tileStyles[i], [tileStyles]);

  const isSpotlightActive = spotlight != null && !!cells[spotlight]?.cameraId;
  const spotlightCam = spotlight != null ? cameraById.get(cells[spotlight]?.cameraId) : null;

  // Render a single WallTile. Keyed by STABLE tile index so promoting to
  // spotlight preserves the mounted LivePlayer (session reuse).
  const renderTile = (cell, i, { isHero = false, spotlightMode = false }: any = {}) => (
    <WallTile
      key={`tile-${i}`}
      index={i}
      cameraId={cell.cameraId}
      camera={cell.cameraId ? cameraById.get(cell.cameraId) : null}
      // Profile is derived from the GRID (not spotlight) so a tile's LivePlayer
      // key is stable across spotlight ↔ grid — the session is reused, not
      // restarted. The spotlight hero simply gets a bigger surface, same stream.
      profile={qualityProfile || tileProfile(layout.capacity, isHero)}
      isHero={isHero || spotlightMode}
      spotlight={spotlightMode}
      railDragging={railDragging}
      style={spotlightMode ? undefined : tileStyleFor(i)}
      onAssign={handleAssign}
      onSwap={handleSwap}
      onClose={handleClose}
      onSpotlight={handleSpotlight}
      onPickHere={handlePickHere}
    />
  );

  return (
    <div
      ref={wallRef}
      className="flex h-full min-h-0 flex-col fullscreen:h-screen"
      style={{ background: "radial-gradient(1200px 700px at 50% 115%, #14284f 0%, #0c1530 55%)" }}
    >
      <WallToolbar
        railOpen={railOpen}
        onToggleRail={() => setRailOpen((o) => !o)}
        layoutKey={layoutKey}
        onLayoutChange={changeLayout}
        liveCount={liveCount}
        onlineCount={onlineCount}
        viewMode={viewMode}
        onViewMode={setViewMode}
        quality={quality}
        onQuality={setQuality}
        playoutOpen={playoutOpen}
        onTogglePlayout={() => setPlayoutOpen((o) => !o)}
        alarmCount={0}
        tour={tour}
        onStartTour={startTour}
        onStopTour={stopTour}
        onTourInterval={setTourInterval}
        patternControl={
          <PatternPickerMenu
            patterns={patterns}
            loading={patternsQ.isLoading}
            activeId={rotation.active ? activePattern?.id : null}
            onPlay={(p) => startPattern(p)}
            onStop={exitPattern}
            onCreate={() => setPatternFormOpen(true)}
          />
        }
        savedControl={
          <SavedLayoutsMenu layouts={savedLayouts} onApply={applySaved} onDelete={deleteSaved} onSave={() => setSaveOpen(true)} canSave={liveCount > 0} />
        }
        onSaveGroup={() => setSaveGroupOpen(true)}
        canSaveGroup={liveCount > 0}
        allMuted={allMuted}
        onToggleMuteAll={() => setAllMuted((m) => !m)}
        onFullscreen={toggleFullscreenWall}
        onClear={clearWall}
        onRefresh={() => camerasQ.refetch()}
        refreshing={camerasQ.isFetching}
      />

      <div className="flex min-h-0 flex-1">
        {railOpen && (
          <CameraRail
            cameras={cameras}
            mountedIds={mountedIds}
            onPick={pickCamera}
            onDragStateChange={setRailDragging}
            isLoading={camerasQ.isLoading || fedQ.isLoading}
            onlineCount={onlineCount}
            liveCount={liveCount}
          />
        )}

        <main className="relative z-0 flex min-w-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1">
            {/* Grid — the hero. Full-bleed with tight gaps. Hidden in MAP view;
                shares the row with the map in SPLIT (grid gets slightly more).
                The grid CONTAINER is the SAME element across grid↔spotlight (only
                its template + children change) so the spotlighted tile — kept with
                its stable `tile-i` key — is preserved by React, reusing its
                LivePlayer session instead of remounting. */}
            {viewMode !== "map" && (
              <div
                className={`relative min-h-0 overflow-hidden p-1.5 ${viewMode === "split" ? "flex-[1.15]" : "flex-1"}`}
              >
                <div
                  ref={gridRef}
                  className="grid h-full min-h-0 gap-1.5"
                  style={isSpotlightActive ? SPOTLIGHT_GRID : gridStyle(layout)}
                >
                  {isSpotlightActive
                    ? renderTile(cells[spotlight], spotlight, { spotlightMode: true })
                    : cells.map((cell, i) => renderTile(cell, i, { isHero: i === hero }))}
                </div>
                {isSpotlightActive && (
                  <SpotlightOverlay
                    label={spotlightCam?.name || "Camera"}
                    position={filledIndexes.indexOf(spotlight) + 1}
                    total={filledIndexes.length}
                    onPrev={() => stepSpotlight(-1)}
                    onNext={() => stepSpotlight(1)}
                    onExit={() => setSpotlight(null)}
                  />
                )}
                {rotation.active && !isSpotlightActive && (
                  <PatternHud
                    patternName={activePattern?.name || "Pattern"}
                    groupName={rotation.current?.name}
                    index={rotation.index}
                    total={rotation.total}
                    paused={rotation.paused}
                    seconds={rotation.seconds}
                    onPrev={rotation.prev}
                    onNext={rotation.next}
                    onTogglePause={rotation.togglePause}
                    onExit={exitPattern}
                  />
                )}
              </div>
            )}

            {/* Facility MAP — camera positions over a site map. Scaffold until
                site geometry / camera coordinates exist (honest empty state). */}
            {viewMode !== "grid" && (
              <div className={`relative min-h-0 p-1.5 ${viewMode === "split" ? "flex-1 border-l border-[rgba(150,180,245,.15)]" : "flex-1"}`}>
                <MapView cameras={cameras} onPick={(cam) => pickCamera(cam)} />
              </div>
            )}
          </div>

          {/* DVR playout transport (24h timeline + scrub). Wall-level, toggled
              from the toolbar. Wired to the selected/first camera. */}
          {playoutOpen && (
            <PlayoutBar
              camera={spotlightCam || cameraById.get(wallCameraIds[0]) || null}
              onClose={() => setPlayoutOpen(false)}
            />
          )}
        </main>
      </div>

      {/* Quick camera picker (click an empty tile) */}
      <CameraQuickPicker
        open={picker.open}
        cameras={cameras}
        mountedIds={mountedIds}
        tileIndex={picker.tileIndex}
        onPick={(camId) => {
          if (picker.tileIndex != null) assignToCell(picker.tileIndex, camId);
          setPicker({ open: false, tileIndex: null });
        }}
        onClose={() => setPicker({ open: false, tileIndex: null })}
      />

      {/* Save layout modal */}
      <Modal
        open={saveOpen}
        onClose={() => setSaveOpen(false)}
        title="Save wall layout"
        footer={
          <>
            <Button variant="secondary" onClick={() => setSaveOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={saveCurrent} disabled={!saveName.trim()}>
              Save
            </Button>
          </>
        }
      >
        <Input
          label="Layout name"
          value={saveName}
          onChange={(e) => setSaveName(e.target.value)}
          placeholder="e.g. Lobby overview"
          autoFocus
          onKeyDown={(e) => e.key === "Enter" && saveCurrent()}
        />
        <p className="mt-2 text-xs text-[#9a92c8]">
          Saves the grid + camera assignment to this browser. {liveCount} camera{liveCount === 1 ? "" : "s"} on the wall.
        </p>
      </Modal>

      {/* Inline: save the current wall as a server Camera Group (fewer clicks — no
          trip to Config → Patterns → Camera Groups). */}
      <SaveWallGroupModal
        open={saveGroupOpen}
        layoutKey={layoutKey}
        cameraIds={wallCameraIds}
        onClose={() => setSaveGroupOpen(false)}
        onSaved={() => {
          setSaveGroupOpen(false);
          qc.invalidateQueries({ queryKey: ["vms-camera-groups"] });
        }}
      />

      {/* Inline: build a Pattern (rotation of groups) without leaving the wall. */}
      <PatternFormModal
        open={patternFormOpen}
        pattern={null}
        groups={groups}
        onClose={() => setPatternFormOpen(false)}
        onSaved={() => {
          setPatternFormOpen(false);
          qc.invalidateQueries({ queryKey: ["vms-patterns"] });
        }}
      />

      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}

// Compact saved-layouts dropdown (browser-local recall of a single static
// grid). Applies a preset via the parent's applyWallPreset.
function SavedLayoutsMenu({ layouts, onApply, onDelete, onSave, canSave }: any) {
  const [open, setOpen] = useState(false);
  const ref = useRef<any>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Saved layouts"
        className="inline-flex h-8 items-center gap-1.5 rounded-[8px] border border-[rgba(150,180,245,.22)] bg-[rgba(150,180,245,.04)] px-2.5 text-xs font-medium text-[#aec2e8] transition hover:border-[rgba(34,211,238,.5)] hover:text-[#67e8f9]"
      >
        <Icon icon="heroicons-outline:bookmark" className="text-sm text-[#7e93bf]" />
        Saved
        {layouts.length > 0 && (
          <span className="rounded-full bg-[rgba(150,180,245,.1)] px-1.5 text-[9px] font-semibold text-[#aec2e8]">{layouts.length}</span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-1.5 w-64 rounded-[13px] border border-[rgba(160,150,245,.22)] bg-[rgba(8,15,34,.93)] py-1 shadow-2xl backdrop-blur-xs">
          <div className="flex items-center justify-between px-3 py-1.5">
            <span className="font-mono text-[10px] font-semibold uppercase tracking-[1.6px] text-[#9a92c8]">Saved layouts</span>
            <button
              type="button"
              disabled={!canSave}
              onClick={() => {
                onSave?.();
                setOpen(false);
              }}
              className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-[#67e8f9] transition hover:bg-[rgba(34,211,238,.12)] disabled:opacity-40"
            >
              <Icon icon="heroicons-mini:plus" className="text-xs" />
              Save current
            </button>
          </div>
          {layouts.length === 0 ? (
            <div className="px-3 py-3 text-xs text-[#aec2e8]">
              No saved layouts yet — fill the grid and click <em>Save current</em>.
            </div>
          ) : (
            <ul className="max-h-72 overflow-y-auto border-t border-[rgba(160,150,245,.22)] pt-1">
              {layouts.map((l) => (
                <li key={l.id} className="flex items-center justify-between gap-2 px-2 py-1.5 hover:bg-[rgba(150,180,245,.07)]">
                  <button
                    type="button"
                    onClick={() => {
                      onApply(l);
                      setOpen(false);
                    }}
                    className="min-w-0 flex-1 text-left"
                  >
                    <div className="truncate text-xs font-semibold text-[#f2f6ff]">{l.name}</div>
                    <div className="text-[10px] text-[#7e93bf]">
                      {getLayout(l.layout || l.layoutKey).label} ·{" "}
                      {(l.tiles || l.cameraIds || []).filter(Boolean).length} cameras
                    </div>
                  </button>
                  <button
                    type="button"
                    title="Delete"
                    onClick={() => onDelete(l.id)}
                    className="shrink-0 rounded-sm p-1 text-[#7e93bf] hover:bg-red-500/10 hover:text-red-500"
                  >
                    <Icon icon="heroicons-outline:trash" className="text-xs" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
