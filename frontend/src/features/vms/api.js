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
const EVENTS = "/vms/events";
const LINKAGE = "/vms/linkage-rules";
const RECORDINGS = "/vms/recordings";
const STORAGE = "/vms/storage";
const EXPORT = "/vms/export";

// The axios baseURL is "<host>/api/v1" — for endpoints the browser must hit
// directly (an authed blob download triggered via a save-link), prefix the
// full origin. Reuse the same host-derivation the api instance uses.
const API_ROOT =
  process.env.NEXT_PUBLIC_API_URL ||
  (typeof window !== "undefined" ? `http://${window.location.hostname}:8000` : "http://localhost:8000");

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

  // ── Camera device-events (P5-A) — the normalized event feed ─────────────
  // ONVIF/brand device notifications (motion|tamper|video_loss|io_input|
  // line_crossing|zone_intrusion|audio|…) + system events (camera_online/offline,
  // recording_error, storage_low), normalized + deduped. Live updates arrive over
  // the core realtime SSE bridge (useVmsEventStream); this is the INITIAL history +
  // the ack action. Public shape: { id, camera_id, event_type, severity, source,
  // title, description, raw, occurred_at, acknowledged, acknowledged_by/_at,
  // snapshot_path, recording_id, created_at }.
  events: {
    // GET /vms/events?camera_id=&event_type=&severity=&acknowledged=&from=&to=&skip=&limit=
    //   → { items, total, skip, limit } (newest first).
    list: (params = {}) => unwrap(api.get(`${EVENTS}${qs(params)}`)),
    // GET /vms/cameras/{id}/events?… → one camera's events.
    listForCamera: (cameraId, params = {}) =>
      unwrap(api.get(`${CAMERAS}/${cameraId}/events${qs(params)}`)),
    // POST /vms/events/{id}/ack → the acknowledged VmsEventPublic (idempotent).
    ack: (id) => unwrap(api.post(`${EVENTS}/${id}/ack`, {})),
  },

  // ── Linkage / action rules (P5-B) — event → action automation ───────────
  // A rule fires actions when a matching camera event arrives: start_recording
  // (event-clip w/ pre/post buffer), notify (channel), ptz_preset, trigger_output
  // (relay), popup (operator UI). Public shape: { id, name, description, is_active,
  // trigger_event_type, trigger_filter{}, camera_scope{scope,camera_ids?,group_ids?},
  // actions[{type,config}], cooldown_seconds, schedule{}, created_by, created_at,
  // updated_at }. Writes gate on vms.config.manage; the fire-audit is read-only.
  linkage: {
    // GET /vms/linkage-rules?trigger_event_type=&is_active=&skip=&limit= → { items, total }.
    list: (params = {}) => unwrap(api.get(`${LINKAGE}${qs(params)}`)),
    get: (id) => unwrap(api.get(`${LINKAGE}/${id}`)),
    create: (body) => unwrap(api.post(LINKAGE, body)),
    update: (id, body) => unwrap(api.patch(`${LINKAGE}/${id}`, body)),
    remove: (id) => unwrap(api.delete(`${LINKAGE}/${id}`)),
    // GET /vms/linkage-fires?rule_id=&camera_id=&skip=&limit= → the fire-audit log.
    fires: (params = {}) => unwrap(api.get(`/vms/linkage-fires${qs(params)}`)),
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

  // ── Recorded playback (P4-A) — timeline + a RECORDED PlaybackSession ─────
  // The Go `nvr` builds a seekable playback URL from MediaMTX's playback server
  // over a recorded window; `vision` mints a media token and returns a session.
  // hls_url ALREADY carries "?token=" — the player consumes it verbatim.
  // Seeking to a new timestamp = requesting a NEW session at that `from`.
  playback: {
    // POST /cameras/{id}/playback { from, to, profile? } →
    //   { session_id, hls_url, token, from, to, ranges, expires_at }.
    //   `from`/`to` are ISO strings; `ranges` are the covered [start,end] spans.
    session: (cameraId, { from, to, profile = "main" } = {}) =>
      unwrap(api.post(`${CAMERAS}/${cameraId}/playback`, { from, to, profile })),
    // GET /cameras/{id}/timeline?day=YYYY-MM-DD (or ?from=&to=) →
    //   { coverage:[{start,end}], gaps:[{start,end}], total_seconds }.
    timeline: (cameraId, params = {}) =>
      unwrap(api.get(`${CAMERAS}/${cameraId}/timeline${qs(params)}`)),
  },

  // ── Clip export (P4-B) — a job that concatenates the covered segments ────
  export: {
    // POST /cameras/{id}/export { from, to, format? } → { job_id, status }.
    create: (cameraId, { from, to, format = "mp4" } = {}) =>
      unwrap(api.post(`${CAMERAS}/${cameraId}/export`, { from, to, format })),
    // GET /export/{job} → { job_id, status(queued|running|done|failed),
    //   file_size?, error?, camera_id, from, to, format }.
    status: (jobId) => unwrap(api.get(`${EXPORT}/${jobId}`)),
    // GET /export/{job}/download — token-gated mp4. The download endpoint is
    // JWT-authed (Bearer), so it can't be a plain <a href> (no header). Fetch
    // as a blob and hand it to the caller to save.
    downloadBlob: (jobId) =>
      api.get(`${EXPORT}/${jobId}/download`, { responseType: "blob" }).then((r) => r.data),
    // The absolute URL (for reference / opening in a new tab where the browser
    // already holds the session) — note it still needs the Bearer header, so
    // prefer downloadBlob for the in-app "Download" button.
    downloadUrl: (jobId) => `${API_ROOT}/api/v1${EXPORT}/${jobId}/download`,
  },

  // ── NVR footage extraction (P4-B) — search + play an onboarded NVR's own
  // recorded storage (ONVIF Profile G / Hik ISAPI / CP-Plus-Dahua / Lumina).
  // A unified timeline/export across our recordings + client NVRs.
  nvrFootage: {
    // GET /nvrs/{id}/channels/{ch}/recordings?from=&to= →
    //   { items:[{start,end,duration?,...}], total } (or bare array).
    recordings: (nvrId, channel, { from, to } = {}) =>
      unwrap(api.get(`${NVRS}/${nvrId}/channels/${channel}/recordings${qs({ from, to })}`)),
    // POST /nvrs/{id}/channels/{ch}/playback { from, to } →
    //   { session_id?, hls_url?, webrtc_url?, rtsp_url?, from, to } — plays
    //   like a recorded/live session (hls_url carries "?token=").
    playback: (nvrId, channel, { from, to } = {}) =>
      unwrap(api.post(`${NVRS}/${nvrId}/channels/${channel}/playback`, { from, to })),
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
