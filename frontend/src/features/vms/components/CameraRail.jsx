"use client";

// Video-wall left rail — the camera SOURCE list, redesigned for P2-D. Layout
// selection now lives in the toolbar's LayoutPicker; the rail focuses on
// cameras:
//   • Search + live counters (online / on-wall).
//   • Rich rows: status dot, name, site, and an "on wall" indicator. Each row is
//     a drag SOURCE (dataTransfer "text/camera-id") and click-to-fill-first-
//     empty-tile. onDragStart/End bubble up so empty tiles can show a drop hint.
//   • Collapsible: when closed the whole rail unmounts (Streaming owns the flag)
//     so the wall goes edge-to-edge.
//
// A hover snapshot thumbnail is intentionally left as a future touch (needs a
// snapshot endpoint per camera) — the row keeps a placeholder slot for it.
import { useMemo, useState } from "react";
import { Icon } from "@iconify/react";

import { StatusDot } from "./StatusBadge";

export default function CameraRail({
  cameras = [],
  mountedIds,
  onPick,
  onDragStateChange,
  isLoading,
  onlineCount = 0,
  liveCount = 0,
}) {
  const [q, setQ] = useState("");
  const [onlineOnly, setOnlineOnly] = useState(false);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return cameras.filter((c) => {
      if (onlineOnly && c.status !== "online") return false;
      if (!needle) return true;
      return (
        c.name?.toLowerCase().includes(needle) ||
        c.ip?.toLowerCase?.().includes(needle) ||
        c.brand?.toLowerCase?.().includes(needle) ||
        c.site_name?.toLowerCase?.().includes(needle)
      );
    });
  }, [cameras, q, onlineOnly]);

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-card-border bg-card/50">
      {/* Header + search */}
      <div className="border-b border-card-border p-3">
        <div className="mb-2 flex items-center justify-between">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">Cameras</p>
          <span className="rounded-full bg-hover px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-muted">
            {cameras.length}
          </span>
        </div>
        <label className="relative block">
          <Icon
            icon="heroicons-outline:magnifying-glass"
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-sm text-muted"
          />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search cameras…"
            className="h-9 w-full rounded-lg border border-field bg-transparent pl-8 pr-3 text-sm text-foreground placeholder:text-muted outline-none focus:border-muted"
          />
        </label>
        <div className="mt-2 flex items-center gap-2 text-[11px]">
          <button
            type="button"
            onClick={() => setOnlineOnly((v) => !v)}
            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-medium transition ${
              onlineOnly
                ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-500"
                : "border-card-border text-muted hover:bg-hover"
            }`}
          >
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            {onlineCount} online
          </button>
          <span className="inline-flex items-center gap-1 text-muted">
            <span className="h-1.5 w-1.5 rounded-full bg-blue-500" />
            {liveCount} on wall
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
          <div className="px-3 py-10 text-center text-xs text-muted">
            {onlineOnly ? "No online cameras." : "No cameras match."}
          </div>
        ) : (
          <ul className="space-y-0.5">
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
                      onDragStateChange?.(true);
                    }}
                    onDragEnd={() => onDragStateChange?.(false)}
                    onClick={() => onPick?.(c)}
                    title={c.status === "online" ? "Add to wall" : `${c.name} · ${c.status}`}
                    className={`group flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left transition ${
                      onWall ? "bg-blue-500/[0.07] hover:bg-blue-500/10" : "hover:bg-hover"
                    }`}
                  >
                    <Icon
                      icon="heroicons-outline:bars-2"
                      className="shrink-0 cursor-grab text-sm text-muted/40 group-hover:text-muted"
                    />
                    <StatusDot status={c.status} />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-xs font-medium text-foreground">{c.name}</span>
                      {c.site_name && (
                        <span className="truncate text-[10px] text-muted">{c.site_name}</span>
                      )}
                    </span>
                    {onWall ? (
                      <Icon
                        icon="heroicons-solid:tv"
                        className="shrink-0 text-sm text-blue-500"
                        title="On wall"
                      />
                    ) : (
                      <Icon
                        icon="heroicons-mini:plus"
                        className="shrink-0 text-sm text-transparent group-hover:text-muted"
                      />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="border-t border-card-border px-3 py-2 text-[10px] text-muted">
        Drag a camera onto a tile, or click to fill the next free tile.
      </div>
    </aside>
  );
}
