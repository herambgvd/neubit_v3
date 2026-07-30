"use client";

// MapView — the wall's facility MAP surface (mockup: camera pins over a site map).
// Cameras are PLACED by the operator: drag a camera from the tray onto the map and
// its normalized (0..1) position is saved to this browser (localStorage). Placed
// pins show live status (online/offline) and click-to-wall. Nothing is invented —
// an unplaced estate shows the tray only; positions are exactly what the user set.
//
// (A server-side placement — per-camera map_x/map_y or the site floor-plan image —
// can back this later; the pin model already reads/writes normalized coordinates,
// so swapping the store is a drop-in.)
import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "@iconify/react";

const LS_PINS = "neubit.vms.map.pins";

function readPins() {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(localStorage.getItem(LS_PINS) || "{}") || {};
  } catch {
    return {};
  }
}
function writePins(p) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(LS_PINS, JSON.stringify(p));
  } catch {
    /* quota — silent */
  }
}

export default function MapView({ cameras = [], onPick }) {
  const [pins, setPins] = useState({}); // { [cameraId]: {x,y} } normalized 0..1
  const [dropActive, setDropActive] = useState(false);

  useEffect(() => setPins(readPins()), []);
  const persist = useCallback((next) => {
    setPins(next);
    writePins(next);
  }, []);

  const camById = useMemo(() => {
    const m = new Map();
    cameras.forEach((c) => m.set(c.id, c));
    return m;
  }, [cameras]);

  // Only pins whose camera still exists.
  const placed = useMemo(
    () => Object.entries(pins).filter(([id]) => camById.has(id)),
    [pins, camById],
  );
  const placedIds = useMemo(() => new Set(placed.map(([id]) => id)), [placed]);
  const unplaced = cameras.filter((c) => !placedIds.has(c.id));
  const online = cameras.filter((c) => c.status === "online").length;

  const dropAt = (e) => {
    e.preventDefault();
    setDropActive(false);
    const id = e.dataTransfer.getData("text/camera-id");
    if (!id) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const y = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
    persist({ ...pins, [id]: { x, y } });
  };

  const unpin = (id) => {
    const next = { ...pins };
    delete next[id];
    persist(next);
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-[11px] border border-[rgba(150,180,245,.22)] bg-[#0b1428]">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 border-b border-[rgba(150,180,245,.15)] px-3 py-2 font-mono text-[11px] tracking-[.6px] text-[#aec2e8]">
        <Icon icon="heroicons-solid:map-pin" className="text-sm text-[#22d3ee]" />
        <span className="text-[#67e8f9]">SITE</span>
        <span className="text-[#7e93bf]">›</span>
        <span>FACILITY MAP</span>
        <span className="ml-auto inline-flex items-center gap-1 rounded-full border border-[rgba(52,211,153,.4)] bg-[rgba(52,211,153,.1)] px-2 py-0.5 text-[10px] font-semibold text-[#34d399]">
          <span className="h-1.5 w-1.5 rounded-full bg-[#34d399]" />
          {online} online
        </span>
      </div>

      {/* Map body — drop target */}
      <div
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("text/camera-id")) {
            e.preventDefault();
            if (!dropActive) setDropActive(true);
          }
        }}
        onDragLeave={() => setDropActive(false)}
        onDrop={dropAt}
        className={`relative min-h-0 flex-1 ${dropActive ? "outline outline-2 -outline-offset-2 outline-[#22d3ee]" : ""}`}
        style={{
          background:
            "linear-gradient(135deg,#0f1c36,#122140 60%,#0b1428), repeating-linear-gradient(0deg,rgba(150,180,245,.05) 0 1px,transparent 1px 40px), repeating-linear-gradient(90deg,rgba(150,180,245,.05) 0 1px,transparent 1px 40px)",
        }}
      >
        {placed.length === 0 && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center px-6 text-center">
            <Icon icon="heroicons-outline:map" className="text-4xl text-[rgba(103,232,249,.35)]" />
            <div className="mt-3 text-sm font-medium text-[#f2f6ff]">Place cameras on the map</div>
            <p className="mt-1 max-w-md text-xs text-[#7e93bf]">
              Drag a camera from the tray below onto the map. Positions are saved to this
              browser; pins show live status and click straight onto the wall.
            </p>
          </div>
        )}

        {/* Placed pins */}
        {placed.map(([id, pos]) => {
          const cam = camById.get(id);
          const on = cam.status === "online";
          return (
            <div
              key={id}
              className="group absolute -translate-x-1/2 -translate-y-1/2"
              style={{ left: `${pos.x * 100}%`, top: `${pos.y * 100}%` }}
            >
              <button
                type="button"
                onClick={() => onPick?.(cam)}
                title={`${cam.name} · ${cam.status} — add to wall`}
                className="flex flex-col items-center"
              >
                <span
                  className={`block h-3.5 w-3.5 rounded-full border-2 border-white/80 shadow-[0_0_8px_rgba(0,0,0,.6)] ${on ? "bg-[#34d399]" : "bg-[#f87171]"}`}
                />
                <span className="mt-0.5 rounded bg-black/55 px-1 font-mono text-[9px] text-[#d7f7e9] opacity-0 transition group-hover:opacity-100">
                  {cam.name}
                </span>
              </button>
              <button
                type="button"
                onClick={() => unpin(id)}
                title="Remove pin"
                className="absolute -right-3 -top-3 hidden h-4 w-4 items-center justify-center rounded-full bg-black/70 text-[#f87171] group-hover:flex"
              >
                <Icon icon="heroicons-mini:x-mark" className="text-[10px]" />
              </button>
            </div>
          );
        })}
      </div>

      {/* Camera tray — draggable sources (unplaced) */}
      {unplaced.length > 0 && (
        <div className="border-t border-[rgba(150,180,245,.15)] px-3 py-2">
          <div className="mb-1 font-mono text-[9px] uppercase tracking-[1.4px] text-[#7e93bf]">
            Drag to place ({unplaced.length})
          </div>
          <div className="flex max-h-16 flex-wrap gap-1.5 overflow-y-auto">
            {unplaced.map((c) => (
              <button
                key={c.id}
                type="button"
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData("text/camera-id", c.id);
                  e.dataTransfer.effectAllowed = "copy";
                }}
                onClick={() => onPick?.(c)}
                title={`${c.name} — drag onto map, or click to add to wall`}
                className="inline-flex cursor-grab items-center gap-1.5 rounded-[9px] border border-[rgba(150,180,245,.22)] bg-[rgba(8,15,34,.6)] px-2 py-1 text-[11px] text-[#aec2e8] transition hover:border-[rgba(34,211,238,.5)] hover:text-[#67e8f9]"
              >
                <span className={`h-1.5 w-1.5 rounded-full ${c.status === "online" ? "bg-[#34d399]" : "bg-[#f87171]"}`} />
                {c.name}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
