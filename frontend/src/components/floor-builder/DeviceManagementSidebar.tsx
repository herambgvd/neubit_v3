"use client";

// Device palette + placed-list sidebar for the floor-plan editor.
// Ported from neubit_v2's device-management-sidebar.jsx → neubit_v3's kit + semantic
// tokens (dark theme). Two tabs:
//   • Available — the placeable-device inventory (drag onto the canvas to place).
//   • On floor  — devices already placed (click to select, trash to remove).
//
// ONE LOCATION PER DEVICE (SCRUM-309). A camera hangs in one place, so a device
// already placed on another floor or site is NOT available here: it is listed
// under "Placed elsewhere" with where it is, and dropping one asks before moving
// it (the editor's confirm, then `register` with `move: true`). Industry does the
// same — Milestone's smart map keeps one position per device.
//
// INVENTORY SOURCE: see useDeviceInventory — vms (cameras/NVRs), access-control
// (controllers/doors) and iot (the reading store's reporting devices). The editor
// shares that hook so canvas labels resolve the same names this list shows. The
// type filter keeps `panel` (fire) for when it lands.
import { useMemo, useState } from "react";
import { Icon } from "@iconify/react";
import { useQuery } from "@tanstack/react-query";

import { ConfirmDialog, Input, type ConfirmState } from "@/components/ui/kit";
import { useDeviceInventory } from "@/components/floor-builder/useDeviceInventory";
import type { EditorPlacement, PlaceableDevice } from "@/components/floor-builder/types";
import { sites as sitesApi } from "@/lib/api/sites";
import type { DevicePlacementIndexRow } from "@/lib/types";

/** The estate-wide placement index's query key — shared with the map and the
 *  camera-site hooks, and invalidated by the editor after a save. */
export const PLACEMENT_INDEX_KEY = ["device-placements-index"] as const;

/** "Tower A › Level 4", or the site alone for a device on no floor. */
export function placementWhere(row: DevicePlacementIndexRow): string {
  const site = row.site_name || row.site_id;
  const floor = row.floor_id ? row.floor_name || row.floor_id : null;
  return floor ? `${site} › ${floor}` : site;
}

/** Is this placement somewhere a drop on (siteId, floorId) would take it AWAY
 *  from? Mirrors the backend's `_is_move`: another site, or another floor of this
 *  one. A site-only device of THIS site is not — placing it refines the fact. */
export function isElsewhere(row: DevicePlacementIndexRow, siteId: string, floorId: string): boolean {
  if (row.site_id !== siteId) return true;
  return row.floor_id != null && row.floor_id !== floorId;
}

// Device-type → icon (heroicons via iconify).
//
// An IoT device is `sensor` in the placement enum, which says nothing about what
// it IS. So a sensor's icon comes from its BI CATEGORY instead — the same icons
// features/bi/constants.ts uses — and an unclassified one gets a question mark
// rather than borrowing an icon from a category nobody put it in.
const IOT_CATEGORY_ICON: Record<string, string> = {
  energy: "heroicons-outline:bolt",
  hvac: "heroicons-outline:cog-8-tooth",
  water: "heroicons-outline:beaker",
  fire: "heroicons-outline:fire",
};

/** The classification a sensor icon is chosen from — on the palette entry, or
 *  persisted in a placement's metadata. */
interface IotClassified {
  iot_category?: string | null;
  metadata?: Record<string, unknown> | null;
}

function iconForType(type: string | undefined, device?: IotClassified): string {
  if (type === "sensor") {
    // `metadata` is the gateway's free-form dict, so the value under
    // `iot_category` is only a string if it happens to be one. `String()` on
    // anything else gives "[object Object]", which matches no category and
    // quietly turns a classified sensor into a question mark.
    const persisted = device?.metadata?.iot_category;
    const cat = (device?.iot_category ?? (typeof persisted === "string" ? persisted : "")).toLowerCase();
    return IOT_CATEGORY_ICON[cat] || "heroicons-outline:question-mark-circle";
  }
  if (type === "nvr") return "heroicons-outline:server-stack";
  if (type === "access_control") return "heroicons-outline:shield-check";
  if (type === "door") return "heroicons-outline:rectangle-stack";
  if (type === "panel") return "heroicons-outline:fire";
  return "heroicons-outline:video-camera";
}

// Type filter options. Access, VMS (camera/NVR) and IoT (`sensor`) resolve today;
// `panel` (fire) is kept so the filter matches v2 and is ready when fire lands.
const TYPE_OPTIONS = [
  { value: "all", label: "All" },
  { value: "camera", label: "Camera" },
  { value: "nvr", label: "NVR" },
  { value: "access_control", label: "Access controller" },
  { value: "door", label: "Door" },
  { value: "sensor", label: "IoT device" },
];

// Transparent 1×1 drag image. The browser's default is a snapshot of this full-width
// row, which reads as a floating card over the floor plan; suppressing it lets the
// canvas draw the real device glyph at the cursor instead. Module-level so it's
// decoded long before any drag begins.
const EMPTY_DRAG_IMAGE =
  typeof Image !== "undefined"
    ? Object.assign(new Image(), {
        src: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
      })
    : null;

interface PaletteRowProps {
  device: PlaceableDevice;
  /** Where it is placed now, for a device on another floor or site. */
  elsewhere?: string | null;
  isDragging: boolean;
  onDragStart?: (device: PlaceableDevice) => void;
  onDragEnd?: () => void;
}

function PaletteRow({ device, elsewhere = null, isDragging, onDragStart, onDragEnd }: Readonly<PaletteRowProps>) {
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
            // Carried onto the placement row so the plan can draw the right
            // glyph for a device that later stops reporting and drops out of
            // this inventory. Never a floor and never a name — just what the
            // device is.
            metadata: device.metadata ?? null,
            elsewhere,
          }),
        );
        e.dataTransfer.effectAllowed = "copy";
        if (EMPTY_DRAG_IMAGE) e.dataTransfer.setDragImage(EMPTY_DRAG_IMAGE, 0, 0);
        onDragStart?.(device);
      }}
      onDragEnd={() => onDragEnd?.()}
      className={`flex cursor-grab items-center gap-2 rounded-md border border-card-border bg-card px-2 py-1.5 text-sm transition hover:bg-hover active:cursor-grabbing ${
        isDragging ? "opacity-40 ring-1 ring-blue-500/50" : ""
      }`}
    >
      <Icon
        icon={iconForType(device.device_type, device)}
        className="shrink-0 text-sm text-muted"
      />
      {elsewhere ? (
        <span className="min-w-0 flex-1">
          <span className="block truncate text-foreground">{device.name}</span>
          <span className="block truncate text-[10px] text-amber-500" title={`Placed at ${elsewhere}`}>
            {elsewhere}
          </span>
        </span>
      ) : (
        <span className="flex-1 truncate text-foreground">{device.name}</span>
      )}
      {device.device_type === "sensor" && device.points ? (
        // How much of the estate this one pin speaks for. A placement is a fact
        // about a box and its points follow it, so the count is the consequence
        // of the drag and is worth seeing before making it.
        <span className="shrink-0 text-[10px] tabular-nums text-muted">
          {device.points} pts
        </span>
      ) : null}
    </div>
  );
}

interface PlacedRowProps {
  placement: EditorPlacement;
  inventory?: PlaceableDevice;
  isSelected: boolean;
  onSelect: () => void;
  onDelete?: (placement: EditorPlacement, name: string) => void;
}

function PlacedRow({ placement, inventory, isSelected, onSelect, onDelete }: Readonly<PlacedRowProps>) {
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
          icon={iconForType(placement.device_type, inventory ?? placement)}
          className="shrink-0 text-sm text-muted"
        />
        <span className="flex-1 truncate text-left text-foreground">{name}</span>
      </button>
      <button
        type="button"
        onClick={() => onDelete?.(placement, name)}
        title="Remove from floor"
        className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-red-500 transition hover:bg-red-500/10 hover:text-red-600"
      >
        <Icon icon="heroicons-outline:trash" className="text-sm" />
      </button>
    </div>
  );
}

export interface DeviceManagementSidebarProps {
  /** The open floor and its site — what "placed elsewhere" is measured against. */
  siteId: string;
  floorId: string;
  placements?: EditorPlacement[];
  selectedDeviceId?: string | null;
  onSelectDevice?: (placement: EditorPlacement) => void;
  onPaletteDragStart?: (device: PlaceableDevice) => void;
  onPaletteDragEnd?: () => void;
  draggingDeviceId?: string | null;
  onDeleteDevice?: (placement: EditorPlacement) => void;
}

export function DeviceManagementSidebar({
  siteId,
  floorId,
  placements = [],
  selectedDeviceId,
  onSelectDevice,
  onPaletteDragStart,
  onPaletteDragEnd,
  draggingDeviceId = null,
  onDeleteDevice,
}: Readonly<DeviceManagementSidebarProps>) {
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<"available" | "placed">("available");
  const [deviceTypeFilter, setDeviceTypeFilter] = useState("all");
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);

  // ── Inventory sources (vms + access-control + iot) ───────────────────
  const { inventory, inventoryById, loading } = useDeviceInventory();

  // Where every device in the tenant is placed, so one placed on another floor
  // or site is not offered as Available here.
  const indexQ = useQuery({
    queryKey: PLACEMENT_INDEX_KEY,
    queryFn: () => sitesApi.devicePlacements.index(),
    staleTime: 30_000,
    retry: false,
  });
  const elsewhereById = useMemo(() => {
    const m = new Map<string, string>();
    for (const row of indexQ.data?.items ?? []) {
      if (isElsewhere(row, siteId, floorId)) m.set(row.device_id, placementWhere(row));
    }
    return m;
  }, [indexQ.data, siteId, floorId]);

  const placedIds = useMemo(() => {
    const set = new Set<string>();
    for (const p of placements) if (p.device_id) set.add(p.device_id);
    return set;
  }, [placements]);

  const matches = useMemo(() => {
    const q = search.trim().toLowerCase();
    return inventory.filter((d) => {
      // On this floor in the editor (saved or just dropped) wins over the index,
      // which still says where it was before this session's save.
      if (placedIds.has(d.device_id)) return false;
      if (deviceTypeFilter !== "all" && d.device_type !== deviceTypeFilter) return false;
      if (!q) return true;
      return d.name?.toLowerCase().includes(q) || d.search_ip?.toLowerCase().includes(q);
    });
  }, [inventory, placedIds, search, deviceTypeFilter]);
  const available = matches.filter((d) => !elsewhereById.has(d.device_id));
  const elsewhere = matches.filter((d) => elsewhereById.has(d.device_id));

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
        {tab === "available" && loading && (
          <div className="px-2 py-6 text-center text-xs text-muted">Loading…</div>
        )}
        {tab === "available" && !loading && (
          <>
            {available.length === 0 ? (
              <div className="rounded-md border border-dashed border-card-border bg-hover/40 px-3 py-4 text-center text-xs text-muted">
                No unplaced devices match.
              </div>
            ) : (
              <>
                <div className="px-1 pb-1 text-[10px] uppercase tracking-wider text-muted">
                  Drag onto canvas to place
                </div>
                {available.map((d) => (
                  <PaletteRow
                    key={d.device_id}
                    device={d}
                    isDragging={draggingDeviceId === d.device_id}
                    onDragStart={onPaletteDragStart}
                    onDragEnd={onPaletteDragEnd}
                  />
                ))}
              </>
            )}
            {elsewhere.length > 0 && (
              <>
                <div
                  className="px-1 pb-1 pt-3 text-[10px] uppercase tracking-wider text-muted"
                  title="A device has one location. Dropping one of these here asks before moving it."
                >
                  Placed elsewhere ({elsewhere.length}) · drop to move
                </div>
                {elsewhere.map((d) => (
                  <PaletteRow
                    key={d.device_id}
                    device={d}
                    elsewhere={elsewhereById.get(d.device_id)}
                    isDragging={draggingDeviceId === d.device_id}
                    onDragStart={onPaletteDragStart}
                    onDragEnd={onPaletteDragEnd}
                  />
                ))}
              </>
            )}
          </>
        )}
        {tab === "placed" && placements.length === 0 && (
          <div className="rounded-md border border-dashed border-card-border bg-hover/40 px-3 py-4 text-center text-xs text-muted">
            No devices placed yet — switch to <strong>Available</strong> and drag a device
            onto the canvas.
          </div>
        )}
        {tab === "placed" &&
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
          ))}
      </div>

      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} />
    </aside>
  );
}

export default DeviceManagementSidebar;
