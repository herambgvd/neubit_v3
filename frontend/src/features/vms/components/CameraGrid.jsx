"use client";

// Card/grid view of cameras. Each tile is a click-to-go-live thumbnail (opens
// the LivePlayer modal via onLive — P2-D), with status, name, brand and a hover
// action bar (live/snapshot/edit/delete). Selection via the corner checkbox.
import { Icon } from "@iconify/react";
import { useEffect, useState } from "react";

import { api } from "@/lib/api";
import { titleize } from "@/lib/format";
import { vms } from "../api";
import { RECORDING_MODES } from "../constants";
import StatusBadge, { StatusDot } from "./StatusBadge";

// Fetches the camera's snapshot as an authed blob → object URL (same pattern as
// SnapshotModal/MotionSearchModal — a plain <img src> wouldn't carry the bearer
// token). Only attempts online cameras; any failure/500 falls back to null so the
// tile shows the play-button placeholder. Revokes the object URL on unmount.
function useSnapshotThumb(camera) {
  const [url, setUrl] = useState(null);
  const online = camera.status === "online";
  useEffect(() => {
    if (!online) {
      setUrl(null);
      return undefined;
    }
    let objectUrl = null;
    let cancelled = false;
    api
      .get(vms.cameras.snapshotUrl(camera.id), { responseType: "blob" })
      .then((r) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(r.data);
        setUrl(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setUrl(null);
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [camera.id, online]);
  return url;
}

function Tile({ camera, health, siteName, selected, onToggleSelect, onLive, onSnapshot, onEdit, onDelete }) {
  const rec = RECORDING_MODES.find((m) => m.value === camera.recording?.mode);
  const thumb = useSnapshotThumb(camera);
  return (
    <div
      className={`group relative overflow-hidden rounded-xl border bg-card transition hover:border-muted ${
        selected ? "border-foreground" : "border-card-border"
      }`}
    >
      {/* Click-to-go-live thumbnail: the camera snapshot when available, with the
          play overlay on top (always visible when no snapshot, dimmed→bright on
          hover when a snapshot is showing). Falls back to the gradient placeholder. */}
      <button
        type="button"
        onClick={() => onLive?.(camera)}
        title="Go live"
        className="relative flex aspect-video w-full items-center justify-center overflow-hidden bg-gradient-to-br from-hover to-background"
      >
        {thumb && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={thumb} alt={`${camera.name} snapshot`} className="absolute inset-0 h-full w-full object-cover" />
        )}
        <div
          className={`relative z-10 flex flex-col items-center gap-1 transition ${
            thumb
              ? "text-white opacity-0 group-hover:opacity-100 [text-shadow:0_1px_3px_rgba(0,0,0,0.6)]"
              : "text-muted group-hover:text-foreground"
          }`}
        >
          <Icon icon="heroicons-solid:play" className="text-3xl opacity-80 transition group-hover:scale-110" />
          <span className="text-[10px] uppercase tracking-wide">Live</span>
        </div>
        <div className="absolute left-2 top-2">
          <StatusBadge status={camera.status} />
        </div>
        {camera.recording?.mode && camera.status === "online" && camera.recording.mode !== "manual" && (
          <span className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-full bg-black/50 px-1.5 py-0.5 text-[9px] font-medium text-white">
            <span className="h-1.5 w-1.5 rounded-full bg-red-500 animate-pulse" /> REC
          </span>
        )}
      </button>

      {/* Corner select */}
      <label className="absolute right-2 top-2 z-10 hidden group-hover:block" onClick={(e) => e.stopPropagation()}>
        <input type="checkbox" checked={selected} onChange={() => onToggleSelect?.(camera.id)} className="accent-foreground" />
      </label>

      <div className="flex items-start justify-between gap-2 px-3 py-2.5">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 truncate text-sm font-medium text-foreground">
            <StatusDot status={camera.status} /> {camera.name}
          </p>
          <p className="truncate text-[11px] text-muted">
            {titleize(camera.brand)} · {siteName || "Unassigned"}
            {rec ? ` · ${rec.label}` : ""}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition group-hover:opacity-100">
          <button type="button" title="Go live" onClick={() => onLive?.(camera)} className="rounded p-1 text-muted hover:bg-hover hover:text-foreground">
            <Icon icon="heroicons-outline:play" className="text-sm" />
          </button>
          <button type="button" title="Snapshot" onClick={() => onSnapshot?.(camera)} className="rounded p-1 text-muted hover:bg-hover hover:text-foreground">
            <Icon icon="heroicons-outline:camera" className="text-sm" />
          </button>
          <button type="button" title="Edit" onClick={() => onEdit?.(camera)} className="rounded p-1 text-muted hover:bg-hover hover:text-foreground">
            <Icon icon="heroicons-outline:pencil-square" className="text-sm" />
          </button>
          <button type="button" title="Delete" onClick={() => onDelete?.(camera)} className="rounded p-1 text-red-500 hover:bg-red-500/10">
            <Icon icon="heroicons-outline:trash" className="text-sm" />
          </button>
        </div>
      </div>
    </div>
  );
}

export default function CameraGrid({
  cameras = [],
  healthById = {},
  siteNames = {},
  selectedIds,
  onToggleSelect,
  onLive,
  onSnapshot,
  onEdit,
  onDelete,
}) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {cameras.map((c) => (
        <Tile
          key={c.id}
          camera={c}
          health={healthById[c.id]}
          siteName={siteNames[c.placement?.site_id]}
          selected={selectedIds.has(c.id)}
          onToggleSelect={onToggleSelect}
          onLive={onLive}
          onSnapshot={onSnapshot}
          onEdit={onEdit}
          onDelete={onDelete}
        />
      ))}
    </div>
  );
}
