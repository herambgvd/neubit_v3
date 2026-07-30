"use client";

// MapView — the wall's facility MAP surface (mockup: GIS street map ↔ floor plan
// with camera pins, hover thumbnails, click-to-dock). This is a SCAFFOLD: real
// pins need per-camera coordinates (site geometry / floor-plan placement) which
// aren't captured yet. Rather than fake positions, it renders the map frame
// (breadcrumb + legend) with an honest empty state, and lists the cameras as
// chips you can click straight onto the wall — so the surface is useful today and
// upgrades to real pins the moment coordinates exist.
import { useMemo } from "react";
import { Icon } from "@iconify/react";

export default function MapView({ cameras = [], onPick }) {
  // A camera is "placed" only if it carries real map coordinates. None do yet —
  // so `placed` stays empty and we never invent a location.
  const placed = useMemo(
    () => cameras.filter((c) => c.map_x != null && c.map_y != null),
    [cameras],
  );
  const online = cameras.filter((c) => c.status === "online").length;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-[11px] border border-[rgba(150,180,245,.22)] bg-[#0b1428]">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 border-b border-[rgba(150,180,245,.15)] px-3 py-2 font-mono text-[11px] tracking-[.6px] text-[#aec2e8]">
        <Icon icon="heroicons-solid:map-pin" className="text-sm text-[#22d3ee]" />
        <span className="text-[#67e8f9]">GIS</span>
        <span className="text-[#7e93bf]">›</span>
        <span>FACILITY MAP</span>
        <span className="ml-auto inline-flex items-center gap-1 rounded-full border border-[rgba(52,211,153,.4)] bg-[rgba(52,211,153,.1)] px-2 py-0.5 text-[10px] font-semibold text-[#34d399]">
          <span className="h-1.5 w-1.5 rounded-full bg-[#34d399]" />
          {online} online
        </span>
      </div>

      {/* Map body */}
      <div
        className="relative min-h-0 flex-1"
        style={{
          background:
            "linear-gradient(135deg,#0f1c36,#122140 60%,#0b1428), repeating-linear-gradient(0deg,rgba(150,180,245,.05) 0 1px,transparent 1px 40px), repeating-linear-gradient(90deg,rgba(150,180,245,.05) 0 1px,transparent 1px 40px)",
        }}
      >
        {placed.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center px-6 text-center">
            <Icon icon="heroicons-outline:map" className="text-4xl text-[rgba(103,232,249,.35)]" />
            <div className="mt-3 text-sm font-medium text-[#f2f6ff]">Camera positions not set</div>
            <p className="mt-1 max-w-md text-xs text-[#7e93bf]">
              Place cameras on a floor plan or GIS map (Configurations → Sites) to see live
              pins, alarm balloons and click-to-dock here. Until then, add cameras to the wall
              from the list below.
            </p>
            {cameras.length > 0 && (
              <div className="mt-4 flex max-w-2xl flex-wrap justify-center gap-1.5">
                {cameras.slice(0, 24).map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => onPick?.(c)}
                    title={`Add ${c.name} to wall`}
                    className="inline-flex items-center gap-1.5 rounded-[9px] border border-[rgba(150,180,245,.22)] bg-[rgba(8,15,34,.6)] px-2 py-1 text-[11px] text-[#aec2e8] transition hover:border-[rgba(34,211,238,.5)] hover:text-[#67e8f9]"
                  >
                    <span
                      className={`h-1.5 w-1.5 rounded-full ${c.status === "online" ? "bg-[#34d399]" : "bg-[#f87171]"}`}
                    />
                    {c.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          // Real pins (activates once coordinates exist).
          placed.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => onPick?.(c)}
              title={c.name}
              className="absolute -translate-x-1/2 -translate-y-1/2"
              style={{ left: `${c.map_x * 100}%`, top: `${c.map_y * 100}%` }}
            >
              <span
                className={`block h-3 w-3 rounded-full border-2 border-white/70 ${c.status === "online" ? "bg-[#34d399]" : "bg-[#f87171]"}`}
              />
            </button>
          ))
        )}
      </div>

      {/* Legend */}
      <div className="flex items-center gap-3 border-t border-[rgba(150,180,245,.15)] px-3 py-1.5 font-mono text-[10px] text-[#7e93bf]">
        <span className="inline-flex items-center gap-1">
          <span className="h-1.5 w-1.5 rounded-full bg-[#34d399]" /> Online
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="h-1.5 w-1.5 rounded-full bg-[#f87171]" /> Offline
        </span>
        <span className="ml-auto">{cameras.length} cameras</span>
      </div>
    </div>
  );
}
