"use client";

// Video-wall left rail — the camera SOURCE list, redesigned for P2-D and then
// restructured into a TREE (2026-07-16) so large estates stay navigable:
//
//   Default (organisation root)
//     └─ Site A                     ← collapsible, camera count badge
//          • Camera 1               ← drag SOURCE + click-to-fill-next-tile
//          • Camera 2
//     └─ Site B
//          • Camera 3
//     └─ Unassigned                 ← cameras with no site
//          • Camera 4
//
// A flat 200-camera list is unusable; grouping by site (under a single "Default"
// root) lets an operator collapse the sites they don't care about. Search filters
// cameras and force-expands every branch so matches are always visible. Each leaf
// row keeps the P2-D behaviour: drag (dataTransfer "text/camera-id") + click to
// fill the first empty tile, status dot, and an "on wall" indicator.
import { useMemo, useState } from "react";
import { Icon } from "@iconify/react";

import { StatusDot } from "./StatusBadge";

const NO_SITE = "__no_site__";
const ROOT = "__root__";

export default function CameraRail({
  cameras = [],
  mountedIds,
  onPick,
  onDragStateChange,
  isLoading,
}) {
  const [q, setQ] = useState("");
  // Collapsed branches (Set of keys). Empty ⇒ everything expanded (friendliest
  // default for small estates; operators collapse what they don't need).
  const [collapsed, setCollapsed] = useState(() => new Set());

  const needle = q.trim().toLowerCase();
  const searching = needle.length > 0;

  const filtered = useMemo(() => {
    return cameras.filter((c) => {
      if (!needle) return true;
      return (
        c.name?.toLowerCase().includes(needle) ||
        c.ip?.toLowerCase?.().includes(needle) ||
        c.brand?.toLowerCase?.().includes(needle) ||
        c.site_name?.toLowerCase?.().includes(needle)
      );
    });
  }, [cameras, needle]);

  // Group filtered cameras by site → sorted site nodes ("Unassigned" last).
  const sites = useMemo(() => {
    const bySite = new Map();
    filtered.forEach((c) => {
      const key = c.site_id || NO_SITE;
      if (!bySite.has(key)) {
        bySite.set(key, {
          id: key,
          name: key === NO_SITE ? "Unassigned" : c.site_name || "Site",
          cameras: [],
        });
      }
      bySite.get(key).cameras.push(c);
    });
    return [...bySite.values()].sort((a, b) => {
      if (a.id === NO_SITE) return 1;
      if (b.id === NO_SITE) return -1;
      return a.name.localeCompare(b.name);
    });
  }, [filtered]);

  const toggle = (key) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  // While searching, ignore the collapsed set so every match is visible.
  const isOpen = (key) => searching || !collapsed.has(key);
  const rootOpen = isOpen(ROOT);

  const renderCameraRow = (c) => {
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
          className={`group flex w-full items-center gap-2 rounded-lg py-1.5 pl-7 pr-2 text-left transition ${
            onWall ? "bg-blue-500/[0.07] hover:bg-blue-500/10" : "hover:bg-hover"
          }`}
        >
          <Icon
            icon="heroicons-outline:bars-2"
            className="shrink-0 cursor-grab text-sm text-muted/40 group-hover:text-muted"
          />
          <StatusDot status={c.status} />
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
            {c.name}
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
  };

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-card-border bg-card/50">
      {/* Search (centered, label-free) */}
      <div className="border-b border-card-border p-3">
        <label className="relative block">
          <Icon
            icon="heroicons-outline:magnifying-glass"
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted"
          />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search cameras…"
            className="h-9 w-full rounded-lg border border-field bg-transparent px-8 text-center text-sm text-foreground placeholder:text-muted outline-none focus:border-muted"
          />
        </label>
      </div>

      {/* Camera tree — Default › Site › Camera */}
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {isLoading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-xs text-muted">
            <Icon icon="svg-spinners:180-ring" className="text-base" /> Loading…
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-3 py-10 text-center text-xs text-muted">
            No cameras match.
          </div>
        ) : (
          <div>
            {/* Default root */}
            <button
              type="button"
              onClick={() => toggle(ROOT)}
              className="flex w-full items-center gap-1.5 rounded-lg px-1.5 py-1.5 text-left transition hover:bg-hover"
            >
              <Icon
                icon="heroicons-mini:chevron-right"
                className={`shrink-0 text-sm text-muted transition-transform ${rootOpen ? "rotate-90" : ""}`}
              />
              <Icon icon="heroicons-outline:building-office-2" className="shrink-0 text-sm text-muted" />
              <span className="min-w-0 flex-1 truncate text-xs font-semibold text-foreground">
                Default
              </span>
              <span className="shrink-0 rounded-full bg-hover px-1.5 text-[10px] font-semibold tabular-nums text-muted">
                {filtered.length}
              </span>
            </button>

            {rootOpen && (
              <ul className="mt-0.5 space-y-0.5 border-l border-card-border/60 pl-1.5">
                {sites.map((site) => {
                  const open = isOpen(site.id);
                  return (
                    <li key={site.id}>
                      <button
                        type="button"
                        onClick={() => toggle(site.id)}
                        className="flex w-full items-center gap-1.5 rounded-lg px-1.5 py-1.5 text-left transition hover:bg-hover"
                      >
                        <Icon
                          icon="heroicons-mini:chevron-right"
                          className={`shrink-0 text-sm text-muted transition-transform ${open ? "rotate-90" : ""}`}
                        />
                        <Icon
                          icon={site.id === NO_SITE ? "heroicons-outline:inbox" : "heroicons-outline:map-pin"}
                          className="shrink-0 text-sm text-muted"
                        />
                        <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
                          {site.name}
                        </span>
                        <span className="shrink-0 rounded-full bg-hover px-1.5 text-[10px] font-semibold tabular-nums text-muted">
                          {site.cameras.length}
                        </span>
                      </button>
                      {open && (
                        <ul className="space-y-0.5 border-l border-card-border/60 pl-1.5">
                          {site.cameras.map(renderCameraRow)}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
      </div>

      <div className="border-t border-card-border px-3 py-2 text-[10px] text-muted">
        Drag a camera onto a tile, or click to fill the next free tile.
      </div>
    </aside>
  );
}
