"use client";

// VMS → Streaming: the multi-camera video wall (P2-D). This is the client-facing
// "wow" surface. Ported from neubit_v2's streaming page + gvd_nvr's LiveStream
// wall, rethemed to v3 dark tokens and wired to OUR session API (each tile owns
// a PlaybackSession via LivePlayer → useLiveSession).
//
// Features:
//   • Layout selector 1/4/6/9/12/16/25 (videoWall.LAYOUTS + gridStyle).
//   • Left rail: searchable, draggable camera list; drag-to-tile + click-to-add.
//   • Saved layouts — persisted per-user in localStorage (P2 scope; a settings
//     call can replace this later). Save / load / delete named walls.
//   • Camera tour: cycle PAGES of a camera set through the grid on an interval
//     (videoWall.tourPages) — the classic NVR "carousel".
//   • Per-tile: status/name overlay, snapshot + fullscreen (WallTile).
//
// Tile lifecycle: only tiles with a cameraId mount a LivePlayer, and the player
// releases its session on unmount — so paging a tour or shrinking the layout
// tears down the off-screen sessions automatically (no orphaned MediaMTX paths).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { Button, ConfirmDialog, Input, Modal } from "@/components/ui/kit";
import { asItems } from "@/lib/format";
import { vms } from "./api";
import { DEFAULT_LAYOUT_KEY, getLayout, gridStyle, tourPages, tileProfile } from "./videoWall";
import CameraRail from "./components/CameraRail";
import WallTile from "./components/WallTile";

const LS_LAYOUT = "neubit.vms.wall.layout";
const LS_CELLS = "neubit.vms.wall.cells";
const LS_SAVED = "neubit.vms.wall.saved";

const emptyCell = () => ({ cameraId: null });

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

  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [confirm, setConfirm] = useState(null);

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

  // ── layout / assignment ────────────────────────────────────────────────
  const changeLayout = useCallback((key) => {
    const next = getLayout(key);
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
      // Swap-on-drop if already on the wall elsewhere.
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

  const closeCell = useCallback((cellIndex) => {
    setCells((prev) => {
      const next = [...prev];
      next[cellIndex] = emptyCell();
      return next;
    });
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

  const clearWall = () =>
    setConfirm({
      title: "Clear wall",
      message: "Remove every camera from the grid? Live sessions are released.",
      confirmLabel: "Clear",
      danger: false,
      onConfirm: () => {
        setCells(Array.from({ length: layout.capacity }, emptyCell));
        setTour((t) => ({ ...t, active: false }));
        setConfirm(null);
      },
    });

  // Fill the wall from a flat id list (saved layout / tour page).
  const loadCameraIds = useCallback((ids) => {
    setCells((prev) => {
      const next = Array.from({ length: prev.length }, emptyCell);
      ids.slice(0, prev.length).forEach((id, i) => {
        next[i] = { cameraId: id };
      });
      return next;
    });
  }, []);

  // ── saved layouts (localStorage) ────────────────────────────────────────
  const saveCurrent = () => {
    const name = saveName.trim();
    if (!name) return;
    const entry = {
      id: `${Date.now()}`,
      name,
      layoutKey,
      cameraIds: cells.map((c) => c.cameraId || null),
    };
    setSavedLayouts((prev) => [entry, ...prev.filter((s) => s.name !== name)]);
    setSaveName("");
    setSaveOpen(false);
    toast.success(`Saved layout “${name}”`);
  };

  const applySaved = (entry) => {
    changeLayout(entry.layoutKey);
    // changeLayout resizes async via state; set cells directly to the saved ids.
    const cap = getLayout(entry.layoutKey).capacity;
    const next = Array.from({ length: cap }, emptyCell);
    (entry.cameraIds || []).slice(0, cap).forEach((id, i) => {
      if (id) next[i] = { cameraId: id };
    });
    setCells(next);
    setTour((t) => ({ ...t, active: false }));
  };

  const deleteSaved = (id) => setSavedLayouts((prev) => prev.filter((s) => s.id !== id));

  // ── tour / carousel ─────────────────────────────────────────────────────
  const startTour = () => {
    // Tour the FULL camera estate (online-first), paged to the current layout.
    const ids = [...cameras]
      .sort((a, b) => (a.status === "online" ? -1 : 1) - (b.status === "online" ? -1 : 1))
      .map((c) => c.id);
    const pages = tourPages(ids, layout.capacity);
    if (pages.length === 0) {
      toast.message("No cameras to tour.");
      return;
    }
    setTour({ active: true, pages, index: 0, seconds: tour.seconds });
    loadCameraIds(pages[0]);
  };

  const stopTour = () => setTour((t) => ({ ...t, active: false }));

  // Advance the tour on its interval; re-page when the layout changes mid-tour.
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

  const profile = tileProfile(layout.capacity);

  return (
    <div className="flex h-[calc(100vh-3.5rem)] flex-col">
      <div className="flex min-h-0 flex-1">
        <CameraRail
          cameras={cameras}
          mountedIds={mountedIds}
          layoutKey={layoutKey}
          onLayoutChange={changeLayout}
          onPick={pickCamera}
          isLoading={camerasQ.isLoading}
          onlineCount={onlineCount}
          liveCount={liveCount}
        />

        <main className="flex min-w-0 flex-1 flex-col bg-background">
          {/* Toolbar */}
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-card-border bg-card px-4 py-2.5">
            <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <Icon icon="heroicons:signal" className="text-base text-blue-500" />
              Video Wall
              <span className="rounded bg-blue-500/10 px-1.5 py-0.5 text-[11px] font-semibold text-blue-500">
                {layout.label}
              </span>
              {tour.active && (
                <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold text-amber-500">
                  <Icon icon="svg-spinners:180-ring" className="text-xs" />
                  Tour {tour.index + 1}/{tour.pages.length}
                </span>
              )}
            </div>

            <div className="flex items-center gap-2">
              <SavedLayoutsMenu layouts={savedLayouts} onApply={applySaved} onDelete={deleteSaved} />
              {tour.active ? (
                <Button variant="secondary" icon="heroicons-outline:stop" onClick={stopTour}>
                  Stop tour
                </Button>
              ) : (
                <Button variant="secondary" icon="heroicons-outline:play" onClick={startTour}>
                  Tour
                </Button>
              )}
              {liveCount > 0 && (
                <Button variant="secondary" icon="heroicons-outline:bookmark" onClick={() => setSaveOpen(true)}>
                  Save
                </Button>
              )}
              {liveCount > 0 && (
                <Button variant="ghost" icon="heroicons-outline:x-mark" onClick={clearWall}>
                  Clear
                </Button>
              )}
              <button
                type="button"
                onClick={() => camerasQ.refetch()}
                title="Refresh cameras"
                className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-card-border text-muted hover:bg-hover hover:text-foreground"
              >
                <Icon icon="heroicons-outline:arrow-path" className={`text-base ${camerasQ.isFetching ? "animate-spin" : ""}`} />
              </button>
            </div>
          </div>

          {/* Grid */}
          <div className="min-h-0 flex-1 overflow-hidden p-3">
            <div className="grid h-full min-h-0 gap-2" style={gridStyle(layout)}>
              {cells.map((cell, i) => (
                <WallTile
                  key={i}
                  index={i}
                  cameraId={cell.cameraId}
                  camera={cell.cameraId ? cameraById.get(cell.cameraId) : null}
                  profile={profile}
                  onAssign={(camId) => assignToCell(i, camId)}
                  onClose={() => closeCell(i)}
                />
              ))}
            </div>
          </div>
        </main>
      </div>

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

// Compact saved-layouts dropdown (localStorage-backed).
function SavedLayoutsMenu({ layouts, onApply, onDelete }) {
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
      <Button variant="secondary" icon="heroicons-outline:squares-2x2" onClick={() => setOpen((o) => !o)}>
        Saved
        {layouts.length > 0 && (
          <span className="ml-0.5 rounded-full bg-hover px-1.5 text-[9px] font-semibold text-muted">{layouts.length}</span>
        )}
      </Button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 w-64 rounded-lg border border-card-border bg-card py-1 shadow-2xl">
          {layouts.length === 0 ? (
            <div className="px-3 py-3 text-xs text-muted">
              No saved layouts yet — fill the grid and click <em>Save</em>.
            </div>
          ) : (
            <ul className="max-h-72 overflow-y-auto">
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
                      {getLayout(l.layoutKey).label} · {(l.cameraIds || []).filter(Boolean).length} cameras
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
