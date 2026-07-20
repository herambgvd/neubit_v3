"use client";

// Device palette + placed-list sidebar for the floor-plan editor.
// Ported from neubit_v2's device-management-sidebar.jsx → neubit_v3's kit + semantic
// tokens (dark theme). Two tabs:
//   • Available — the placeable-device inventory (drag onto the canvas to place).
//   • On floor  — devices already placed (click to select, trash to remove).
//
// INVENTORY SOURCE: see useDeviceInventory — vms (cameras/NVRs) + access-control
// (controllers/doors). The editor shares that hook so canvas labels resolve the same
// names this list shows. The type filter keeps `panel` (fire) for when it lands.
import { useMemo, useState } from "react";
import { Icon } from "@iconify/react";

import { ConfirmDialog, Input } from "@/components/ui/kit";
import { useDeviceInventory } from "@/components/floor-builder/useDeviceInventory";

// Device-type → icon (heroicons via iconify).
function iconForType(type) {
  if (type === "nvr") return "heroicons-outline:server-stack";
  if (type === "access_control") return "heroicons-outline:shield-check";
  if (type === "door") return "heroicons-outline:rectangle-stack";
  if (type === "panel") return "heroicons-outline:fire";
  return "heroicons-outline:video-camera";
}

// Type filter options. Access + VMS (camera/NVR) resolve today; `panel` (fire) is
// kept so the filter matches v2 and is ready when fire lands.
const TYPE_OPTIONS = [
  { value: "all", label: "All" },
  { value: "camera", label: "Camera" },
  { value: "nvr", label: "NVR" },
  { value: "access_control", label: "Access controller" },
  { value: "door", label: "Door" },
];

function PaletteRow({ device, onDragStart }) {
  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(
          "application/x-neubit-device",
          JSON.stringify({
            device_id: device.device_id,
            device_type: device.device_type,
            service: device.service,
            name: device.name,
          }),
        );
        e.dataTransfer.effectAllowed = "copy";
        onDragStart?.(device);
      }}
      className="flex cursor-grab items-center gap-2 rounded-md border border-card-border bg-card px-2 py-1.5 text-sm transition hover:bg-hover active:cursor-grabbing"
    >
      <Icon icon={iconForType(device.device_type)} className="shrink-0 text-sm text-muted" />
      <span className="flex-1 truncate text-foreground">{device.name}</span>
    </div>
  );
}

function PlacedRow({ placement, inventory, isSelected, onSelect, onDelete }) {
  const name =
    inventory?.name || placement.name || placement.label || placement.device_id;
  return (
    <div className="flex items-center gap-2 rounded-md border border-card-border bg-card px-2 py-1.5 text-sm">
      <button
        type="button"
        onClick={onSelect}
        className={`flex min-w-0 flex-1 items-center gap-2 rounded-md border px-2 py-1 transition ${
          isSelected
            ? "border-blue-500/60 bg-blue-500/10"
            : "border-card-border hover:bg-hover"
        }`}
      >
        <Icon
          icon={iconForType(placement.device_type)}
          className="shrink-0 text-sm text-muted"
        />
        <span className="flex-1 truncate text-left text-foreground">{name}</span>
      </button>
      <button
        type="button"
        onClick={() => onDelete?.(placement, name)}
        title="Remove from floor"
        className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-red-500 transition hover:bg-red-500/10 hover:text-red-600"
      >
        <Icon icon="heroicons-outline:trash" className="text-sm" />
      </button>
    </div>
  );
}

export function DeviceManagementSidebar({
  placements = [],
  selectedDeviceId,
  onSelectDevice,
  onPaletteDragStart,
  onDeleteDevice,
}) {
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState("available"); // available | placed
  const [deviceTypeFilter, setDeviceTypeFilter] = useState("all");
  const [confirm, setConfirm] = useState(null);

  // ── Inventory sources (vms + access-control) ─────────────────────────
  const { inventory, inventoryById, loading } = useDeviceInventory();

  const placedIds = useMemo(() => {
    const set = new Set();
    for (const p of placements) if (p.device_id) set.add(p.device_id);
    return set;
  }, [placements]);

  const available = useMemo(() => {
    const q = search.trim().toLowerCase();
    return inventory.filter((d) => {
      if (placedIds.has(d.device_id)) return false;
      if (deviceTypeFilter !== "all" && d.device_type !== deviceTypeFilter) return false;
      if (!q) return true;
      return d.name?.toLowerCase().includes(q) || d.search_ip?.toLowerCase().includes(q);
    });
  }, [inventory, placedIds, search, deviceTypeFilter]);

  const placedFiltered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return placements.filter((p) => {
      const inv = inventoryById.get(p.device_id);
      const dtype = p.device_type || inv?.device_type;
      if (deviceTypeFilter !== "all" && dtype !== deviceTypeFilter) return false;
      if (!q) return true;
      return (
        inv?.name?.toLowerCase().includes(q) ||
        p.name?.toLowerCase().includes(q) ||
        p.label?.toLowerCase().includes(q) ||
        p.device_id?.toLowerCase().includes(q)
      );
    });
  }, [placements, inventoryById, deviceTypeFilter, search]);

  return (
    <aside className="flex w-72 shrink-0 flex-col rounded-lg border border-card-border bg-card">
      <div className="flex items-center justify-between border-b border-card-border px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted">
          <Icon icon="heroicons-outline:cpu-chip" className="text-base" />
          Devices
          <span className="ml-1 rounded-full bg-hover px-1.5 py-0.5 text-[11px] font-semibold text-foreground">
            {placements.length}
          </span>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-card-border">
        <button
          type="button"
          onClick={() => setTab("available")}
          className={`flex-1 border-b-2 px-3 py-2 text-xs font-medium transition ${
            tab === "available"
              ? "border-blue-500 text-blue-500"
              : "border-transparent text-muted hover:text-foreground"
          }`}
        >
          Available ({available.length})
        </button>
        <button
          type="button"
          onClick={() => setTab("placed")}
          className={`flex-1 border-b-2 px-3 py-2 text-xs font-medium transition ${
            tab === "placed"
              ? "border-blue-500 text-blue-500"
              : "border-transparent text-muted hover:text-foreground"
          }`}
        >
          On floor ({placements.length})
        </button>
      </div>

      {/* Search + type filter */}
      <div className="space-y-2 px-3 py-2">
        <div className="relative">
          <Icon
            icon="heroicons-outline:magnifying-glass"
            className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-sm text-muted"
          />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search…"
            className="!pl-7"
          />
        </div>
        <select
          value={deviceTypeFilter}
          onChange={(e) => setDeviceTypeFilter(e.target.value)}
          className="h-8 w-full rounded-md border border-card-border bg-card px-2 text-xs text-foreground"
        >
          {TYPE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      {/* Body */}
      <div className="flex-1 space-y-2 overflow-y-auto px-3 pb-3">
        {tab === "available" ? (
          loading ? (
            <div className="px-2 py-6 text-center text-xs text-muted">Loading…</div>
          ) : available.length === 0 ? (
            <div className="rounded-md border border-dashed border-card-border bg-hover/40 px-3 py-4 text-center text-xs text-muted">
              No matching devices available.
            </div>
          ) : (
            <>
              <div className="px-1 pb-1 text-[10px] uppercase tracking-wider text-muted">
                Drag onto canvas to place
              </div>
              {available.map((d) => (
                <PaletteRow key={d.device_id} device={d} onDragStart={onPaletteDragStart} />
              ))}
            </>
          )
        ) : placements.length === 0 ? (
          <div className="rounded-md border border-dashed border-card-border bg-hover/40 px-3 py-4 text-center text-xs text-muted">
            No devices placed yet — switch to <strong>Available</strong> and drag a device
            onto the canvas.
          </div>
        ) : (
          placedFiltered.map((p) => (
            <PlacedRow
              key={p.device_id}
              placement={p}
              inventory={inventoryById.get(p.device_id)}
              isSelected={p.device_id === selectedDeviceId}
              onSelect={() => onSelectDevice?.(p)}
              onDelete={(placement, name) =>
                setConfirm({
                  title: "Remove device?",
                  message: `Remove "${name}" from the floor?`,
                  confirmLabel: "Remove",
                  onConfirm: () => {
                    onDeleteDevice?.(placement);
                    setConfirm(null);
                  },
                })
              }
            />
          ))
        )}
      </div>

      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} />
    </aside>
  );
}

export default DeviceManagementSidebar;
