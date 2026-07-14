"use client";

// GroupGridBuilder — the camera-to-grid authoring surface for a Camera Group.
// LEFT: a filterable list of the camera estate. RIGHT: a live preview grid sized
// to the chosen `layout` (backend enum). Click a camera to drop it into the next
// empty cell (or pull it back out); drag a camera onto a cell to place/swap; the
// per-cell × clears it. Ported from neubit_v2's patterns grid-builder, reskinned
// to v3 dark tokens and driven by videoWall.getGroupLayout.
//
// State model: `cells` is a flat array of `cameraId | null` (top-left →
// bottom-right), length === layout.capacity. The parent owns it (controlled) so
// it can seed from an existing group and read it back on save.
import { useMemo, useState } from "react";
import { Icon } from "@iconify/react";

import { getGroupLayout, groupGridStyle } from "../videoWall";
import { StatusDot } from "./StatusBadge";

const CAMERA_DRAG_MIME = "application/x-neubit-vms-camera";

export default function GroupGridBuilder({ layout, cameras = [], cells = [], onChange, error }) {
  const [search, setSearch] = useState("");
  const [dragOverCell, setDragOverCell] = useState(null);

  const grid = getGroupLayout(layout);
  const capacity = grid.capacity;

  const cameraById = useMemo(() => {
    const m = new Map();
    cameras.forEach((c) => m.set(c.id, c));
    return m;
  }, [cameras]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return cameras;
    return cameras.filter(
      (c) =>
        c.name?.toLowerCase().includes(needle) ||
        c.ip_address?.toLowerCase?.().includes(needle) ||
        c.site_name?.toLowerCase?.().includes(needle),
    );
  }, [cameras, search]);

  const placedCount = cells.filter(Boolean).length;

  // ── mutations (produce a fresh cells array, hand it up) ────────────────────
  function place(cameraId, targetIdx = null, sourceIdx = null) {
    const next = [...cells];
    while (next.length < capacity) next.push(null);

    if (targetIdx != null) {
      // Drag/drop into a specific cell (with swap when the source is a cell).
      const targetCamera = next[targetIdx];
      if (sourceIdx != null && sourceIdx >= 0 && sourceIdx < next.length) {
        next[sourceIdx] = targetCamera && targetCamera !== cameraId ? targetCamera : null;
      }
      for (let i = 0; i < next.length; i += 1) {
        if (i !== targetIdx && i !== sourceIdx && next[i] === cameraId) next[i] = null;
      }
      next[targetIdx] = cameraId;
      onChange?.(next.slice(0, capacity));
      return;
    }

    // Click from the list: toggle out if already placed, else fill next empty.
    if (next.includes(cameraId)) {
      onChange?.(next.map((c) => (c === cameraId ? null : c)).slice(0, capacity));
      return;
    }
    const idx = next.findIndex((c) => !c);
    if (idx === -1) return; // grid full — silently ignore (count shown in header)
    next[idx] = cameraId;
    onChange?.(next.slice(0, capacity));
  }

  function clearCell(idx) {
    const next = [...cells];
    next[idx] = null;
    onChange?.(next.slice(0, capacity));
  }

  function onCameraDragStart(e, cameraId, sourceIdx = null) {
    e.dataTransfer.setData(CAMERA_DRAG_MIME, JSON.stringify({ cameraId, sourceIdx }));
    e.dataTransfer.effectAllowed = "move";
  }
  function onCellDrop(e, idx) {
    e.preventDefault();
    setDragOverCell(null);
    const raw = e.dataTransfer.getData(CAMERA_DRAG_MIME);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      if (parsed?.cameraId) place(parsed.cameraId, idx, parsed.sourceIdx ?? null);
    } catch {
      /* malformed payload — ignore */
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between pb-2">
        <FieldLabel>Camera layout</FieldLabel>
        <span className="text-[11px] font-medium tabular-nums text-muted">
          {placedCount} / {capacity} placed
        </span>
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[240px_1fr]">
        {/* ── camera picker ──────────────────────────────────────────────── */}
        <div className="flex min-h-0 flex-col rounded-lg border border-card-border">
          <div className="border-b border-card-border p-2">
            <label className="relative block">
              <Icon
                icon="heroicons-outline:magnifying-glass"
                className="absolute left-2 top-1/2 -translate-y-1/2 text-sm text-muted"
              />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search cameras…"
                className="h-8 w-full rounded-md border border-field bg-transparent pl-7 pr-2 text-xs text-foreground placeholder:text-muted outline-none focus:border-muted"
              />
            </label>
          </div>
          <div className="max-h-72 space-y-1 overflow-y-auto p-1.5">
            {cameras.length === 0 ? (
              <div className="px-2 py-3 text-xs text-muted">No cameras onboarded.</div>
            ) : filtered.length === 0 ? (
              <div className="px-2 py-3 text-xs text-muted">No cameras match.</div>
            ) : (
              filtered.map((c) => {
                const placed = cells.includes(c.id);
                return (
                  <button
                    key={c.id}
                    type="button"
                    draggable
                    onDragStart={(e) => onCameraDragStart(e, c.id)}
                    onClick={() => place(c.id)}
                    title={placed ? "Click to remove from grid" : "Click to place in next empty cell"}
                    className={`flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left text-xs transition ${
                      placed
                        ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
                        : "cursor-grab border-card-border text-foreground hover:bg-hover active:cursor-grabbing"
                    }`}
                  >
                    <StatusDot status={c.status} />
                    <span className="min-w-0 flex-1 truncate">{c.name}</span>
                    {placed && (
                      <span className="rounded-full bg-emerald-500/20 px-1.5 py-0.5 text-[9px] font-bold text-emerald-400">
                        ON GRID
                      </span>
                    )}
                  </button>
                );
              })
            )}
          </div>
        </div>

        {/* ── preview grid ───────────────────────────────────────────────── */}
        <div className="rounded-lg border border-card-border bg-[#050506] p-2">
          <div className="grid h-72 gap-1.5" style={groupGridStyle(grid)}>
            {Array.from({ length: capacity }, (_, i) => {
              const cid = cells[i];
              const cam = cid ? cameraById.get(cid) : null;
              return (
                <div
                  key={i}
                  draggable={Boolean(cam)}
                  onDragStart={cam ? (e) => onCameraDragStart(e, cid, i) : undefined}
                  onDragEnd={() => setDragOverCell(null)}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragOverCell(i);
                  }}
                  onDragLeave={() => setDragOverCell((cur) => (cur === i ? null : cur))}
                  onDrop={(e) => onCellDrop(e, i)}
                  className={`group/cell relative overflow-hidden rounded-md border-2 border-dashed text-[10px] transition ${
                    dragOverCell === i ? "ring-2 ring-blue-500/60" : ""
                  } ${
                    cam
                      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200"
                      : "border-card-border bg-hover/30 text-muted"
                  }`}
                >
                  <div className="flex h-full items-center justify-center px-1 text-center">
                    <span className="truncate font-medium">
                      {cam ? cam.name || cid : `Cell ${i + 1}`}
                    </span>
                  </div>
                  {cam && (
                    <button
                      type="button"
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation();
                        clearCell(i);
                      }}
                      title="Clear cell"
                      className="absolute right-1 top-1 z-10 rounded-full bg-black/50 p-0.5 text-white opacity-0 transition hover:bg-red-500/70 group-hover/cell:opacity-100"
                    >
                      <Icon icon="heroicons-mini:x-mark" className="text-[10px]" />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
      {error && <p className="mt-1.5 text-xs text-red-500">{error}</p>}
    </div>
  );
}

function FieldLabel({ children }) {
  return (
    <span className="text-xs font-medium uppercase tracking-wide text-muted">{children}</span>
  );
}
