"use client";

// Dense camera table — now on the shared TanStack DataTable (@tanstack/react-table
// v8). Columns: [select] · name+ip · status badge · brand · IP · site · health ·
// recording · actions-menu (go-live/snapshot/edit/device/delete). Sorting on
// name/status/brand/ip. Ported from gvd_nvr's Cameras table → v3 tokens + kit.
//
// Selection: the page owns a Set<id> (`selectedIds`) wired to BulkActionBar. We
// bridge that to TanStack's controlled rowSelection map here — the DataTable
// stays generic while the page keeps its Set-based state + bulk handlers.
import { useMemo, useRef, useState } from "react";
import { Icon } from "@iconify/react";

import { DataTable } from "@/components/common";
import { titleize } from "@/lib/format";
import { STATUS_PRESETS, RECORDING_MODES } from "../constants";
import StatusBadge, { StatusDot } from "./StatusBadge";

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

const cameraIp = (c) => c.network_info?.ip || c.onvif?.host || "";

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
}) {
  // Bridge the page's Set<id> ↔ TanStack's rowSelection map.
  const rowSelection = useMemo(() => {
    const m = {};
    for (const id of selectedIds) m[id] = true;
    return m;
  }, [selectedIds]);

  // TanStack calls this with either a new map or an updater. We diff against the
  // current Set and translate into the page's toggle helpers (which own state).
  const onRowSelectionChange = (updater) => {
    const next = typeof updater === "function" ? updater(rowSelection) : updater;
    const nextKeys = Object.keys(next).filter((k) => next[k]);
    const nextSet = new Set(nextKeys);
    // Select-all / clear-all shortcuts.
    if (nextSet.size === 0 && selectedIds.size > 0) { onToggleAll?.(false); return; }
    if (nextSet.size === cameras.length && cameras.every((c) => nextSet.has(c.id))) {
      onToggleAll?.(true);
      return;
    }
    // Otherwise flip the single id that changed.
    for (const c of cameras) {
      const was = selectedIds.has(c.id);
      const now = nextSet.has(c.id);
      if (was !== now) onToggleSelect?.(c.id);
    }
  };

  const columns = useMemo(
    () => [
      {
        id: "select",
        enableSorting: false,
        meta: { width: "2rem", headClassName: "px-2 py-2.5", cellClassName: "px-2 py-2.5" },
        header: ({ table }) => (
          <input
            type="checkbox"
            checked={table.getIsAllRowsSelected()}
            ref={(el) => { if (el) el.indeterminate = table.getIsSomeRowsSelected() && !table.getIsAllRowsSelected(); }}
            onChange={table.getToggleAllRowsSelectedHandler()}
            onClick={(e) => e.stopPropagation()}
            className="accent-foreground"
          />
        ),
        cell: ({ row }) => (
          <input
            type="checkbox"
            checked={row.getIsSelected()}
            onChange={row.getToggleSelectedHandler()}
            onClick={(e) => e.stopPropagation()}
            className="accent-foreground"
          />
        ),
      },
      {
        id: "name",
        header: "Camera",
        accessorFn: (c) => c.name || "",
        meta: { cellClassName: "px-4 py-2.5" },
        cell: ({ row }) => {
          const c = row.original;
          return (
            <div className="flex items-center gap-2">
              <StatusDot status={c.status} />
              <div className="min-w-0">
                <p className="flex items-center gap-1.5 truncate font-medium text-foreground">
                  <span className="truncate">{c.name}</span>
                </p>
                <p className="truncate font-mono text-[11px] text-muted">
                  {cameraIp(c) || "—"}
                  {c.nvr_id ? " · NVR channel" : ""}
                  {!c.is_enabled ? " · disabled" : ""}
                </p>
              </div>
            </div>
          );
        },
      },
      {
        id: "status",
        header: "Status",
        accessorFn: (c) => c.status || "",
        meta: { cellClassName: "px-4 py-2.5" },
        cell: ({ row }) => <StatusBadge status={row.original.status} />,
      },
      {
        id: "brand",
        header: "Brand",
        accessorFn: (c) => titleize(c.brand) || "",
        meta: { cellClassName: "px-4 py-2.5 text-muted" },
        cell: ({ getValue }) => getValue() || "—",
      },
      {
        id: "ip",
        header: "IP",
        accessorFn: (c) => cameraIp(c),
        meta: { cellClassName: "px-4 py-2.5" },
        cell: ({ getValue }) => (
          <span className="font-mono text-[11px] text-muted">{getValue() || "—"}</span>
        ),
      },
      {
        id: "site",
        header: "Site",
        enableSorting: false,
        meta: { cellClassName: "px-4 py-2.5 text-muted" },
        cell: ({ row }) => siteNames[row.original.placement?.site_id] || "—",
      },
      {
        id: "health",
        header: "Health",
        enableSorting: false,
        meta: { cellClassName: "px-4 py-2.5" },
        cell: ({ row }) => <HealthCell health={healthById[row.original.id]} />,
      },
      {
        id: "recording",
        header: "Recording",
        enableSorting: false,
        meta: { cellClassName: "px-4 py-2.5" },
        cell: ({ row }) => <RecordingCell camera={row.original} />,
      },
      {
        id: "actions",
        header: "",
        enableSorting: false,
        meta: { width: "2.5rem", headClassName: "px-2 py-2.5", cellClassName: "px-2 py-2.5" },
        cell: ({ row }) => (
          <div onClick={(e) => e.stopPropagation()}>
            <RowMenu
              camera={row.original}
              onLive={onLive}
              onSnapshot={onSnapshot}
              onEdit={onEdit}
              onDevice={onDevice}
              onDelete={onDelete}
            />
          </div>
        ),
      },
    ],
    [healthById, siteNames, onLive, onSnapshot, onEdit, onDevice, onDelete]
  );

  return (
    <DataTable
      columns={columns}
      data={cameras}
      getRowId={(c) => c.id}
      onRowClick={(c) => onOpen?.(c)}
      enableRowSelection
      rowSelection={rowSelection}
      onRowSelectionChange={onRowSelectionChange}
      initialSorting={[{ id: "name", desc: false }]}
    />
  );
}
