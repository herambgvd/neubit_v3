"use client";

// Sites API module — sites / floors / zones CRUD + tree + threat-level + uploads.
// Ported from neubit_v2's lib/api/sites.js and adapted to neubit_v3's axios client:
//   • neubit_v2 used bespoke get/post helpers that returned the raw body; here we
//     wrap the shared `api` axios instance (baseURL already "/api/v1") and unwrap
//     `.data` so callers keep receiving plain objects.
//   • Paths are relative to /api/v1 → "/sites", "/floors", "/zones",
//     "/device-placements" (all served by the core service).
import { api } from "@/lib/api";

const SITES = "/sites";
const FLOORS = "/floors";
const ZONES = "/zones";
const DEVICE_PLACEMENTS = "/device-placements";

const unwrap = (p) => p.then((r) => r.data);

// Drop null/undefined/"" so URLSearchParams doesn't emit empty filters.
function qs(params = {}) {
  const clean = {};
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") clean[k] = v;
  }
  const s = new URLSearchParams(clean).toString();
  return s ? `?${s}` : "";
}

function floorFormData(fields, file) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined && v !== null && v !== "") fd.append(k, String(v));
  }
  if (file) fd.append("file", file);
  return fd;
}

export const sites = {
  list: (params = {}) => unwrap(api.get(`${SITES}${qs(params)}`)),
  tree: () => unwrap(api.get(`${SITES}/tree`)),
  get: (id) => unwrap(api.get(`${SITES}/${id}`)),
  create: (body) => unwrap(api.post(SITES, body)),
  update: (id, body) => unwrap(api.patch(`${SITES}/${id}`, body)),
  remove: (id) => unwrap(api.delete(`${SITES}/${id}`)),
  restore: (id) => unwrap(api.post(`${SITES}/${id}/restore`, {})),
  setThreatLevel: (id, level) =>
    unwrap(api.put(`${SITES}/${id}/threat-level`, { threat_level: level })),
  uploadImage: (id, file) => {
    const fd = new FormData();
    fd.append("file", file);
    return unwrap(api.post(`${SITES}/${id}/image`, fd));
  },

  floors: {
    list: (params = {}) => unwrap(api.get(`${FLOORS}${qs(params)}`)),
    get: (id) => unwrap(api.get(`${FLOORS}/${id}`)),
    create: (body) => unwrap(api.post(FLOORS, body)),
    createWithUpload: ({ site_id, name, file, ...rest }) =>
      unwrap(api.post(`${FLOORS}/upload`, floorFormData({ site_id, name, ...rest }, file))),
    update: (id, body) => unwrap(api.patch(`${FLOORS}/${id}`, body)),
    replaceFloorplan: (id, file) => {
      const fd = new FormData();
      fd.append("file", file);
      return unwrap(api.post(`${FLOORS}/${id}/floorplan`, fd));
    },
    remove: (id) => unwrap(api.delete(`${FLOORS}/${id}`)),
    restore: (id) => unwrap(api.post(`${FLOORS}/${id}/restore`, {})),
  },

  zones: {
    list: (params = {}) => unwrap(api.get(`${ZONES}${qs(params)}`)),
    get: (id) => unwrap(api.get(`${ZONES}/${id}`)),
    create: (body) => unwrap(api.post(ZONES, body)),
    update: (id, body) => unwrap(api.patch(`${ZONES}/${id}`, body)),
    remove: (id) => unwrap(api.delete(`${ZONES}/${id}`)),
    restore: (id) => unwrap(api.post(`${ZONES}/${id}/restore`, {})),
  },

  // Device placements — a device pinned onto a floor at { x, y, rotation }.
  // Addressed by `device_id`; `register` is an upsert-by-device_id within the
  // tenant. Served by the core service under /api/v1/device-placements.
  devicePlacements: {
    register: (body) => unwrap(api.post(`${DEVICE_PLACEMENTS}/register`, body)),
    get: (deviceId) => unwrap(api.get(`${DEVICE_PLACEMENTS}/${deviceId}`)),
    update: (deviceId, body) => unwrap(api.patch(`${DEVICE_PLACEMENTS}/${deviceId}`, body)),
    remove: (deviceId) => unwrap(api.delete(`${DEVICE_PLACEMENTS}/${deviceId}`)),
    listByFloor: (floorId, params = {}) =>
      unwrap(api.get(`${DEVICE_PLACEMENTS}/by-floor/${floorId}${qs(params)}`)),
    listByZone: (zoneId) => unwrap(api.get(`${DEVICE_PLACEMENTS}/by-zone/${zoneId}`)),
  },
};

export default sites;
