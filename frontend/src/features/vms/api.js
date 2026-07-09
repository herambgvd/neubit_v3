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
//   Patterns:  GET/POST /patterns · GET/PATCH/DELETE /patterns/{id}
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
const PATTERNS = "/vms/patterns";
const HEALTH = "/vms/cameras/health";
const RECORDINGS = "/vms/recordings";
const STORAGE = "/vms/storage";

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

  // Camera groups — a named set of cameras shown in a grid `layout`
  // ("1x1|2x2|3x3|4x3|4x4|6x4|6x5|6x6|8x8"). Groups are the unit a Pattern
  // rotates through on the video wall. Public shape: { id, name, description,
  // camera_ids[], layout, is_active, color }.
  groups: {
    list: (params = {}) => unwrap(api.get(`${GROUPS}${qs(params)}`)),
    get: (id) => unwrap(api.get(`${GROUPS}/${id}`)),
    create: (body) => unwrap(api.post(GROUPS, body)),
    update: (id, body) => unwrap(api.patch(`${GROUPS}/${id}`, body)),
    remove: (id) => unwrap(api.delete(`${GROUPS}/${id}`)),
  },

  // Patterns — a named ROTATING sequence of camera groups. On the wall a pattern
  // cycles through its groups every `seconds` (dwell), each group filling the
  // wall with its cameras in its layout. Public shape: { id, name, description,
  // camera_group_ids[], seconds, is_active }.
  patterns: {
    // GET /patterns?is_active= → { items, total } (or bare array).
    list: (params = {}) => unwrap(api.get(`${PATTERNS}${qs(params)}`)),
    get: (id) => unwrap(api.get(`${PATTERNS}/${id}`)),
    create: (body) => unwrap(api.post(PATTERNS, body)),
    update: (id, body) => unwrap(api.patch(`${PATTERNS}/${id}`, body)),
    remove: (id) => unwrap(api.delete(`${PATTERNS}/${id}`)),
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

  // ── Live streaming (P2-D) — PlaybackSession issue / renew / release ──────
  // The Go `nvr` orchestrates MediaMTX; Python `vision` issues sessions. The
  // returned hls_url/webrtc_url are ALREADY gateway-routed and ALREADY carry
  // "?token=" — the player consumes them verbatim (never re-append the token).
  // webrtc_url already ends in "/whep" (the WHEP endpoint), so POST the SDP
  // offer straight to it.
  live: {
    // POST /cameras/{id}/live { profile } → PlaybackSessionPublic
    //   { session_id, camera_id, profile, hls_url, webrtc_url, rtsp_url,
    //     token, expires_at, ready }. `profile` defaults to the low-bandwidth
    //   "sub" stream; the backend falls back to main/onvif when absent.
    start: (cameraId, profile = "sub") =>
      unwrap(api.post(`${CAMERAS}/${cameraId}/live`, { profile })),
    // POST /cameras/{id}/live/{session}/renew → fresh token + expiry (call
    //   before expiry to keep long views alive; TTL ~300s). Does NOT re-ensure
    //   the MediaMTX path — playback never drops.
    renew: (cameraId, sessionId) =>
      unwrap(api.post(`${CAMERAS}/${cameraId}/live/${sessionId}/renew`, {})),
    // DELETE /live/{session} → release the session (nvr path teardown + row).
    //   Call on unmount so idle MediaMTX paths get reaped.
    release: (sessionId) => unwrap(api.delete(`/vms/live/${sessionId}`)),
  },

  // ── Recordings (P3-A/B) — browse + integrity/lock ───────────────────────
  // Recording rows are tracked from MediaMTX segments by the Go `nvr` and
  // persisted by `vision`. Fields: id/camera_id/profile/path/start_time/
  // end_time/duration/file_size/trigger_type/locked/checksum/integrity_status/
  // storage_pool_id. No dedicated download endpoint yet (P4) — surface the path.
  recordings: {
    // GET /cameras/{id}/recordings?from=&to=&trigger=&skip=&limit= → { items, total }.
    list: (cameraId, params = {}) =>
      unwrap(api.get(`${CAMERAS}/${cameraId}/recordings${qs(params)}`)),
    // GET /recordings/{id} → a single RecordingPublic.
    get: (id) => unwrap(api.get(`${RECORDINGS}/${id}`)),
    // POST /recordings/{id}/lock — protect from retention/tiering deletion.
    lock: (id) => unwrap(api.post(`${RECORDINGS}/${id}/lock`, {})),
    // POST /recordings/{id}/unlock — release the lock.
    unlock: (id) => unwrap(api.post(`${RECORDINGS}/${id}/unlock`, {})),
    // POST /recordings/{id}/verify — recompute the SHA-256 + return integrity_status.
    verify: (id) => unwrap(api.post(`${RECORDINGS}/${id}/verify`, {})),
  },

  // ── Per-camera recording config (P3-A) ──────────────────────────────────
  // Mode / weekly schedule / retention drive the recording-supervisor. Manual
  // start/stop toggle recording on the MediaMTX path immediately.
  recordingConfig: {
    // PUT /cameras/{id}/recording { recording_mode, recording_schedule,
    //   retention_days, record_substream }.
    set: (cameraId, body) => unwrap(api.put(`${CAMERAS}/${cameraId}/recording`, body)),
    // POST /cameras/{id}/recording/start — begin recording now (manual).
    start: (cameraId) => unwrap(api.post(`${CAMERAS}/${cameraId}/recording/start`, {})),
    // POST /cameras/{id}/recording/stop — stop recording now.
    stop: (cameraId) => unwrap(api.post(`${CAMERAS}/${cameraId}/recording/stop`, {})),
  },

  // ── Storage (P3-B) — pools + tiering ────────────────────────────────────
  // Pool: name, pool_type(local|nfs|smb|s3), path, priority, max_size_bytes,
  //   is_default, is_active, nas_*(server/share/protocol/username/password/
  //   domain), s3_*(endpoint/bucket/access_key/secret_key/region/use_ssl),
  //   mount_state, reachable. Credentials are write-only.
  storage: {
    pools: {
      // GET /storage/pools → { items, total } (or bare array).
      list: (params = {}) => unwrap(api.get(`${STORAGE}/pools${qs(params)}`)),
      get: (id) => unwrap(api.get(`${STORAGE}/pools/${id}`)),
      create: (body) => unwrap(api.post(`${STORAGE}/pools`, body)),
      update: (id, body) => unwrap(api.patch(`${STORAGE}/pools/${id}`, body)),
      remove: (id) => unwrap(api.delete(`${STORAGE}/pools/${id}`)),
      // GET /storage/pools/{id}/usage → { used_bytes, capacity_bytes,
      //   recording_count, ... }.
      usage: (id) => unwrap(api.get(`${STORAGE}/pools/${id}/usage`)),
    },
    tierRules: {
      // GET /storage/tier-rules → { items, total }.
      list: (params = {}) => unwrap(api.get(`${STORAGE}/tier-rules${qs(params)}`)),
      create: (body) => unwrap(api.post(`${STORAGE}/tier-rules`, body)),
      update: (id, body) => unwrap(api.patch(`${STORAGE}/tier-rules/${id}`, body)),
      remove: (id) => unwrap(api.delete(`${STORAGE}/tier-rules/${id}`)),
    },
  },
};

export default vms;
