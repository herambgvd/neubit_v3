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

  // Group filtered cameras into branches: RECORDER nodes (federated cameras owned
  // by an NVR) first, then local SITES, "Unassigned" last. Recorder branches carry
  // kind:"recorder" so they render with a server glyph — the tree reads
  //   Default › recorder-dev-01 › Channel 1 / Channel 2 …
  const sites = useMemo(() => {
    const byGroup = new Map();
    filtered.forEach((c) => {
      const recorder = !!c.federated;
      const key = recorder ? c.site_id : c.site_id || NO_SITE;
      if (!byGroup.has(key)) {
        byGroup.set(key, {
          id: key,
          kind: recorder ? "recorder" : "site",
          name: key === NO_SITE ? "Unassigned" : c.site_name || (recorder ? "Recorder" : "Site"),
          cameras: [],
        });
      }
      byGroup.get(key).cameras.push(c);
    });
    return [...byGroup.values()].sort((a, b) => {
      if (a.id === NO_SITE) return 1;
      if (b.id === NO_SITE) return -1;
      // Recorders before local sites.
      if (a.kind !== b.kind) return a.kind === "recorder" ? -1 : 1;
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
          className={`group flex w-full items-center gap-2 rounded-[7px] py-1.5 pl-7 pr-2 text-left transition ${
            onWall ? "bg-[rgba(34,211,238,.08)] hover:bg-[rgba(34,211,238,.12)]" : "hover:bg-[rgba(150,180,245,.07)]"
          }`}
        >
          <Icon
            icon="heroicons-outline:bars-2"
            className="shrink-0 cursor-grab text-sm text-[#7e93bf]/50 group-hover:text-[#aec2e8]"
          />
          <StatusDot status={c.status} />
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-[#cfd0f2] group-hover:text-[#f2f6ff]">
            {c.name}
          </span>
          {onWall ? (
            <Icon
              icon="heroicons-solid:tv"
              className="shrink-0 text-sm text-[#22d3ee]"
              title="On wall"
            />
          ) : (
            <Icon
              icon="heroicons-mini:plus"
              className="shrink-0 text-sm text-transparent group-hover:text-[#7e93bf]"
            />
          )}
        </button>
      </li>
    );
  };

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-[rgba(150,180,245,.22)] bg-[rgba(8,15,34,.55)] backdrop-blur-sm">
      {/* Search (centered, label-free) */}
      <div className="border-b border-[rgba(150,180,245,.22)] p-3">
        <label className="relative block">
          <Icon
            icon="heroicons-outline:magnifying-glass"
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-[#7e93bf]"
          />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search cameras…"
            className="h-9 w-full rounded-[8px] border border-[rgba(150,180,245,.22)] bg-[rgba(150,180,245,.04)] px-8 text-center text-sm text-[#f2f6ff] placeholder:text-[#7e93bf] outline-none focus:border-[rgba(34,211,238,.5)]"
          />
        </label>
      </div>

      {/* Camera tree — Default › Site › Camera */}
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {isLoading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-xs text-[#aec2e8]">
            <Icon icon="svg-spinners:180-ring" className="text-base" /> Loading…
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-3 py-10 text-center text-xs text-[#7e93bf]">
            No cameras match.
          </div>
        ) : (
          <div>
            {/* Default root */}
            <button
              type="button"
              onClick={() => toggle(ROOT)}
              className="flex w-full items-center gap-1.5 rounded-[7px] px-1.5 py-1.5 text-left transition hover:bg-[rgba(150,180,245,.07)]"
            >
              <Icon
                icon="heroicons-mini:chevron-right"
                className={`shrink-0 text-sm text-[#7e93bf] transition-transform ${rootOpen ? "rotate-90" : ""}`}
              />
              <Icon icon="heroicons-outline:building-office-2" className="shrink-0 text-sm text-[#aec2e8]" />
              <span className="min-w-0 flex-1 truncate text-xs font-semibold text-[#f2f6ff]">
                Default
              </span>
              <span className="shrink-0 rounded-full bg-[rgba(150,180,245,.1)] px-1.5 font-mono text-[10px] font-semibold tabular-nums text-[#aec2e8]">
                {filtered.length}
              </span>
            </button>

            {rootOpen && (
              <ul className="mt-0.5 space-y-0.5 border-l border-[rgba(150,180,245,.15)] pl-1.5">
                {sites.map((site) => {
                  const open = isOpen(site.id);
                  return (
                    <li key={site.id}>
                      <button
                        type="button"
                        onClick={() => toggle(site.id)}
                        className="flex w-full items-center gap-1.5 rounded-[7px] px-1.5 py-1.5 text-left transition hover:bg-[rgba(150,180,245,.07)]"
                      >
                        <Icon
                          icon="heroicons-mini:chevron-right"
                          className={`shrink-0 text-sm text-[#7e93bf] transition-transform ${open ? "rotate-90" : ""}`}
                        />
                        <Icon
                          icon={
                            site.kind === "recorder"
                              ? "heroicons-outline:server-stack"
                              : site.id === NO_SITE
                                ? "heroicons-outline:inbox"
                                : "heroicons-outline:map-pin"
                          }
                          className={`shrink-0 text-sm ${site.kind === "recorder" ? "text-nb-blueb" : "text-[#aec2e8]"}`}
                        />
                        <span className="min-w-0 flex-1 truncate text-xs font-medium text-[#cfd0f2]">
                          {site.name}
                        </span>
                        <span className="shrink-0 rounded-full bg-[rgba(150,180,245,.1)] px-1.5 font-mono text-[10px] font-semibold tabular-nums text-[#aec2e8]">
                          {site.cameras.length}
                        </span>
                      </button>
                      {open && (
                        <ul className="space-y-0.5 border-l border-[rgba(150,180,245,.15)] pl-1.5">
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

      <div className="border-t border-[rgba(150,180,245,.22)] px-3 py-2 font-mono text-[10px] uppercase tracking-[1px] text-[#7e93bf]">
        Drag a camera onto a tile, or click to fill the next free tile.
      </div>
    </aside>
  );
}
