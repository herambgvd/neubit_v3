"use client";

// Device-inventory API — read-only source that feeds the floor-builder's device
// palette (the list of placeable devices). Ported from neubit_v2's floor-builder,
// which sourced its palette from several services (cameras/NVR = VMS, access =
// gates, fire = panels).
//
// In neubit_v3 today there are three device backends: ACCESS-CONTROL (gates), VMS
// (cameras + NVRs, shipped in VMS P1) and IOT (the reading store's reporting
// devices). Fire (panels) is not built yet. This module wires those three and is
// structured so fire drops in later without churn.
//
// Wraps the shared `api` axios instance (baseURL already "/api/v1") and unwraps
// `.data` — same convention as sites.js / tags.js. The gateway routes
// "/api/v1/access/*" → the access service and "/api/v1/vms/*" → the vision service.
import type { AxiosResponse } from "axios";

import { api } from "@/lib/api";
import type { FederatedNvrList } from "@/features/vms/types";
import type {
  AccessDoorPublic,
  AccessInstancePublic,
  BiDeviceListResponse,
  CameraPublic,
  FederatedCameraList,
  Paged,
  QueryParams,
} from "@/lib/types";

const ACCESS = "/access";
const VMS = "/vms";
const BI = "/bi";

const unwrap = <T>(p: Promise<AxiosResponse<T>>): Promise<T> => p.then((r) => r.data);

function qs(params: QueryParams = {}): string {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") clean[k] = String(v);
  }
  const s = new URLSearchParams(clean).toString();
  return s ? `?${s}` : "";
}

// ── Access-control (a.k.a. "gates") source ────────────────────────────────
export const accessInventory = {
  // Controllers/panels — GET /access/instances → { items, total, skip, limit }.
  // Note: an instance's identifier field is `id` (not `instance_id`).
  instances: (params: QueryParams = {}) =>
    unwrap(api.get<Paged<AccessInstancePublic>>(`${ACCESS}/instances${qs({ limit: 500, ...params })}`)),
  // Doors — GET /access/doors?instance_id= → { items, total, skip, limit }.
  // A door's identifier field is `id` (not `door_id`).
  doors: (params: QueryParams = {}) =>
    unwrap(api.get<Paged<AccessDoorPublic>>(`${ACCESS}/doors${qs({ limit: 500, ...params })}`)),
};

/** One placeable camera: a local `CameraPublic`, or a federated recorder channel
 *  reduced to the three fields the palette needs (its composite id is the key). */
export type InventoryCamera =
  | CameraPublic
  | { id: string; name: string; status?: string; network_info?: undefined; onvif?: undefined };

// ── VMS (cameras + NVR) source ─────────────────────────────────────────────
// Feeds the floor-builder palette + the Events Map with camera / NVR devices.
// The DevicePlacement + Map already understand service:"vms" and
// device_type:"camera"|"nvr" (cameraRenderer draws the FoV cone / server glyph).
// A camera's / NVR's identifier field is `id`.
export const vmsInventory = {
  // Cameras — local VMS cameras (GET /vms/cameras) PLUS federated recorder-owned
  // cameras (GET /vms/federation/cameras), so an NVR's channels are placeable on a
  // floor plan too. Federated cameras carry a composite id (`fed:<node>:<cam>`) —
  // the same id the wall/DevicePlacement key on — and their node name as a suffix.
  cameras: async (params: QueryParams = {}): Promise<{ items: InventoryCamera[]; total: number }> => {
    const [local, fed] = await Promise.all([
      unwrap(api.get<Paged<CameraPublic>>(`${VMS}/cameras${qs({ limit: 500, ...params })}`)),
      unwrap(api.get<FederatedCameraList>(`${VMS}/federation/cameras`)).catch(
        (): Pick<FederatedCameraList, "items"> => ({ items: [] }),
      ),
    ]);
    const localItems: InventoryCamera[] = local?.items ?? [];
    const fedItems: InventoryCamera[] = (fed?.items ?? []).map((c) => ({
      id: `fed:${c.node_id}:${c.id}`,
      name: c.node_name ? `${c.name} · ${c.node_name}` : c.name,
      status: c.status,
    }));
    return { items: [...localItems, ...fedItems], total: localItems.length + fedItems.length };
  },
  // NVRs — the third-party appliances the RECORDERS have onboarded, merged across
  // every reachable one. They are the recorders' to own (each holds the appliance's
  // credentials and syncs its channels); assembling the estate-wide list is the part
  // no single recorder can do, which is why it is read here and not from a VMS
  // registry of its own.
  nvrs: () => unwrap(api.get<FederatedNvrList>("/vms/federation/nvrs")),
};

// ── IoT source ─────────────────────────────────────────────────────────────
// The reading store's own device inventory: GET /bi/devices → { total, items }
// where an item is one device that has REPORTED, grouped out of `points`
// (device_id, device_tag, category, device_type, points, last_seen_at, …).
//
// It is deliberately the SAME list Building Intelligence counts. There is no
// separate IoT device registry to invent one from: a device exists here because
// it sent a reading, which is also the only reason it can be placed — a pin on a
// device this store has never heard of would place nothing.
//
// NOTE the name collision: BI's `device_type` is the EQUIPMENT kind (`chiller`,
// `meter`, …, contract §11), while the floor plan's `device_type` is its own
// placement enum (`camera` / `nvr` / `sensor` / …). Every IoT device is placed as
// `sensor`, and the equipment kind + category ride along in `metadata` so the
// canvas can tell a chiller from a meter instead of drawing 29 identical dots.
export const iotInventory = {
  devices: (params: QueryParams = {}) =>
    unwrap(api.get<BiDeviceListResponse>(`${BI}/devices${qs({ limit: 500, ...params })}`)),
};

export default accessInventory;
