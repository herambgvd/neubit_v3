"use client";

// Dense camera table with selection, drag-reorder and per-row actions. Ported from
// gvd_nvr's Cameras table (sortable/reorderable/bulk) → v3 tokens + the shared kit.
// Columns: [drag] · [select] · name+ip · status dot · brand · health · site ·
// recording indicator · actions (snapshot/edit/delete).
import { useRef, useState } from "react";
import { Icon } from "@iconify/react";

import { titleize } from "@/lib/format";
import { STATUS_PRESETS, RECORDING_MODES } from "../constants";
import { StatusDot } from "./StatusBadge";

const HEALTH_TONE = {
  online: "text-emerald-500",
  offline: "text-muted",
  connecting: "text-amber-500",
  error: "text-red-500",
  unknown: "text-amber-500",
};

function HealthCell({ health }) {
  if (!health) return <span className="text-muted">—</span>;
  const tone = HEALTH_TONE[health.status] || "text-muted";
  const bitrate = health.bitrate_kbps != null ? `${health.bitrate_kbps} kbps` : null;
  const fps = health.fps_actual != null ? `${health.fps_actual} fps` : null;
  const metrics = [bitrate, fps].filter(Boolean).join(" · ");
  return (
    <span className={`inline-flex items-center gap-1 ${tone}`}>
      <Icon icon={STATUS_PRESETS[health.status]?.icon || STATUS_PRESETS.unknown.icon} className="text-xs" />
      <span className="text-xs">{metrics || titleize(health.status)}</span>
    </span>
  );
}

function RecordingCell({ camera }) {
  const mode = camera.recording?.mode;
  const preset = RECORDING_MODES.find((m) => m.value === mode);
  if (!preset) return <span className="text-muted">—</span>;
  const recording = camera.status === "online" && mode !== "manual";
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted" title={`Recording: ${preset.label}`}>
      {recording && <span className="h-1.5 w-1.5 rounded-full bg-red-500 animate-pulse" />}
      <Icon icon={preset.icon} className="text-sm" />
      {preset.label}
    </span>
  );
}

function RowMenu({ camera, onLive, onSnapshot, onEdit, onDevice, onDelete }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  return (
    <div className="relative inline-flex" ref={ref}>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
          const close = () => setOpen(false);
          if (!open) setTimeout(() => document.addEventListener("click", close, { once: true }), 0);
        }}
        className="rounded p-1 text-muted hover:bg-hover hover:text-foreground"
      >
        <Icon icon="heroicons-outline:ellipsis-vertical" className="text-sm" />
      </button>
      {open && (
        <div className="absolute right-0 top-7 z-20 w-36 overflow-hidden rounded-md border border-card-border bg-card shadow-lg">
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onLive?.(camera); }}
            className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-muted hover:bg-hover hover:text-foreground"
          >
            <Icon icon="heroicons-outline:play" className="text-xs" /> Go live
          </button>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onSnapshot?.(camera); }}
            className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-muted hover:bg-hover hover:text-foreground"
          >
            <Icon icon="heroicons-outline:camera" className="text-xs" /> Snapshot
          </button>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onEdit?.(camera); }}
            className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-muted hover:bg-hover hover:text-foreground"
          >
            <Icon icon="heroicons-outline:pencil-square" className="text-xs" /> Edit
          </button>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onDevice?.(camera); }}
            className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-muted hover:bg-hover hover:text-foreground"
          >
            <Icon icon="heroicons-outline:wrench-screwdriver" className="text-xs" /> Device
          </button>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onDelete?.(camera); }}
            className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-red-500 hover:bg-red-500/10"
          >
            <Icon icon="heroicons-outline:trash" className="text-xs" /> Delete
          </button>
        </div>
      )}
    </div>
  );
}

export default function CameraTable({
  cameras = [],
  healthById = {},
  siteNames = {},
  selectedIds,
  onToggleSelect,
  onToggleAll,
  onOpen,
  onLive,
  onSnapshot,
  onEdit,
  onDevice,
  onDelete,
  onReorder,
}) {
  const dragId = useRef(null);
  const [overId, setOverId] = useState(null);

  const allSelected = cameras.length > 0 && cameras.every((c) => selectedIds.has(c.id));

  const handleDrop = (targetId) => {
    const from = dragId.current;
    setOverId(null);
    dragId.current = null;
    if (!from || from === targetId) return;
    const ids = cameras.map((c) => c.id);
    const fromIdx = ids.indexOf(from);
    const toIdx = ids.indexOf(targetId);
    if (fromIdx < 0 || toIdx < 0) return;
    ids.splice(toIdx, 0, ids.splice(fromIdx, 1)[0]);
    onReorder?.(ids);
  };

  return (
    <div className="overflow-x-auto rounded-xl border border-card-border bg-card">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-card-border text-left text-[11px] uppercase tracking-wide text-muted">
            <th className="w-8 px-2 py-2.5" />
            <th className="w-8 px-2 py-2.5">
              <input type="checkbox" checked={allSelected} onChange={(e) => onToggleAll?.(e.target.checked)} className="accent-foreground" />
            </th>
            <th className="px-3 py-2.5 font-medium">Camera</th>
            <th className="px-3 py-2.5 font-medium">Brand</th>
            <th className="px-3 py-2.5 font-medium">Health</th>
            <th className="px-3 py-2.5 font-medium">Site</th>
            <th className="px-3 py-2.5 font-medium">Recording</th>
            <th className="w-10 px-2 py-2.5" />
          </tr>
        </thead>
        <tbody>
          {cameras.map((c) => (
            <tr
              key={c.id}
              onClick={() => onOpen?.(c)}
              onDragOver={(e) => { e.preventDefault(); setOverId(c.id); }}
              onDrop={() => handleDrop(c.id)}
              className={`cursor-pointer border-b border-card-border transition hover:bg-hover ${
                overId === c.id ? "bg-hover" : ""
              } ${selectedIds.has(c.id) ? "bg-hover/60" : ""}`}
            >
              <td
                className="px-2 py-2.5 text-muted"
                draggable
                onDragStart={() => { dragId.current = c.id; }}
                onDragEnd={() => { dragId.current = null; setOverId(null); }}
                onClick={(e) => e.stopPropagation()}
              >
                <Icon icon="heroicons-outline:bars-3" className="cursor-grab text-sm active:cursor-grabbing" />
              </td>
              <td className="px-2 py-2.5" onClick={(e) => e.stopPropagation()}>
                <input
                  type="checkbox"
                  checked={selectedIds.has(c.id)}
                  onChange={() => onToggleSelect?.(c.id)}
                  className="accent-foreground"
                />
              </td>
              <td className="px-3 py-2.5">
                <div className="flex items-center gap-2">
                  <StatusDot status={c.status} />
                  <div className="min-w-0">
                    <p className="truncate font-medium text-foreground">{c.name}</p>
                    <p className="truncate font-mono text-[11px] text-muted">
                      {c.network_info?.ip || c.onvif?.host || "—"}
                      {c.nvr_id ? " · NVR channel" : ""}
                      {!c.is_enabled ? " · disabled" : ""}
                    </p>
                  </div>
                </div>
              </td>
              <td className="px-3 py-2.5 text-muted">{titleize(c.brand)}</td>
              <td className="px-3 py-2.5"><HealthCell health={healthById[c.id]} /></td>
              <td className="px-3 py-2.5 text-muted">{siteNames[c.placement?.site_id] || "—"}</td>
              <td className="px-3 py-2.5"><RecordingCell camera={c} /></td>
              <td className="px-2 py-2.5" onClick={(e) => e.stopPropagation()}>
                <RowMenu camera={c} onLive={onLive} onSnapshot={onSnapshot} onEdit={onEdit} onDevice={onDevice} onDelete={onDelete} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
