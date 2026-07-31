"use client";

// MapView — the wall's facility MAP surface. This is the REAL site map: it renders
// a site → floor's floor-plan image with the camera DEVICE PLACEMENTS pinned on it
// (authored in Configurations → Sites → Floors → floor-plan editor, the single
// source of truth). Pins show live online/offline status and click straight onto
// the wall. Cameras (local + federated recorder channels) are placed there as
// devices; here we consume those placements read-only.
//
// Nothing is invented — an unplaced/unconfigured estate shows a guide to the Sites
// editor. Coordinates are image-pixel world coords (same model as the editor
// canvas: screen = world*scale + offset with the plan letterboxed to fit).
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Icon } from "@iconify/react";

import { fileUrl } from "@/lib/api";
import { sites as sitesApi } from "@/lib/api/sites";
import { asItems } from "@/lib/format";

export default function MapView({ cameras = [], onPick }) {
  const [siteId, setSiteId] = useState(null);
  const [floorId, setFloorId] = useState(null);

  // Live status by device id (wall cameras carry the SAME id device placements key on).
  const statusById = useMemo(() => {
    const m = new Map();
    cameras.forEach((c) => m.set(c.id, c));
    return m;
  }, [cameras]);

  const sitesQ = useQuery({ queryKey: ["map-sites"], queryFn: () => sitesApi.list({ limit: 100 }) });
  const siteList = asItems(sitesQ.data);

  // Default to the first site once loaded.
  useEffect(() => {
    if (!siteId && siteList.length) setSiteId(siteList[0].site_id);
  }, [siteList, siteId]);

  const floorsQ = useQuery({
    queryKey: ["map-floors", siteId],
    queryFn: () => sitesApi.floors.list({ site_id: siteId, limit: 100 }),
    enabled: !!siteId,
  });
  const floorList = asItems(floorsQ.data);

  useEffect(() => {
    if (floorList.length && !floorList.some((f) => f.floor_id === floorId)) {
      setFloorId(floorList[0].floor_id);
    }
  }, [floorList, floorId]);

  const floor = floorList.find((f) => f.floor_id === floorId) || null;

  const placementsQ = useQuery({
    queryKey: ["map-placements", floorId],
    queryFn: () => sitesApi.devicePlacements.listByFloor(floorId),
    enabled: !!floorId,
  });
  // Only camera devices carry a live status + click-to-wall action here.
  const placements = useMemo(
    () =>
      asItems(placementsQ.data)
        .filter((p) => String(p.device_type || "").toLowerCase() === "camera")
        .map((p) => ({
          device_id: p.device_id,
          x: p.floor_position?.x ?? p.x ?? 0,
          y: p.floor_position?.y ?? p.y ?? 0,
        })),
    [placementsQ.data],
  );

  const online = cameras.filter((c) => c.status === "online").length;
  const floorplanUrl = floor?.floorplan_url ? fileUrl(floor.floorplan_url) : null;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-[11px] border border-[rgba(150,180,245,.22)] bg-[#0b1428]">
      {/* Breadcrumb + site/floor pickers */}
      <div className="flex flex-wrap items-center gap-2 border-b border-[rgba(150,180,245,.15)] px-3 py-2 font-mono text-[11px] tracking-[.6px] text-[#aec2e8]">
        <Icon icon="heroicons-solid:map-pin" className="text-sm text-[#22d3ee]" />
        <Picker
          value={siteId || ""}
          onChange={setSiteId}
          options={siteList.map((s) => ({ value: s.site_id, label: s.name }))}
          placeholder={sitesQ.isLoading ? "loading…" : "No sites"}
        />
        <span className="text-[#7e93bf]">›</span>
        <Picker
          value={floorId || ""}
          onChange={setFloorId}
          options={floorList.map((f) => ({ value: f.floor_id, label: f.name }))}
          placeholder={floorsQ.isLoading ? "loading…" : "No floors"}
        />
        <span className="ml-auto inline-flex items-center gap-1 rounded-full border border-[rgba(52,211,153,.4)] bg-[rgba(52,211,153,.1)] px-2 py-0.5 text-[10px] font-semibold text-[#34d399]">
          <span className="h-1.5 w-1.5 rounded-full bg-[#34d399]" />
          {online} online
        </span>
      </div>

      {/* Map body */}
      <div className="relative min-h-0 flex-1">
        {siteList.length === 0 && !sitesQ.isLoading ? (
          <Empty
            title="No sites configured"
            body="Create a site with floor plans in Configurations → Sites, then place cameras on a floor to see them here."
          />
        ) : !floor ? (
          <Empty title="No floors on this site" body="Add a floor with a floor-plan image in Configurations → Sites → Floors." />
        ) : !floorplanUrl ? (
          <Empty title="No floor plan uploaded" body={`Upload a floor-plan image for “${floor.name}” in Configurations → Sites → Floors.`} />
        ) : (
          <FloorPlan
            url={floorplanUrl}
            placements={placements}
            statusById={statusById}
            onPick={(deviceId) => {
              const cam = statusById.get(deviceId);
              if (cam) onPick?.(cam);
            }}
            emptyPlacements={!placementsQ.isLoading && placements.length === 0}
          />
        )}
      </div>

      {/* Legend */}
      <div className="flex items-center gap-3 border-t border-[rgba(150,180,245,.15)] px-3 py-1.5 font-mono text-[10px] text-[#7e93bf]">
        <span className="inline-flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-[#34d399]" /> Online</span>
        <span className="inline-flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-[#f87171]" /> Offline</span>
        <span className="ml-auto">{placements.length} placed · {cameras.length} cameras</span>
      </div>
    </div>
  );
}

// A compact mono dropdown for the breadcrumb.
function Picker({ value, onChange, options, placeholder }) {
  if (options.length === 0) {
    return <span className="text-[#7e93bf]">{placeholder}</span>;
  }
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="rounded-[6px] border border-[rgba(150,180,245,.22)] bg-[rgba(8,15,34,.6)] px-1.5 py-0.5 font-mono text-[11px] text-[#d7f7e9] outline-none focus:border-[rgba(34,211,238,.5)]"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value} className="bg-[#0b1428]">
          {o.label}
        </option>
      ))}
    </select>
  );
}

function Empty({ title, body }) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center">
      <Icon icon="heroicons-outline:map" className="text-4xl text-[rgba(103,232,249,.35)]" />
      <div className="mt-3 text-sm font-medium text-[#f2f6ff]">{title}</div>
      <p className="mt-1 max-w-md text-xs text-[#7e93bf]">{body}</p>
    </div>
  );
}

// Floor-plan image + camera pins. Positions are image-pixel world coords, mapped
// to screen with the plan letterboxed to fit (screen = world*scale + offset) — the
// same transform the editor canvas uses, so pins land exactly where they were
// placed.
function FloorPlan({ url, placements, statusById, onPick, emptyPlacements }) {
  const boxRef = useRef(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [nat, setNat] = useState({ w: 0, h: 0 });

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setBox({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const fit = useMemo(() => {
    if (!box.w || !box.h || !nat.w || !nat.h) return null;
    const s = Math.min(box.w / nat.w, box.h / nat.h);
    return { s, ox: (box.w - nat.w * s) / 2, oy: (box.h - nat.h * s) / 2 };
  }, [box, nat]);

  return (
    <div ref={boxRef} className="relative h-full w-full">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={url}
        alt="Floor plan"
        onLoad={(e) => setNat({ w: e.target.naturalWidth, h: e.target.naturalHeight })}
        className="absolute inset-0 h-full w-full object-contain opacity-90"
        draggable={false}
      />

      {fit &&
        placements.map((p) => {
          const cam = statusById.get(p.device_id);
          const on = cam?.status === "online";
          const known = !!cam;
          const left = fit.ox + p.x * fit.s;
          const top = fit.oy + p.y * fit.s;
          return (
            <button
              key={p.device_id}
              type="button"
              onClick={() => onPick?.(p.device_id)}
              disabled={!known}
              title={cam ? `${cam.name} · ${cam.status} — add to wall` : p.device_id}
              className="group absolute -translate-x-1/2 -translate-y-1/2"
              style={{ left, top }}
            >
              <span
                className={`block h-3.5 w-3.5 rounded-full border-2 border-white/80 shadow-[0_0_8px_rgba(0,0,0,.7)] ${
                  !known ? "bg-[#7e93bf]" : on ? "bg-[#34d399]" : "bg-[#f87171]"
                }`}
              />
              {cam && (
                <span className="mt-0.5 whitespace-nowrap rounded bg-black/60 px-1 font-mono text-[9px] text-[#d7f7e9] opacity-0 transition group-hover:opacity-100">
                  {cam.name}
                </span>
              )}
            </button>
          );
        })}

      {emptyPlacements && (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
          <span className="rounded-full border border-[rgba(150,180,245,.2)] bg-black/50 px-3 py-1 font-mono text-[10px] text-[#7e93bf]">
            No cameras placed on this floor — add them in Sites → Floors → floor-plan editor
          </span>
        </div>
      )}
    </div>
  );
}
