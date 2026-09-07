// Wire types local to the video-wall feature (walls, monitors, live state,
// presets, tours, decoders, and the wall SSE frame). Each interface mirrors one
// Pydantic model — the backend file is named per block. Dates cross the wire as
// ISO-8601 strings, never Date objects. Shapes shared across features live in
// @/lib/types.
//
// `WallMonitor` predates this module and stays in ./wallLayout (the layout math
// imports it); it is re-exported here so a caller has one place to reach for.
import type { WallMonitor } from "./wallLayout";

export type { WallMonitor };

/* --- video wall (backend/vision/app/vms/videowall/schemas.py) -------------- */

/** `WallState` — a wall's live/preset blob: `{monitor_id: {cell_index_str: camera_id}}`.
 *  Cell keys are STRINGS (JSON object keys), never numbers. */
export type WallState = Record<string, Record<string, string>>;

/** `MonitorKind`. */
export type MonitorKind = "browser" | "decoder";

/** `MonitorCreate.layout` — the cell count of a monitor's own grid. */
export type MonitorLayout = 1 | 4 | 9 | 16;

/** `WallPublic` — a video wall as the vision service returns it. */
export interface WallPublic {
  id: string;
  name: string;
  description: string | null;
  site_id: string | null;
  /** Rows of MONITORS in the wall grid. */
  rows: number;
  /** Columns of MONITORS in the wall grid. */
  cols: number;
  is_active: boolean;
  state: WallState;
  created_at: string;
  updated_at: string;
}

/** `WallCreate` — the new-wall form body. */
export interface WallCreate {
  name: string;
  description?: string | null;
  site_id?: string | null;
  rows?: number;
  cols?: number;
  is_active?: boolean;
}

/** `WallUpdate` — PATCH semantics; only sent fields change. */
export type WallUpdate = Partial<WallCreate>;

/** `WallListResponse`. */
export interface WallListResponse {
  items: WallPublic[];
  total: number;
  skip: number;
  limit: number;
}

/* --- monitors -------------------------------------------------------------- */

/** `MonitorCreate` — the add-monitor form body. */
export interface MonitorCreate {
  name: string;
  position?: number;
  kind?: MonitorKind;
  layout?: MonitorLayout;
  /** Supplied only for `kind: "decoder"`. */
  decoder_id?: string | null;
  decoder_channel?: number | null;
}

/** `MonitorUpdate` — PATCH semantics. */
export type MonitorUpdate = Partial<MonitorCreate>;

/** `MonitorListResponse`. */
export interface MonitorListResponse {
  items: WallMonitor[];
  total: number;
}

/* --- live state mutations -------------------------------------------------- */

/** `WallStateResponse` — what `GET /walls/{id}/state` and every mutation return. */
export interface WallStateResponse {
  wall_id: string;
  state: WallState;
}

/** `PushCellBody`. */
export interface PushCellBody {
  monitor_id: string;
  cell_index: number;
  camera_id: string;
}

/** `ClearCellBody` — omit/null `cell_index` to clear a whole monitor. */
export interface ClearCellBody {
  monitor_id: string;
  cell_index?: number | null;
}

/* --- presets --------------------------------------------------------------- */

/** `PresetPublic` — a saved wall snapshot. */
export interface PresetPublic {
  id: string;
  wall_id: string;
  name: string;
  is_default: boolean;
  state: WallState;
  created_at: string;
  updated_at: string;
}

/** `PresetCreate` — `state` omitted → the server snapshots the CURRENT live state. */
export interface PresetCreate {
  name: string;
  is_default?: boolean;
  state?: WallState | null;
}

/** `PresetUpdate` — PATCH semantics. */
export type PresetUpdate = Partial<PresetCreate>;

/** `PresetListResponse`. */
export interface PresetListResponse {
  items: PresetPublic[];
  total: number;
}

/* --- tours ----------------------------------------------------------------- */

/** `TourPublic` — an ordered preset cycle the server runs on a dwell. */
export interface TourPublic {
  id: string;
  wall_id: string;
  name: string;
  preset_ids: string[];
  dwell_seconds: number;
  is_running: boolean;
  created_at: string;
  updated_at: string;
}

/** `TourCreate`. */
export interface TourCreate {
  name: string;
  preset_ids?: string[];
  dwell_seconds?: number;
}

/** `TourUpdate` — PATCH semantics. */
export type TourUpdate = Partial<TourCreate>;

/** `TourListResponse`. */
export interface TourListResponse {
  items: TourPublic[];
  total: number;
}

/* --- decoders (backend/vision/app/vms/videowall/decoder_schemas.py) --------- */

/** `DecoderBrand`. */
export type DecoderBrand = "hikvision" | "dahua_cpplus";

/** `DecoderPublic` — the password is NEVER returned; `has_password` flags one. */
export interface DecoderPublic {
  id: string;
  name: string;
  brand: string;
  host: string;
  port: number;
  username: string | null;
  has_password: boolean;
  channel_count: number;
  is_enabled: boolean;
  created_at: string;
  updated_at: string;
}

/** `DecoderCreate` — `password` is write-only (accepted, never echoed back). */
export interface DecoderCreate {
  name: string;
  brand?: DecoderBrand;
  host: string;
  port?: number;
  username?: string | null;
  password?: string | null;
  channel_count?: number;
  is_enabled?: boolean;
}

/** `DecoderUpdate` — PATCH semantics. */
export type DecoderUpdate = Partial<DecoderCreate>;

/** `DecoderListResponse`. */
export interface DecoderListResponse {
  items: DecoderPublic[];
  total: number;
}

/** `DecoderTestResult` — a live probe of the appliance. */
export interface DecoderTestResult {
  reachable: boolean;
  manufacturer?: string | null;
  model?: string | null;
  firmware?: string | null;
  serial_number?: string | null;
  channel_count: number;
  error?: string | null;
}

/* --- the wall SSE frame (backend/core/app/core/realtime_wall.py) ------------ */

/** The `wall.state` payload: `{wall_id, state, rows?, cols?, action?, actor_id?,
 *  tenant_id}` (broadcast built in vision's videowall/service.py `_broadcast`). */
export interface WallStateFrame {
  wall_id?: string;
  state?: WallState;
  rows?: number | null;
  cols?: number | null;
  /** What the actor did ("push" / "clear" / "preset.apply" …). */
  action?: string | null;
  actor_id?: string | null;
}

/** The envelope a consumer keeps off the last frame — who changed the wall and
 *  how, without the state blob. */
export interface WallFrameMeta {
  action: string | null;
  actor_id: string | null;
  rows: number | null;
  cols: number | null;
}

/** Narrow a parsed SSE payload (genuinely `unknown` — it is whatever JSON the
 *  server sent) to a wall frame. Only the object-ness is checked here; each
 *  field is read defensively at the use site. */
export function isWallStateFrame(v: unknown): v is WallStateFrame {
  return typeof v === "object" && v !== null;
}
