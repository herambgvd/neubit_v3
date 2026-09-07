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
import type { AxiosResponse } from "axios";

import { api } from "@/lib/api";
import type { QueryParams } from "@/lib/types";

import type {
  ClearCellBody,
  DecoderCreate,
  DecoderListResponse,
  DecoderPublic,
  DecoderTestResult,
  DecoderUpdate,
  MonitorCreate,
  MonitorListResponse,
  MonitorUpdate,
  PresetCreate,
  PresetListResponse,
  PresetPublic,
  PresetUpdate,
  PushCellBody,
  TourCreate,
  TourListResponse,
  TourPublic,
  TourUpdate,
  WallCreate,
  WallListResponse,
  WallMonitor,
  WallPublic,
  WallStateResponse,
  WallUpdate,
} from "./types";

const WALLS = "/vms/walls";
const DECODERS = "/vms/decoders";

const unwrap = <T>(p: Promise<AxiosResponse<T>>): Promise<T> => p.then((r) => r.data);

// Drop null/undefined/"" so URLSearchParams doesn't emit empty filters.
function qs(params: QueryParams = {}): string {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") clean[k] = String(v);
  }
  const s = new URLSearchParams(clean).toString();
  return s ? `?${s}` : "";
}

export const videowall = {
  // ── Walls ────────────────────────────────────────────────────────────
  walls: {
    // GET /walls → { items, total, skip, limit }. Filter: site_id + skip/limit.
    list: (params: QueryParams = {}) => unwrap(api.get<WallListResponse>(`${WALLS}${qs(params)}`)),
    get: (id: string) => unwrap(api.get<WallPublic>(`${WALLS}/${id}`)),
    // POST /walls { name, description?, site_id?, rows, cols, is_active }.
    create: (body: WallCreate) => unwrap(api.post<WallPublic>(WALLS, body)),
    update: (id: string, body: WallUpdate) => unwrap(api.patch<WallPublic>(`${WALLS}/${id}`, body)),
    remove: (id: string) => unwrap(api.delete<void>(`${WALLS}/${id}`)),
  },

  // ── Monitors ─────────────────────────────────────────────────────────
  // A monitor: { id, wall_id, name, position, kind (browser|decoder),
  //   layout (1|4|9|16), decoder_id?, decoder_channel? }.
  monitors: {
    list: (wallId: string) => unwrap(api.get<MonitorListResponse>(`${WALLS}/${wallId}/monitors`)),
    create: (wallId: string, body: MonitorCreate) =>
      unwrap(api.post<WallMonitor>(`${WALLS}/${wallId}/monitors`, body)),
    update: (wallId: string, monitorId: string, body: MonitorUpdate) =>
      unwrap(api.patch<WallMonitor>(`${WALLS}/${wallId}/monitors/${monitorId}`, body)),
    remove: (wallId: string, monitorId: string) =>
      unwrap(api.delete<void>(`${WALLS}/${wallId}/monitors/${monitorId}`)),
  },

  // ── Live shared state ────────────────────────────────────────────────
  state: {
    // GET /walls/{id}/state → { wall_id, state }.
    get: (wallId: string) => unwrap(api.get<WallStateResponse>(`${WALLS}/${wallId}/state`)),
    // POST /walls/{id}/state/push { monitor_id, cell_index, camera_id } → new full state.
    push: (wallId: string, { monitor_id, cell_index, camera_id }: PushCellBody) =>
      unwrap(
        api.post<WallStateResponse>(`${WALLS}/${wallId}/state/push`, {
          monitor_id,
          cell_index,
          camera_id,
        }),
      ),
    // POST /walls/{id}/state/clear { monitor_id, cell_index? } — omit cell to clear a whole monitor.
    clear: (wallId: string, { monitor_id, cell_index = null }: ClearCellBody) =>
      unwrap(
        api.post<WallStateResponse>(`${WALLS}/${wallId}/state/clear`, {
          monitor_id,
          ...(cell_index != null ? { cell_index } : {}),
        }),
      ),
  },

  // ── Presets (saved wall snapshots) ───────────────────────────────────
  presets: {
    list: (wallId: string) => unwrap(api.get<PresetListResponse>(`${WALLS}/${wallId}/presets`)),
    // POST /walls/{id}/presets { name, is_default?, state? } — omit state → snapshot live.
    create: (wallId: string, body: PresetCreate) =>
      unwrap(api.post<PresetPublic>(`${WALLS}/${wallId}/presets`, body)),
    update: (wallId: string, presetId: string, body: PresetUpdate) =>
      unwrap(api.patch<PresetPublic>(`${WALLS}/${wallId}/presets/${presetId}`, body)),
    remove: (wallId: string, presetId: string) =>
      unwrap(api.delete<void>(`${WALLS}/${wallId}/presets/${presetId}`)),
    // POST /walls/{id}/presets/{pid}/apply → recall the preset onto the live wall.
    apply: (wallId: string, presetId: string) =>
      unwrap(api.post<WallStateResponse>(`${WALLS}/${wallId}/presets/${presetId}/apply`, {})),
  },

  // ── Tours (preset cycles) ────────────────────────────────────────────
  tours: {
    list: (wallId: string) => unwrap(api.get<TourListResponse>(`${WALLS}/${wallId}/tours`)),
    // POST /walls/{id}/tours { name, preset_ids[], dwell_seconds }.
    create: (wallId: string, body: TourCreate) =>
      unwrap(api.post<TourPublic>(`${WALLS}/${wallId}/tours`, body)),
    update: (wallId: string, tourId: string, body: TourUpdate) =>
      unwrap(api.patch<TourPublic>(`${WALLS}/${wallId}/tours/${tourId}`, body)),
    remove: (wallId: string, tourId: string) =>
      unwrap(api.delete<void>(`${WALLS}/${wallId}/tours/${tourId}`)),
    start: (wallId: string, tourId: string) =>
      unwrap(api.post<TourPublic>(`${WALLS}/${wallId}/tours/${tourId}/start`, {})),
    stop: (wallId: string, tourId: string) =>
      unwrap(api.post<TourPublic>(`${WALLS}/${wallId}/tours/${tourId}/stop`, {})),
  },

  // ── Decoders (VW-B — LIVE, confirmed against decoder_router.py) ───────
  // Public shape: { id, name, brand (hikvision|dahua_cpplus), host, port,
  //   username, has_password, channel_count, is_enabled }. `password` is
  //   WRITE-ONLY (sent on create/update, never returned — has_password flags it).
  decoders: {
    list: (params: QueryParams = {}) =>
      unwrap(api.get<DecoderListResponse>(`${DECODERS}${qs(params)}`)),
    get: (id: string) => unwrap(api.get<DecoderPublic>(`${DECODERS}/${id}`)),
    create: (body: DecoderCreate) => unwrap(api.post<DecoderPublic>(DECODERS, body)),
    update: (id: string, body: DecoderUpdate) =>
      unwrap(api.patch<DecoderPublic>(`${DECODERS}/${id}`, body)),
    remove: (id: string) => unwrap(api.delete<void>(`${DECODERS}/${id}`)),
    // POST /vms/decoders/{id}/test → a live probe of the appliance:
    //   { reachable, manufacturer?, model?, firmware?, serial_number?,
    //     channel_count, error? }.
    test: (id: string) => unwrap(api.post<DecoderTestResult>(`${DECODERS}/${id}/test`, {})),
  },
};

export default videowall;
