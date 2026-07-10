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
import { useQuery } from "@tanstack/react-query";
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
import WallToolbar from "./components/WallToolbar";
import SpotlightOverlay from "./components/SpotlightOverlay";
import CameraQuickPicker from "./components/CameraQuickPicker";
import PatternPickerMenu from "./components/PatternPickerMenu";
import PatternHud from "./components/PatternHud";
import { usePatternRotation } from "./hooks/usePatternRotation";

const LS_LAYOUT = "neubit.vms.wall.layout";
const LS_CELLS = "neubit.vms.wall.cells";
const LS_SAVED = "neubit.vms.wall.saved";
const LS_RAIL = "neubit.vms.wall.rail";

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

  const [railOpen, setRailOpen] = useState(() => readLS(LS_RAIL, true) !== false);
  const [railDragging, setRailDragging] = useState(false);
  const [spotlight, setSpotlight] = useState(null); // tile index or null
  const [allMuted, setAllMuted] = useState(true);
  const [picker, setPicker] = useState({ open: false, tileIndex: null });

  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [confirm, setConfirm] = useState(null);

  const wallRef = useRef(null); // fullscreen-wall target
  const gridRef = useRef(null); // for mute-all DOM sweep

  // ── tour (carousel) ─────────────────────────────────────────────────────
  const [tour, setTour] = useState({ active: false, pages: [], index: 0, seconds: 10 });
  const cellsRef = useRef(cells);
  useEffect(() => {
    cellsRef.current = cells;
  });

  // Persist layout + cell camera-ids (never persist session URLs — short-lived).
  useEffect(() => writeLS(LS_LAYOUT, layoutKey), [layoutKey]);
  useEffect(() => writeLS(LS_CELLS, cells.map((c) => ({ cameraId: c.cameraId || null }))), [cells]);
  useEffect(() => writeLS(LS_SAVED, savedLayouts), [savedLayouts]);
  useEffect(() => writeLS(LS_RAIL, railOpen), [railOpen]);

  // ── cameras ─────────────────────────────────────────────────────────────
  const camerasQ = useQuery({
    queryKey: ["vms-wall-cameras"],
    queryFn: () => vms.cameras.list({ limit: 500 }),
    refetchInterval: 20_000,
  });
  const cameras = useMemo(() => asItems(camerasQ.data), [camerasQ.data]);
  const cameraById = useMemo(() => {
    const m = new Map();
    cameras.forEach((c) => m.set(c.id, c));
    return m;
  }, [cameras]);

  const mountedIds = useMemo(
    () => new Set(cells.map((c) => c.cameraId).filter(Boolean)),
    [cells],
  );
  const liveCount = mountedIds.size;
  const onlineCount = cameras.filter((c) => c.status === "online").length;

  // Set of camera ids that still EXIST — the rotation engine uses it to skip
  // groups whose cameras were deleted (robustness).
  const cameraIdSet = useMemo(() => new Set(cameras.map((c) => c.id)), [cameras]);

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
  // Replaces the TODO(patterns) localStorage seed with server-persisted patterns:
  // a pattern rotates through camera GROUPS, each painting the wall via
  // applyWallPreset. Camera groups carry their own grid layout.
  const patternsQ = useQuery({
    queryKey: ["vms-patterns"],
    queryFn: () => vms.patterns.list({ is_active: true }),
    staleTime: 30_000,
  });
  const groupsQ = useQuery({
    queryKey: ["vms-camera-groups"],
    queryFn: () => vms.groups.list(),
    staleTime: 30_000,
  });
  const patterns = useMemo(() => asItems(patternsQ.data), [patternsQ.data]);
  const groups = useMemo(() => asItems(groupsQ.data), [groupsQ.data]);
  const groupById = useMemo(() => {
    const m = new Map();
    groups.forEach((g) => m.set(g.id, g));
    return m;
  }, [groups]);

  const [activePattern, setActivePattern] = useState(null);
  const rotation = usePatternRotation({
    pattern: activePattern,
    groupById,
    cameraIdSet,
    applyWallPreset,
  });

  const startPattern = useCallback(
    (pattern, { fullscreen = false } = {}) => {
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

  // ── saved layouts (localStorage seed of the pattern feature) ─────────────
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
  const renderTile = (cell, i, { isHero = false, spotlightMode = false } = {}) => (
    <WallTile
      key={`tile-${i}`}
      index={i}
      cameraId={cell.cameraId}
      camera={cell.cameraId ? cameraById.get(cell.cameraId) : null}
      // Profile is derived from the GRID (not spotlight) so a tile's LivePlayer
      // key is stable across spotlight ↔ grid — the session is reused, not
      // restarted. The spotlight hero simply gets a bigger surface, same stream.
      profile={tileProfile(layout.capacity, isHero)}
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
    <div ref={wallRef} className="flex h-[calc(100vh-3.5rem)] flex-col bg-background fullscreen:h-screen">
      <WallToolbar
        railOpen={railOpen}
        onToggleRail={() => setRailOpen((o) => !o)}
        layoutKey={layoutKey}
        onLayoutChange={changeLayout}
        liveCount={liveCount}
        onlineCount={onlineCount}
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
          />
        }
        savedControl={
          <SavedLayoutsMenu layouts={savedLayouts} onApply={applySaved} onDelete={deleteSaved} onSave={() => setSaveOpen(true)} canSave={liveCount > 0} />
        }
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
            isLoading={camerasQ.isLoading}
            onlineCount={onlineCount}
            liveCount={liveCount}
          />
        )}

        <main className="relative flex min-w-0 flex-1 flex-col bg-[#050506]">
          {/* Grid — the hero. Full-bleed with tight gaps.
              The grid CONTAINER is the SAME element in both modes (only its
              template + children change) so the spotlighted tile — kept with its
              stable `tile-i` key — is preserved by React across grid↔spotlight,
              reusing its LivePlayer session instead of remounting. In spotlight
              mode every OTHER tile is omitted, so their players unmount and their
              sessions release. */}
          <div className="relative min-h-0 flex-1 overflow-hidden p-1.5">
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
        <p className="mt-2 text-xs text-muted">
          Saves the grid + camera assignment to this browser. {liveCount} camera{liveCount === 1 ? "" : "s"} on the wall.
        </p>
      </Modal>

      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}

// Compact saved-layouts dropdown (localStorage-backed seed of the pattern
// feature). Applies a preset via the parent's applyWallPreset; the parent's
// TODO(patterns) marks where server-persisted patterns replace this store.
function SavedLayoutsMenu({ layouts, onApply, onDelete, onSave, canSave }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

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
        className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-card-border bg-card px-2.5 text-xs font-medium text-foreground transition hover:bg-hover"
      >
        <Icon icon="heroicons-outline:bookmark" className="text-sm text-muted" />
        Saved
        {layouts.length > 0 && (
          <span className="rounded-full bg-hover px-1.5 text-[9px] font-semibold text-muted">{layouts.length}</span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-1.5 w-64 rounded-xl border border-card-border bg-card py-1 shadow-2xl">
          <div className="flex items-center justify-between px-3 py-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-muted">Saved layouts</span>
            <button
              type="button"
              disabled={!canSave}
              onClick={() => {
                onSave?.();
                setOpen(false);
              }}
              className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-blue-500 transition hover:bg-blue-500/10 disabled:opacity-40"
            >
              <Icon icon="heroicons-mini:plus" className="text-xs" />
              Save current
            </button>
          </div>
          {layouts.length === 0 ? (
            <div className="px-3 py-3 text-xs text-muted">
              No saved layouts yet — fill the grid and click <em>Save current</em>.
            </div>
          ) : (
            <ul className="max-h-72 overflow-y-auto border-t border-card-border pt-1">
              {layouts.map((l) => (
                <li key={l.id} className="flex items-center justify-between gap-2 px-2 py-1.5 hover:bg-hover">
                  <button
                    type="button"
                    onClick={() => {
                      onApply(l);
                      setOpen(false);
                    }}
                    className="min-w-0 flex-1 text-left"
                  >
                    <div className="truncate text-xs font-semibold text-foreground">{l.name}</div>
                    <div className="text-[10px] text-muted">
                      {getLayout(l.layout || l.layoutKey).label} ·{" "}
                      {(l.tiles || l.cameraIds || []).filter(Boolean).length} cameras
                    </div>
                  </button>
                  <button
                    type="button"
                    title="Delete"
                    onClick={() => onDelete(l.id)}
                    className="shrink-0 rounded p-1 text-muted hover:bg-red-500/10 hover:text-red-500"
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
