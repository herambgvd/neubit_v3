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
const REPORTS = "/vms/reports";
const REPORT_SCHEDULES = "/vms/report-schedules";
const ONVIF_SERVER = "/vms/onvif-server";
const BOOKMARKS = "/vms/bookmarks";
const EVIDENCE = "/vms/evidence";

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
  // ── Operations / Health dashboard (G2) — one live rollup ────────────────
  // GET /vms/dashboard/summary → { cameras, recording, storage, nodes, alarms,
  //   nvrs, generated_at }. Read-only aggregation over existing camera/recording/
  //   storage/node/event/nvr data. Gated on vms.camera.read; tenant-scoped. The
  //   node section degrades to data_plane:"unknown" if the Go nvr is unreachable.
  dashboard: {
    summary: () => unwrap(api.get("/vms/dashboard/summary")),
  },

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

    // ── Drawn regions (G5) — privacy masks + motion-detection zones ──────
    // Both are lists of NORMALIZED (0..1) shapes, top-left origin: a rect
    // { x, y, w, h } or a polygon { points:[[x,y],...] }. motion-zone shapes may
    // also carry an optional `sensitivity` / `threshold`. The catalog is stored
    // LOCALLY (source of truth for the draw tool) then best-effort pushed to the
    // device — the PUT echo carries `pushed` (bool) + `push_error` (str) so the UI
    // shows "applied on camera" vs "stored locally — not applied on device".
    //   GET  /cameras/{id}/privacy-masks → { privacy_masks:[...] }
    //   PUT  /cameras/{id}/privacy-masks { masks:[...] } → { privacy_masks, pushed, push_error? }
    //   GET  /cameras/{id}/motion-zones  → { motion_zones:[...] }
    //   PUT  /cameras/{id}/motion-zones  { zones:[...] }  → { motion_zones, pushed, push_error? }
    // Reads gate on vms.camera.read; writes on vms.config.manage.
    privacyMasks: {
      get: (id) => unwrap(api.get(`${CAMERAS}/${id}/privacy-masks`)),
      put: (id, masks) => unwrap(api.put(`${CAMERAS}/${id}/privacy-masks`, { masks })),
    },
    motionZones: {
      get: (id) => unwrap(api.get(`${CAMERAS}/${id}/motion-zones`)),
      put: (id, zones) => unwrap(api.put(`${CAMERAS}/${id}/motion-zones`, { zones })),
    },

    getOnvifEvents: (id) => unwrap(api.get(`${CAMERAS}/${id}/onvif-events`)),
    setOnvifEvents: (id, body) => unwrap(api.put(`${CAMERAS}/${id}/onvif-events`, body)),

    // ── Two-way audio / push-to-talk (G6) ────────────────────────────────
    // Only meaningful for a `talk_capable` camera (backchannel / two-way). Gates
    // on vms.live.view. POST /cameras/{id}/talk/session → issues a short-lived
    // uplink session for browser-mic → camera-speaker audio:
    //   { session_id, kind:"whip"|"rtsp_backchannel"|"http_push", target_url,
    //     whip_url (may carry ?token=), codec, token, expires_at, live_validate }
    // For kind "whip" the frontend POSTs a mic-only SDP offer to `whip_url`
    // (WHIP publish) and plays back the answer. 409 TALK_UNSUPPORTED for a
    // non-capable camera. Real backchannel push = # LIVE-VALIDATE (needs a
    // camera speaker).
    talkSession: (id) => unwrap(api.post(`${CAMERAS}/${id}/talk/session`, {})),

    // Snapshot URL for a saved camera (rendered via <img>, not fetched here).
    snapshotUrl: (id) => `${CAMERAS}/${id}/snapshot`,
  },

  // ── PTZ operator control (G1) — live pan/tilt/zoom/focus + presets + patrols
  // Only meaningful for a `ptz_capable` camera. Moves/preset-writes/patrol-writes
  // gate on `vms.ptz.control`; reads (list presets/patrols) on `vms.live.view`.
  //
  //   Move:    POST /cameras/{id}/ptz/move { mode:"continuous"|"relative"|
  //              "absolute", pan, tilt, zoom, speed } — for continuous, send ONE
  //              move on press then ONE stop on release (don't stream calls).
  //            POST /cameras/{id}/ptz/stop
  //            POST /cameras/{id}/ptz/zoom  { direction:"in"|"out", speed }
  //            POST /cameras/{id}/ptz/focus { direction:"near"|"far", speed }
  //   Presets: GET  /cameras/{id}/ptz/presets → { items } (or bare array)
  //            POST /cameras/{id}/ptz/presets { name } (stores CURRENT position)
  //            POST /cameras/{id}/ptz/presets/{pid}/goto
  //            DELETE /cameras/{id}/ptz/presets/{pid}
  //   Patrols: GET  /cameras/{id}/ptz/patrols → { items }
  //            POST /cameras/{id}/ptz/patrols { name, stops:[{preset_id,
  //              dwell_seconds}], speed }
  //            PATCH/DELETE /cameras/{id}/ptz/patrols/{pid}
  //            POST /cameras/{id}/ptz/patrols/{pid}/start | /stop
  ptz: {
    // Continuous move: pan/tilt/zoom velocities in [-1,1], speed in (0,1].
    // On release call stop (or send mode:"continuous" with 0 velocities via stop).
    move: (id, body) => unwrap(api.post(`${CAMERAS}/${id}/ptz/move`, body)),
    stop: (id) => unwrap(api.post(`${CAMERAS}/${id}/ptz/stop`, {})),
    zoom: (id, { direction, speed = 0.5 } = {}) =>
      unwrap(api.post(`${CAMERAS}/${id}/ptz/zoom`, { direction, speed })),
    focus: (id, { direction, speed = 0.5 } = {}) =>
      unwrap(api.post(`${CAMERAS}/${id}/ptz/focus`, { direction, speed })),
    presets: {
      list: (id) => unwrap(api.get(`${CAMERAS}/${id}/ptz/presets`)),
      // Stores the camera's CURRENT position under `name`.
      create: (id, name) => unwrap(api.post(`${CAMERAS}/${id}/ptz/presets`, { name })),
      goto: (id, presetId) => unwrap(api.post(`${CAMERAS}/${id}/ptz/presets/${presetId}/goto`, {})),
      remove: (id, presetId) => unwrap(api.delete(`${CAMERAS}/${id}/ptz/presets/${presetId}`)),
    },
    patrols: {
      list: (id) => unwrap(api.get(`${CAMERAS}/${id}/ptz/patrols`)),
      // { name, stops:[{ preset_id, dwell_seconds }], speed }.
      create: (id, body) => unwrap(api.post(`${CAMERAS}/${id}/ptz/patrols`, body)),
      update: (id, patrolId, body) =>
        unwrap(api.patch(`${CAMERAS}/${id}/ptz/patrols/${patrolId}`, body)),
      remove: (id, patrolId) => unwrap(api.delete(`${CAMERAS}/${id}/ptz/patrols/${patrolId}`)),
      start: (id, patrolId) => unwrap(api.post(`${CAMERAS}/${id}/ptz/patrols/${patrolId}/start`, {})),
      stop: (id, patrolId) => unwrap(api.post(`${CAMERAS}/${id}/ptz/patrols/${patrolId}/stop`, {})),
    },
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
    // POST /cameras/{id}/export { from, to, format?, watermark? } → the ExportJobPublic
    //   (job_id, status, signed, checksum, watermark, …). `watermark` burns a visible
    //   provenance stamp into the clip (re-encode; makes tampering visible).
    create: (cameraId, { from, to, format = "mp4", watermark = false } = {}) =>
      unwrap(api.post(`${CAMERAS}/${cameraId}/export`, { from, to, format, watermark })),
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
    // ── Tamper-evidence (P6-B) ────────────────────────────────────────────
    // POST /export/{job}/verify → { valid, reason, manifest } — re-hash the clip
    //   + verify its Ed25519 signature server-side (valid:false/reason:"tampered"
    //   if altered after signing).
    verify: (jobId) => unwrap(api.post(`${EXPORT}/${jobId}/verify`, {})),
    // GET /export/{job}/manifest → the tamper-evidence sidecar (file_hash,
    //   signature, exported_by, exported_at, chain…) as a downloadable blob.
    manifestBlob: (jobId) =>
      api.get(`${EXPORT}/${jobId}/manifest`, { responseType: "blob" }).then((r) => r.data),
    // GET /export/public-key → { algorithm, key_id, public_key(PEM) } for offline verify.
    publicKey: () => unwrap(api.get(`${EXPORT}/public-key`)),
  },

  // ── Operational reports (P6-B) — uptime / coverage / storage / events ────
  // Each report is computed over a [from, to] window (ISO). `kind` ∈
  //   camera-uptime | recording-coverage | storage-usage | event-stats |
  //   health-summary. JSON shape: { kind, window{from,to,seconds}, rows[],
  //   totals{}, by_type?, by_severity?, status_counts? }. Reads gate on
  //   vms.playback.view; schedule writes on vms.config.manage.
  reports: {
    // GET /vms/reports/{kind}?from=&to=&camera_id= → the JSON report.
    get: (kind, params = {}) => unwrap(api.get(`${REPORTS}/${kind}${qs(params)}`)),
    // GET /vms/reports/{kind}/export?format=csv|pdf&from=&to=&camera_id= → a
    //   CSV/PDF download (fetched as a blob so the Bearer header is sent).
    exportBlob: (kind, params = {}) =>
      api
        .get(`${REPORTS}/${kind}/export${qs(params)}`, { responseType: "blob" })
        .then((r) => r.data),
    schedules: {
      // GET /vms/report-schedules → { items, total }.
      list: (params = {}) => unwrap(api.get(`${REPORT_SCHEDULES}${qs(params)}`)),
      create: (body) => unwrap(api.post(REPORT_SCHEDULES, body)),
      update: (id, body) => unwrap(api.patch(`${REPORT_SCHEDULES}/${id}`, body)),
      remove: (id) => unwrap(api.delete(`${REPORT_SCHEDULES}/${id}`)),
    },
  },

  // ── Bookmarks (G3) — mark moments / ranges on a camera timeline ──────────
  // An operator flags an instant (point) or a span (range) in recorded footage
  // with a title + optional note + tags. Rendered as clickable markers on the
  // playback ScrubBar and listed in a side panel. Both reads and writes gate on
  // vms.playback.view — a bookmark is part of the investigation surface. Public
  // shape: { id, camera_id, start_ts, end_ts?, title, note?, tags[], created_by,
  // created_at, updated_at }. end_ts null = a point bookmark.
  bookmarks: {
    // GET /vms/bookmarks?camera_id=&from=&to=&skip=&limit= → { items, total }.
    list: (params = {}) => unwrap(api.get(`${BOOKMARKS}${qs(params)}`)),
    // POST /vms/bookmarks { camera_id, start_ts, end_ts?, title, note?, tags? }.
    create: (body) => unwrap(api.post(BOOKMARKS, body)),
    // PATCH /vms/bookmarks/{id} { start_ts?, end_ts?, title?, note?, tags? }.
    update: (id, body) => unwrap(api.patch(`${BOOKMARKS}/${id}`, body)),
    // DELETE /vms/bookmarks/{id} → 204.
    remove: (id) => unwrap(api.delete(`${BOOKMARKS}/${id}`)),
  },

  // ── Evidence lock / legal hold (G3) — protect a camera+range from deletion
  // An active lock keeps EVERY recording overlapping [start_ts,end_ts] safe from
  // the retention/tiering worker until released. Rendered as a shaded band on the
  // playback timeline and a "Protected" badge on recordings. Writes (create/
  // release/delete) gate on vms.recording.control; reads (list/check) on
  // vms.playback.view. Public shape: { id, camera_id, start_ts, end_ts, reason?,
  // case_ref?, is_active, created_by, created_at, released_by?, released_at? }.
  evidence: {
    // GET /vms/evidence?camera_id=&active_only=&skip=&limit= → { items, total }.
    list: (params = {}) => unwrap(api.get(`${EVIDENCE}${qs(params)}`)),
    // POST /vms/evidence { camera_id, start_ts, end_ts, reason?, case_ref? }.
    create: (body) => unwrap(api.post(EVIDENCE, body)),
    // POST /vms/evidence/{id}/release → the released lock (is_active:false).
    release: (id) => unwrap(api.post(`${EVIDENCE}/${id}/release`, {})),
    // DELETE /vms/evidence/{id} → 204 (hard delete; prefer release for the trail).
    remove: (id) => unwrap(api.delete(`${EVIDENCE}/${id}`)),
    // GET /vms/evidence/check?camera_id=&ts= (or &from=&to=) → { camera_id, locked }.
    check: (params = {}) => unwrap(api.get(`${EVIDENCE}/check${qs(params)}`)),
  },

  // ── Smart / forensic motion search (G4) — VMD over recorded footage ──────
  // Find motion inside drawn region(s) over a time window in a camera's recorded
  // segments (ffmpeg motion/scene energy on the cropped region — NOT AI). An async
  // job: start → poll → hit intervals. Regions are NORMALIZED 0..1 ({x,y}=top-left,
  // {w,h}=size); an empty regions[] = whole frame. Both start + poll gate on
  // vms.playback.view; tenant-scoped. Hit timestamps are ISO-8601 UTC.
  motionSearch: {
    // POST /vms/cameras/{id}/motion-search
    //   { from, to, regions:[{x,y,w,h}], sensitivity?=0.5, sample_fps?=4.0 }
    //   → 201 { job_id, status:"queued", ... }.
    start: (cameraId, body) =>
      unwrap(api.post(`${CAMERAS}/${cameraId}/motion-search`, body)),
    // GET /vms/motion-search/{job_id} → { status:"queued"|"running"|"done"|
    //   "failed", progress, hits:[{start,end,score}], note, error }.
    get: (jobId) => unwrap(api.get(`/vms/motion-search/${jobId}`)),
    // Poll `get(jobId)` every `intervalMs` until the job reaches a terminal state
    // (done|failed) or `signal` aborts. `onTick(job)` fires each poll so the caller
    // can render progress. Resolves with the terminal job (or rejects on abort).
    poll: (jobId, { intervalMs = 1500, onTick, signal } = {}) =>
      new Promise((resolve, reject) => {
        let stopped = false;
        const stop = () => {
          stopped = true;
        };
        if (signal) {
          if (signal.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
          }
          signal.addEventListener("abort", () => {
            stop();
            reject(new DOMException("Aborted", "AbortError"));
          });
        }
        const tick = async () => {
          if (stopped) return;
          try {
            const job = await vms.motionSearch.get(jobId);
            if (stopped) return;
            onTick?.(job);
            if (job?.status === "done" || job?.status === "failed") {
              resolve(job);
              return;
            }
            setTimeout(tick, intervalMs);
          } catch (e) {
            if (!stopped) reject(e);
          }
        };
        tick();
      }),
  },

  // ── ONVIF-server config (P6-C) — expose OUR cameras to a 3rd-party VMS ────
  // Per-tenant interop: Milestone/Genetec/etc. pull our cameras over ONVIF.
  // Public shape: { id, enabled, exposed_camera_ids[] ("*"=all), service_username,
  //   password_set, device_name, advertised_host, advertised_http_port,
  //   advertised_rtsp_port }. service_password is WRITE-ONLY. Gate: vms.config.manage.
  onvifServer: {
    // GET /vms/onvif-server/config → the config (or a transient default).
    getConfig: () => unwrap(api.get(`${ONVIF_SERVER}/config`)),
    // PUT /vms/onvif-server/config { enabled?, exposed_camera_ids?, service_username?,
    //   service_password?, device_name?, advertised_host?, advertised_http_port?,
    //   advertised_rtsp_port? } — PATCH semantics; omit unchanged secrets.
    setConfig: (body) => unwrap(api.put(`${ONVIF_SERVER}/config`, body)),
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
