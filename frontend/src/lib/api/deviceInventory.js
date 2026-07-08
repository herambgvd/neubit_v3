"use client";

// Device-inventory API — read-only source that feeds the floor-builder's device
// palette (the list of placeable devices). Ported from neubit_v2's floor-builder,
// which sourced its palette from several services (cameras/NVR = VMS, access =
// gates, fire = panels).
//
// In neubit_v3 today there are two device backends: ACCESS-CONTROL (gates) and
// VMS (cameras + NVRs, shipped in VMS P1). Fire (panels) is not built yet. This
// module wires the access + vms sources and is structured so fire drops in later
// without churn.
//
// Wraps the shared `api` axios instance (baseURL already "/api/v1") and unwraps
// `.data` — same convention as sites.js / tags.js. The gateway routes
// "/api/v1/access/*" → the access service and "/api/v1/vms/*" → the vision service.
import { api } from "@/lib/api";

const ACCESS = "/access";
const VMS = "/vms";

const unwrap = (p) => p.then((r) => r.data);

function qs(params = {}) {
  const clean = {};
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") clean[k] = v;
  }
  const s = new URLSearchParams(clean).toString();
  return s ? `?${s}` : "";
}

// ── Access-control (a.k.a. "gates") source ────────────────────────────────
export const accessInventory = {
  // Controllers/panels — GET /access/instances → { items, total, skip, limit }.
  // Note: an instance's identifier field is `id` (not `instance_id`).
  instances: (params = {}) =>
    unwrap(api.get(`${ACCESS}/instances${qs({ limit: 500, ...params })}`)),
  // Doors — GET /access/doors?instance_id= → { items, total, skip, limit }.
  // A door's identifier field is `id` (not `door_id`).
  doors: (params = {}) => unwrap(api.get(`${ACCESS}/doors${qs({ limit: 500, ...params })}`)),
};

// ── VMS (cameras + NVR) source ─────────────────────────────────────────────
// Feeds the floor-builder palette + the Events Map with camera / NVR devices.
// The DevicePlacement + Map already understand service:"vms" and
// device_type:"camera"|"nvr" (cameraRenderer draws the FoV cone / server glyph).
// A camera's / NVR's identifier field is `id`.
export const vmsInventory = {
  // Cameras — GET /vms/cameras → { items, total, skip, limit }.
  cameras: (params = {}) =>
    unwrap(api.get(`${VMS}/cameras${qs({ limit: 500, ...params })}`)),
  // NVRs — GET /vms/nvrs → { items, total, skip, limit }.
  nvrs: (params = {}) => unwrap(api.get(`${VMS}/nvrs${qs({ limit: 500, ...params })}`)),
};

export default accessInventory;
