"use client";

// VMS API module — cameras, NVRs, camera-groups, per-camera ACL, health, and
// ONVIF discovery/onboarding. Wraps the shared `api` axios instance (baseURL
// already "/api/v1") and unwraps `.data` so callers get plain objects — same
// convention as features/ingest/api.js and lib/api/sites.js. The gateway routes
// "/api/v1/vms/*" → the `vision` (Python) service.
//
// Backend contract (VMS P1, all under /api/v1/vms):
//   Cameras:   GET/POST /cameras · GET/PATCH/DELETE /cameras/{id}
//              POST /cameras/bulk (enable|disable|group|retention|delete, cap 200)
//              POST /cameras/reorder
//   Discovery: POST /cameras/onvif/discover|probe|channels|bulk-add|snapshot
//              GET  /cameras/{id}/snapshot
//   Config:    POST /cameras/{id}/ptz · PATCH /cameras/{id}/imaging|io
//              GET/PUT /cameras/{id}/motion-config|privacy-masks|onvif-events
//   NVR:       GET/POST /nvrs · GET/PATCH/DELETE /nvrs/{id}
//              POST /nvrs/discover · GET /nvrs/{id}/channels · POST /nvrs/channels
//              POST /nvrs/{id}/map-channels · GET /nvrs/{id}/health · POST /nvrs/{id}/refresh
//   Groups:    GET/POST /camera-groups · PATCH/DELETE /camera-groups/{id}
//   ACL:       GET/PUT /cameras/{id}/acl
//   Health:    GET /cameras/health · GET /cameras/{id}/health/history
//              POST /cameras/{id}/health/refresh
//
// Credentials (onvif.password / nvr password) are WRITE-ONLY — sent on
// create/update, never returned (public shapes expose has_password/has_credentials).
import { api } from "@/lib/api";

const CAMERAS = "/vms/cameras";
const NVRS = "/vms/nvrs";
const GROUPS = "/vms/camera-groups";
const HEALTH = "/vms/cameras/health";

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

export const vms = {
  cameras: {
    // GET /cameras → { items, total, skip, limit }. Filters: status, brand,
    // site_id, group_id, q + skip/limit.
    list: (params = {}) => unwrap(api.get(`${CAMERAS}${qs(params)}`)),
    get: (id) => unwrap(api.get(`${CAMERAS}/${id}`)),
    create: (body) => unwrap(api.post(CAMERAS, body)),
    update: (id, body) => unwrap(api.patch(`${CAMERAS}/${id}`, body)),
    remove: (id) => unwrap(api.delete(`${CAMERAS}/${id}`)),
    // POST /cameras/bulk { camera_ids, action, group_id?, retention_days? }.
    bulk: (body) => unwrap(api.post(`${CAMERAS}/bulk`, body)),
    // POST /cameras/reorder { items: [{ id, display_order }] }.
    reorder: (items) => unwrap(api.post(`${CAMERAS}/reorder`, { items })),

    // Config sub-resources (ONVIF-backed) ──────────────────────────────
    ptz: (id, body) => unwrap(api.post(`${CAMERAS}/${id}/ptz`, body)),
    setImaging: (id, body) => unwrap(api.patch(`${CAMERAS}/${id}/imaging`, body)),
    setIo: (id, body) => unwrap(api.patch(`${CAMERAS}/${id}/io`, body)),
    getMotionConfig: (id) => unwrap(api.get(`${CAMERAS}/${id}/motion-config`)),
    setMotionConfig: (id, body) => unwrap(api.put(`${CAMERAS}/${id}/motion-config`, body)),
    getPrivacyMasks: (id) => unwrap(api.get(`${CAMERAS}/${id}/privacy-masks`)),
    setPrivacyMasks: (id, masks) => unwrap(api.put(`${CAMERAS}/${id}/privacy-masks`, { masks })),
    getOnvifEvents: (id) => unwrap(api.get(`${CAMERAS}/${id}/onvif-events`)),
    setOnvifEvents: (id, body) => unwrap(api.put(`${CAMERAS}/${id}/onvif-events`, body)),

    // Snapshot URL for a saved camera (rendered via <img>, not fetched here).
    snapshotUrl: (id) => `${CAMERAS}/${id}/snapshot`,
  },

  // ONVIF discovery / onboarding (unsaved-device flows) ──────────────────
  discovery: {
    // POST /cameras/onvif/discover { network?, brand? } → { items, total }.
    discover: (body = {}) => unwrap(api.post(`${CAMERAS}/onvif/discover`, body)),
    // POST /cameras/onvif/probe { host, port, username, password, brand? }.
    probe: (body) => unwrap(api.post(`${CAMERAS}/onvif/probe`, body)),
    // POST /cameras/onvif/channels — enumerate an NVR/encoder's channels.
    channels: (body) => unwrap(api.post(`${CAMERAS}/onvif/channels`, body)),
    // POST /cameras/onvif/bulk-add { host, port, username, password, brand, channels[] }.
    bulkAdd: (body) => unwrap(api.post(`${CAMERAS}/onvif/bulk-add`, body)),
    // POST /cameras/onvif/snapshot — grab a JPEG from an unsaved host (returns blob).
    snapshot: (body) =>
      api.post(`${CAMERAS}/onvif/snapshot`, body, { responseType: "blob" }).then((r) => r.data),
  },

  nvrs: {
    // GET /nvrs → { items, total, skip, limit }. Filters: status, brand, q.
    list: (params = {}) => unwrap(api.get(`${NVRS}${qs(params)}`)),
    get: (id) => unwrap(api.get(`${NVRS}/${id}`)),
    create: (body) => unwrap(api.post(NVRS, body)),
    update: (id, body) => unwrap(api.patch(`${NVRS}/${id}`, body)),
    remove: (id) => unwrap(api.delete(`${NVRS}/${id}`)),
    // POST /nvrs/discover { network?, brand? }.
    discover: (body = {}) => unwrap(api.post(`${NVRS}/discover`, body)),
    // GET /nvrs/{id}/channels — enumerate a SAVED NVR's channels (creds off the row).
    channels: (id) => unwrap(api.get(`${NVRS}/${id}/channels`)),
    // POST /nvrs/channels { host, port, username, password, brand? } — UNSAVED host.
    probeChannels: (body) => unwrap(api.post(`${NVRS}/channels`, body)),
    // POST /nvrs/{id}/map-channels { channels: [{ channel_number, name?, add }] }.
    mapChannels: (id, channels) => unwrap(api.post(`${NVRS}/${id}/map-channels`, { channels })),
    // GET /nvrs/{id}/health — reachability + storage/channel snapshot.
    health: (id) => unwrap(api.get(`${NVRS}/${id}/health`)),
    // POST /nvrs/{id}/refresh — re-probe + return the refreshed NVR.
    refresh: (id) => unwrap(api.post(`${NVRS}/${id}/refresh`, {})),
  },

  groups: {
    list: () => unwrap(api.get(GROUPS)),
    create: (body) => unwrap(api.post(GROUPS, body)),
    update: (id, body) => unwrap(api.patch(`${GROUPS}/${id}`, body)),
    remove: (id) => unwrap(api.delete(`${GROUPS}/${id}`)),
  },

  acl: {
    // GET /cameras/{id}/acl → { items, total }.
    get: (cameraId) => unwrap(api.get(`${CAMERAS}/${cameraId}/acl`)),
    // PUT /cameras/{id}/acl { entries: [{ subject_type, subject_id, privileges[] }] }.
    put: (cameraId, entries) => unwrap(api.put(`${CAMERAS}/${cameraId}/acl`, { entries })),
  },

  health: {
    // GET /cameras/health?camera_id= → { items, total } (latest per camera).
    latest: (params = {}) => unwrap(api.get(`${HEALTH}${qs(params)}`)),
    // GET /cameras/{id}/health/history?skip=&limit=&from=&to= → time-series.
    history: (cameraId, params = {}) =>
      unwrap(api.get(`${CAMERAS}/${cameraId}/health/history${qs(params)}`)),
    // POST /cameras/{id}/health/refresh → a fresh sample.
    refresh: (cameraId) => unwrap(api.post(`${CAMERAS}/${cameraId}/health/refresh`, {})),
  },
};

export default vms;
