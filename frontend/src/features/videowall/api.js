"use client";

// Video-wall API module (VW-D) — walls, monitors, live shared state, presets,
// tours, and (VW-B) hardware decoders. Wraps the shared `api` axios instance
// (baseURL already "/api/v1") and unwraps `.data`, same convention as
// features/vms/api.js. The gateway routes "/api/v1/vms/*" → the `vision` service.
//
// Backend contract (VW-A, live under /api/v1/vms):
//   Walls:     GET/POST /walls · GET/PATCH/DELETE /walls/{id}
//   Monitors:  GET/POST /walls/{id}/monitors · PATCH/DELETE /walls/{id}/monitors/{mid}
//   State:     GET /walls/{id}/state
//              POST /walls/{id}/state/push  { monitor_id, cell_index, camera_id }
//              POST /walls/{id}/state/clear { monitor_id, cell_index? }
//              POST /walls/{id}/presets/{pid}/apply
//   Presets:   GET/POST /walls/{id}/presets · PATCH/DELETE /walls/{id}/presets/{pid}
//   Tours:     GET/POST /walls/{id}/tours · PATCH/DELETE /walls/{id}/tours/{tid}
//              POST /walls/{id}/tours/{tid}/start|stop
//
// State shape (atomic blob, replaced wholesale on every SSE frame):
//   { monitor_id: { cell_index(str): camera_id } }
//
// Perms: vms.wall.view (read) · vms.wall.control (state/tour/preset-save) ·
//   vms.wall.manage (wall/monitor/decoder/preset/tour CRUD).
//
// ── Decoders (VW-B) ──────────────────────────────────────────────────────────
// VW-B is being built in parallel and had NOT landed in the vision router at the
// time this UI was written (confirmed by reading videowall/router.py — no decoder
// endpoints). We bind to the DOCUMENTED shape (`/vms/decoders`, brand/host/port/
// username/password write-only/channel_count + a probe action) and the caller
// gates the decoder UI so it degrades cleanly (a 404 surfaces as "decoder API not
// available yet"). If VW-B lands at a different path, only DECODERS below changes.
import { api } from "@/lib/api";

const WALLS = "/vms/walls";
const DECODERS = "/vms/decoders";

const unwrap = (p) => p.then((r) => r.data);

function qs(params = {}) {
  const clean = {};
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") clean[k] = v;
  }
  const s = new URLSearchParams(clean).toString();
  return s ? `?${s}` : "";
}

export const videowall = {
  // ── Walls ────────────────────────────────────────────────────────────
  walls: {
    // GET /walls → { items, total, skip, limit }. Filter: site_id + skip/limit.
    list: (params = {}) => unwrap(api.get(`${WALLS}${qs(params)}`)),
    get: (id) => unwrap(api.get(`${WALLS}/${id}`)),
    // POST /walls { name, description?, site_id?, rows, cols, is_active }.
    create: (body) => unwrap(api.post(WALLS, body)),
    update: (id, body) => unwrap(api.patch(`${WALLS}/${id}`, body)),
    remove: (id) => unwrap(api.delete(`${WALLS}/${id}`)),
  },

  // ── Monitors ─────────────────────────────────────────────────────────
  // A monitor: { id, wall_id, name, position, kind (browser|decoder),
  //   layout (1|4|9|16), decoder_id?, decoder_channel? }.
  monitors: {
    list: (wallId) => unwrap(api.get(`${WALLS}/${wallId}/monitors`)),
    create: (wallId, body) => unwrap(api.post(`${WALLS}/${wallId}/monitors`, body)),
    update: (wallId, monitorId, body) =>
      unwrap(api.patch(`${WALLS}/${wallId}/monitors/${monitorId}`, body)),
    remove: (wallId, monitorId) =>
      unwrap(api.delete(`${WALLS}/${wallId}/monitors/${monitorId}`)),
  },

  // ── Live shared state ────────────────────────────────────────────────
  state: {
    // GET /walls/{id}/state → { wall_id, state }.
    get: (wallId) => unwrap(api.get(`${WALLS}/${wallId}/state`)),
    // POST /walls/{id}/state/push { monitor_id, cell_index, camera_id } → new full state.
    push: (wallId, { monitor_id, cell_index, camera_id }) =>
      unwrap(api.post(`${WALLS}/${wallId}/state/push`, { monitor_id, cell_index, camera_id })),
    // POST /walls/{id}/state/clear { monitor_id, cell_index? } — omit cell to clear a whole monitor.
    clear: (wallId, { monitor_id, cell_index = null }) =>
      unwrap(
        api.post(`${WALLS}/${wallId}/state/clear`, { monitor_id, ...(cell_index != null ? { cell_index } : {}) }),
      ),
  },

  // ── Presets (saved wall snapshots) ───────────────────────────────────
  presets: {
    list: (wallId) => unwrap(api.get(`${WALLS}/${wallId}/presets`)),
    // POST /walls/{id}/presets { name, is_default?, state? } — omit state → snapshot live.
    create: (wallId, body) => unwrap(api.post(`${WALLS}/${wallId}/presets`, body)),
    update: (wallId, presetId, body) =>
      unwrap(api.patch(`${WALLS}/${wallId}/presets/${presetId}`, body)),
    remove: (wallId, presetId) =>
      unwrap(api.delete(`${WALLS}/${wallId}/presets/${presetId}`)),
    // POST /walls/{id}/presets/{pid}/apply → recall the preset onto the live wall.
    apply: (wallId, presetId) =>
      unwrap(api.post(`${WALLS}/${wallId}/presets/${presetId}/apply`, {})),
  },

  // ── Tours (preset cycles) ────────────────────────────────────────────
  tours: {
    list: (wallId) => unwrap(api.get(`${WALLS}/${wallId}/tours`)),
    // POST /walls/{id}/tours { name, preset_ids[], dwell_seconds }.
    create: (wallId, body) => unwrap(api.post(`${WALLS}/${wallId}/tours`, body)),
    update: (wallId, tourId, body) =>
      unwrap(api.patch(`${WALLS}/${wallId}/tours/${tourId}`, body)),
    remove: (wallId, tourId) =>
      unwrap(api.delete(`${WALLS}/${wallId}/tours/${tourId}`)),
    start: (wallId, tourId) => unwrap(api.post(`${WALLS}/${wallId}/tours/${tourId}/start`, {})),
    stop: (wallId, tourId) => unwrap(api.post(`${WALLS}/${wallId}/tours/${tourId}/stop`, {})),
  },

  // ── Decoders (VW-B — LIVE, confirmed against decoder_router.py) ───────
  // Public shape: { id, name, brand (hikvision|dahua_cpplus), host, port,
  //   username, has_password, channel_count, is_enabled }. `password` is
  //   WRITE-ONLY (sent on create/update, never returned — has_password flags it).
  decoders: {
    list: (params = {}) => unwrap(api.get(`${DECODERS}${qs(params)}`)),
    get: (id) => unwrap(api.get(`${DECODERS}/${id}`)),
    create: (body) => unwrap(api.post(DECODERS, body)),
    update: (id, body) => unwrap(api.patch(`${DECODERS}/${id}`, body)),
    remove: (id) => unwrap(api.delete(`${DECODERS}/${id}`)),
    // POST /vms/decoders/{id}/test → a live probe of the appliance:
    //   { reachable, manufacturer?, model?, firmware?, serial_number?,
    //     channel_count, error? }.
    test: (id) => unwrap(api.post(`${DECODERS}/${id}/test`, {})),
  },
};

export default videowall;
