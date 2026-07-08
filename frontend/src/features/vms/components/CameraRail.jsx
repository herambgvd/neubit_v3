"use client";

// Video-wall left rail — the camera source list + layout picker. Ported from
// neubit_v2's streaming `camera-rail`, rethemed to v3 tokens.
//
//   • Layout selector (1/4/6/9/12/16/25) — buttons keyed off videoWall.LAYOUTS.
//   • Searchable camera list; each row is DRAGGABLE (dataTransfer
//     "text/camera-id") and click-to-add-to-next-free-tile. Mounted cameras
//     show a "On wall" chip.
//   • Online / on-wall counters.
import { useMemo, useState } from "react";
import { Icon } from "@iconify/react";

import { LAYOUTS } from "../videoWall";
import { StatusDot } from "./StatusBadge";

export default function CameraRail({
  cameras = [],
  mountedIds,
  layoutKey,
  onLayoutChange,
  onPick,
  isLoading,
  onlineCount = 0,
  liveCount = 0,
}) {
  const [q, setQ] = useState("");

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return cameras;
    return cameras.filter(
      (c) =>
        c.name?.toLowerCase().includes(needle) ||
        c.ip?.toLowerCase?.().includes(needle) ||
        c.brand?.toLowerCase?.().includes(needle),
    );
  }, [cameras, q]);

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-card-border bg-card/40">
      {/* Layout picker */}
      <div className="border-b border-card-border p-3">
        <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-muted">Layout</p>
        <div className="grid grid-cols-4 gap-1.5">
          {LAYOUTS.map((l) => (
            <button
              key={l.key}
              type="button"
              title={`${l.label} (${l.capacity} tiles)`}
              onClick={() => onLayoutChange?.(l.key)}
              className={`rounded-md border px-1 py-1.5 text-[11px] font-medium transition ${
                layoutKey === l.key
                  ? "border-foreground bg-foreground text-background"
                  : "border-card-border text-muted hover:bg-hover hover:text-foreground"
              }`}
            >
              {l.label}
            </button>
          ))}
        </div>
      </div>

      {/* Search */}
      <div className="border-b border-card-border p-3">
        <label className="relative block">
          <Icon icon="heroicons-outline:magnifying-glass" className="absolute left-2.5 top-1/2 -translate-y-1/2 text-sm text-muted" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search cameras…"
            className="h-9 w-full rounded-lg border border-field bg-transparent pl-8 pr-3 text-sm text-foreground placeholder:text-muted outline-none focus:border-muted"
          />
        </label>
        <div className="mt-2 flex items-center gap-3 text-[11px] text-muted">
          <span className="inline-flex items-center gap-1">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> {onlineCount} online
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="h-1.5 w-1.5 rounded-full bg-blue-500" /> {liveCount} on wall
          </span>
        </div>
      </div>

      {/* Camera list */}
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {isLoading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-xs text-muted">
            <Icon icon="svg-spinners:180-ring" className="text-base" /> Loading…
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-3 py-10 text-center text-xs text-muted">No cameras match.</div>
        ) : (
          <ul className="space-y-1">
            {filtered.map((c) => {
              const onWall = mountedIds?.has(c.id);
              return (
                <li key={c.id}>
                  <button
                    type="button"
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData("text/camera-id", c.id);
                      e.dataTransfer.effectAllowed = "copy";
                    }}
                    onClick={() => onPick?.(c)}
                    className={`flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left transition ${
                      onWall ? "bg-hover" : "hover:bg-hover"
                    }`}
                  >
                    <Icon icon="heroicons-outline:bars-3" className="shrink-0 cursor-grab text-sm text-muted" />
                    <StatusDot status={c.status} />
                    <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">{c.name}</span>
                    {onWall && (
                      <span className="shrink-0 rounded-full bg-blue-500/10 px-1.5 py-0.5 text-[9px] font-semibold text-blue-500">
                        On wall
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </aside>
  );
}
