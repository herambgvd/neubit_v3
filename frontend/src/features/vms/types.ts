// VMS wire types — one interface per Pydantic model in backend/vision/app/vms/**/
// schemas.py, the backend file named per block. Feature-local: only the shapes
// this console's video surfaces consume. The generic ones (CameraPublic,
// NvrPublic, OnvifPublic, FederatedCamera, Paged, QueryParams) live in
// src/lib/types.ts and are re-exported here for convenience.
//
// Conventions (same as src/lib/types.ts): dates cross the wire as ISO-8601
// strings; `dict[str, Any]` becomes `Record<string, unknown>` unless the backend
// documents a narrower map; write-only credentials appear only on request bodies.
import type { CameraPublic, NvrPublic, Paged } from "@/lib/types";

export type { CameraPublic, FederatedCamera, FederatedCameraList, NvrPublic, OnvifPublic, Paged, QueryParams } from "@/lib/types";

/** The `{ items, total }` envelope the non-skip/limit list endpoints use. */
export interface ItemList<T> {
  items: T[];
  total: number;
}

/* --- common literals (backend/vision/app/vms/common/schemas.py) ------------ */

export type CameraStatus = "online" | "offline" | "connecting" | "error";
export type ConnectionType = "rtsp" | "onvif" | "nvr_channel";
export type ProfileName = "main" | "sub" | "third";
export type AclSubjectType = "role" | "user" | "group";
export type AclPrivilege = "view_live" | "playback" | "export" | "ptz" | "config";
/** Camera-group grid enum (shared with the wall's group layouts). */
export type GridLayout = "1x1" | "2x2" | "3x3" | "4x3" | "4x4" | "6x4" | "6x5" | "6x6" | "8x8";

/* --- cameras (backend/vision/app/vms/cameras/schemas.py) ------------------- */

// The nested config blocks are `type` aliases (not interfaces) on purpose: an
// object-literal type carries an implicit index signature, so each stays
// assignable to the `Record<string, unknown>` slot lib/types' CameraPublic
// reserves for it and `VmsCameraPublic` below can extend that shape.
export type NetworkInfo = {
  ip?: string | null;
  port?: number | null;
  rtsp_port?: number | null;
  mac?: string | null;
};

/** `OnvifConfig` — the write side of `OnvifPublic`; `password` is write-only. */
export interface OnvifConfig {
  host?: string | null;
  port?: number | null;
  user?: string | null;
  password?: string | null;
  profile_token?: string | null;
}

export type RecordingMode = "continuous" | "schedule" | "motion" | "event" | "manual";

export type RecordingConfig = {
  mode?: RecordingMode;
  schedule?: Record<string, unknown>;
  fps?: number | null;
  record_substream?: boolean;
  retention_days?: number;
  pre_buffer_seconds?: number;
  post_buffer_seconds?: number;
  anr_enabled?: boolean;
  audio_enabled?: boolean;
};

/** A NORMALIZED (0..1) drawn shape — a rect or a polygon; motion zones may
 *  also carry `sensitivity` / `threshold`. */
export interface DrawnRect {
  type?: "rect";
  x: number;
  y: number;
  w: number;
  h: number;
  sensitivity?: number;
  threshold?: number;
}
export interface DrawnPolygon {
  type: "polygon";
  points: [number, number][];
  sensitivity?: number;
  threshold?: number;
}

/** A drawn region on a camera's frame — a rectangle or a polygon. Still here because
 *  the camera row carries the shapes; what is gone is the console pushing them TO the
 *  device, which is the recorder's write. */
export type DrawnShape = DrawnRect | DrawnPolygon;

export type AdvancedConfig = {
  privacy_masks?: DrawnShape[];
  motion_zones?: DrawnShape[];
  motion_config?: Record<string, unknown>;
  backchannel?: Record<string, unknown>;
};

export type PtzConfig = {
  capable?: boolean;
  presets?: Record<string, unknown>[];
};

export type Placement = {
  site_id?: string | null;
  floor_id?: string | null;
  zone_id?: string | null;
};

export interface MediaProfileCreate {
  name?: ProfileName;
  codec?: string | null;
  resolution?: string | null;
  fps?: number | null;
  rtsp_path?: string | null;
  bitrate?: number | null;
}

export type MediaProfilePublic = {
  id: string;
  camera_id: string;
  name: string;
  codec?: string | null;
  resolution?: string | null;
  fps?: number | null;
  rtsp_path?: string | null;
  bitrate?: number | null;
  created_at: string;
  updated_at: string;
};

/** `CameraPublic` with the nested config blocks this feature reads spelled out
 *  (lib/types keeps them opaque). Structurally a subtype of lib's CameraPublic. */
export interface VmsCameraPublic extends CameraPublic {
  network_info: NetworkInfo;
  recording: RecordingConfig;
  advanced: AdvancedConfig;
  ptz: PtzConfig;
  placement: Placement;
  media_profiles: MediaProfilePublic[];
}

export interface CameraCreate {
  name: string;
  is_enabled?: boolean;
  brand?: string;
  driver?: string | null;
  connection_type?: ConnectionType;
  network_info?: NetworkInfo;
  onvif?: OnvifConfig | null;
  recording?: RecordingConfig;
  advanced?: AdvancedConfig;
  ptz?: PtzConfig;
  placement?: Placement;
  media_profiles?: MediaProfileCreate[];
  nvr_id?: string | null;
  nvr_channel_number?: number | null;
  storage_pool_id?: string | null;
  media_node_id?: string | null;
  display_order?: number;
}

export type CameraUpdate = Partial<CameraCreate>;

export type CameraListResponse = Paged<VmsCameraPublic>;

export interface CameraReorderItem {
  id: string;
  display_order: number;
}

export type CameraBulkAction = "enable" | "disable" | "group" | "retention" | "assign_node" | "delete";

export interface CameraBulkBody {
  camera_ids: string[];
  action: CameraBulkAction;
  group_id?: string | null;
  retention_days?: number | null;
  media_node_id?: string | null;
}

export interface BulkResult {
  affected: number;
}
export interface ReorderResult {
  reordered: number;
}

export interface DiscoverBody {
  network?: string | null;
  brand?: string | null;
}

export interface DiscoveredPublic {
  ip: string;
  port: number;
  xaddr?: string | null;
  name?: string | null;
  manufacturer?: string | null;
  model?: string | null;
  firmware?: string | null;
  serial_number?: string | null;
  mac?: string | null;
  brand: string;
  auth_required: boolean;
}

export type DiscoverResponse = ItemList<DiscoveredPublic>;

/** `ProbeBody` / `ChannelsBody` / `SnapshotBody` / `NvrChannelsBody` — the same
 *  host-credential quartet. */
export interface HostCredentials {
  host: string;
  port?: number;
  username?: string;
  password?: string;
  brand?: string | null;
}

export interface ProbeResponse {
  reachable: boolean;
  manufacturer?: string | null;
  model?: string | null;
  firmware?: string | null;
  serial_number?: string | null;
  hardware_id?: string | null;
  mac?: string | null;
  channel_count: number;
  has_ptz: boolean;
  has_imaging: boolean;
  has_events: boolean;
  has_analytics: boolean;
  has_audio: boolean;
  error?: string | null;
  capabilities: Record<string, unknown>;
}

export interface StreamInfoPublic {
  profile_token?: string | null;
  stream_url?: string | null;
  resolution?: string | null;
  fps?: number | null;
  codec?: string | null;
  bitrate?: number | null;
}

export interface ChannelPublic {
  channel: number;
  name: string;
  source_token?: string | null;
  channel_number?: number | null;
  main?: StreamInfoPublic | null;
  sub?: StreamInfoPublic | null;
  snapshot_url?: string | null;
  ptz_capable: boolean;
}

export type ChannelsResponse = ItemList<ChannelPublic>;

export interface BulkAddChannel {
  channel_number?: number | null;
  name?: string | null;
  profile_token?: string | null;
  nvr_id?: string | null;
  site_id?: string | null;
  floor_id?: string | null;
}

export interface BulkAddBody extends HostCredentials {
  brand: string;
  channels: BulkAddChannel[];
}

/** `POST /cameras/onvif/bulk-add` → the created cameras (router returns
 *  `{ items, total }` or a bare list; consumers go through `asItems`). */
export type BulkAddResponse = ItemList<VmsCameraPublic> | VmsCameraPublic[];

export type PtzAction =
  | "continuous"
  | "stop"
  | "relative"
  | "absolute"
  | "goto_preset"
  | "set_preset"
  | "delete_preset"
  | "get_presets";









/* --- NVRs (backend/vision/app/vms/nvr/schemas.py) -------------------------- */

export interface NvrCreate {
  name: string;
  is_enabled?: boolean;
  brand?: string;
  driver?: string | null;
  host: string;
  port?: number;
  username?: string;
  password?: string | null;
  channel_count?: number;
}

export type NvrUpdate = Partial<NvrCreate>;

export type NvrListResponse = Paged<NvrPublic>;

export interface MapChannelItem {
  channel_number: number;
  name?: string | null;
  profile_token?: string | null;
  add?: boolean;
  site_id?: string | null;
  floor_id?: string | null;
}

export interface MapChannelsResult {
  created: VmsCameraPublic[];
  created_count: number;
  skipped_count: number;
  nvr?: NvrPublic | null;
}

export interface NvrHealthResponse {
  nvr_id: string;
  status: string;
  is_enabled: boolean;
  channel_count: number;
  mapped_channel_count: number;
  storage_info: Record<string, unknown>;
  capabilities: Record<string, unknown>;
  last_seen_at?: string | null;
  last_error?: string | null;
}

export interface NvrRecordingRange {
  channel: number;
  start?: string | null;
  end?: string | null;
  extra: Record<string, unknown>;
}

export interface NvrRecordingsResponse {
  nvr_id: string;
  channel: number;
  items: NvrRecordingRange[];
  total: number;
  reachable: boolean;
}

export interface NvrPlaybackSession {
  nvr_id: string;
  channel: number;
  kind: string;
  from: string;
  to: string;
  hls_url?: string | null;
  webrtc_url?: string | null;
  rtsp_url?: string | null;
  token?: string | null;
  expires_at?: string | null;
  ready: boolean;
}

/* --- PTZ (backend/vision/app/vms/ptz/schemas.py) --------------------------- */

export interface PtzMoveBody {
  mode?: "continuous" | "relative" | "absolute";
  pan?: number;
  tilt?: number;
  zoom?: number;
  speed?: number;
}

export interface PtzResult {
  ok: boolean;
  result?: unknown;
}






/* --- live (backend/vision/app/vms/live/schemas.py) ------------------------- */

export interface PlaybackSessionPublic {
  session_id: string;
  camera_id: string;
  kind: string;
  profile: string;
  hls_url?: string | null;
  webrtc_url?: string | null;
  rtsp_url?: string | null;
  token: string;
  expires_at: string;
  ready: boolean;
}

/* --- audio / talk (backend/vision/app/vms/audio/schemas.py) ---------------- */


/* --- playback (backend/vision/app/vms/playback/schemas.py) ----------------- */

export interface PlaybackRange {
  start: string;
  duration: number;
  /** Present on the Go recorder's ranges (federation timeline), absent on vision's. */
  trigger_type?: string | null;
}

export interface RecordedPlaybackPublic {
  session_id: string;
  camera_id: string;
  kind: string;
  profile: string;
  hls_url?: string | null;
  token: string;
  from: string;
  to: string;
  ranges: PlaybackRange[];
  expires_at: string;
}

export interface RecordingDaysResponse {
  year: number;
  month: number;
  days: number[];
}

export interface TimelineSegment {
  start: string;
  end: string;
  trigger_type?: string | null;
}

export interface TimelineMarker {
  t: string;
  event_type: string;
  severity: string;
  event_id: string;
  camera_id?: string | null;
}

export interface TimelineResponse {
  camera_id: string;
  from: string;
  to: string;
  coverage: TimelineSegment[];
  gaps: TimelineSegment[];
  markers: TimelineMarker[];
  total_seconds: number;
}

/* --- recording (backend/vision/app/vms/recording/schemas.py) --------------- */

export interface RecordingConfigBody {
  mode?: RecordingMode;
  schedule?: Record<string, unknown>;
  retention_days?: number;
  record_substream?: boolean;
  audio_enabled?: boolean;
  storage_pool_id?: string | null;
}

export interface RecordingConfigPublic {
  camera_id: string;
  mode: string;
  schedule: Record<string, unknown>;
  retention_days: number;
  record_substream: boolean;
  audio_enabled: boolean;
  storage_pool_id?: string | null;
  recording_now: boolean;
}

export interface RecordingControlResult {
  camera_id: string;
  profile: string;
  recording: boolean;
  trigger_type?: string | null;
}

export interface RecordingPublic {
  id: string;
  camera_id: string;
  profile: string;
  path: string;
  start_time: string;
  end_time?: string | null;
  duration?: number | null;
  file_size?: number | null;
  codec?: string | null;
  resolution?: string | null;
  trigger_type: string;
  storage_pool_id?: string | null;
  checksum?: string | null;
  integrity_status: string;
  locked: boolean;
  locked_by?: string | null;
  has_motion: boolean;
  event_markers: unknown[];
  created_at: string;
}

export type RecordingListResponse = Paged<RecordingPublic>;

/** `GET /vms/recording/active` — which cameras the nvr is recording right now. */
export interface RecordingActiveResponse {
  available: boolean;
  camera_ids: string[];
}

/* --- storage (backend/vision/app/vms/storage/schemas.py) ------------------- */

export interface RecordingIntegrityResult {
  id: string;
  integrity_status: string;
  checksum?: string | null;
  locked: boolean;
  locked_by?: string | null;
}

/* --- export (backend/vision/app/vms/export/schemas.py) --------------------- */





/* --- groups + ACL (backend/vision/app/vms/groups/schemas.py) --------------- */

export interface CameraGroupCreate {
  name: string;
  color?: string | null;
  description?: string | null;
  camera_ids?: string[];
  layout?: GridLayout;
  is_active?: boolean;
}

export type CameraGroupUpdate = Partial<CameraGroupCreate>;

export interface CameraGroupPublic {
  id: string;
  name: string;
  color?: string | null;
  description?: string | null;
  camera_ids: string[];
  layout: GridLayout;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export type CameraGroupListResponse = ItemList<CameraGroupPublic>;

export interface CameraACLEntry {
  subject_type: AclSubjectType;
  subject_id: string;
  privileges: AclPrivilege[];
}

export interface CameraACLPublic {
  id: string;
  subject_type: string;
  subject_id: string;
  target_type: string;
  target_id: string;
  privileges: string[];
  created_at: string;
  updated_at: string;
}

export type CameraACLListResponse = ItemList<CameraACLPublic>;

/* --- patterns (backend/vision/app/vms/patterns/schemas.py) ----------------- */

export interface PatternCreate {
  name: string;
  description?: string | null;
  camera_group_ids?: string[];
  seconds?: number;
  is_active?: boolean;
}

export type PatternUpdate = Partial<PatternCreate>;

export interface PatternPublic {
  id: string;
  name: string;
  description?: string | null;
  camera_group_ids: string[];
  seconds: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export type PatternListResponse = ItemList<PatternPublic>;

/* --- health (backend/vision/app/vms/health/schemas.py) --------------------- */

export interface CameraHealthPublic {
  id: string;
  camera_id: string;
  status: string;
  bitrate_kbps?: number | null;
  fps_actual?: number | null;
  packet_loss?: number | null;
  latency_ms?: number | null;
  captured_at: string;
}

export type CameraHealthListResponse = ItemList<CameraHealthPublic>;
export type CameraHealthHistoryResponse = Paged<CameraHealthPublic>;

/* --- events (backend/vision/app/vms/events/schemas.py) --------------------- */

export interface VmsEventPublic {
  id: string;
  camera_id?: string | null;
  event_type: string;
  severity: string;
  source: string;
  title: string;
  description?: string | null;
  raw: Record<string, unknown>;
  occurred_at: string;
  published: boolean;
  acknowledged: boolean;
  acknowledged_by?: string | null;
  acknowledged_at?: string | null;
  snapshot_path?: string | null;
  recording_id?: string | null;
  created_at: string;
}

export type VmsEventListResponse = Paged<VmsEventPublic>;

/** A live SSE frame — the same row plus the aliases the realtime bridge uses;
 *  `normalizeVmsEvent` folds either into a `VmsEventPublic`-shaped record. */
export interface VmsEventFrame extends Partial<VmsEventPublic> {
  event_id?: string;
  timestamp?: string;
  camera_name?: string | null;
}

/* --- linkage (backend/vision/app/vms/linkage/schemas.py) ------------------- */

export type LinkageActionType =
  | "start_recording"
  | "notify"
  | "ptz_preset"
  | "trigger_output"
  | "popup"
  | "wall_display";

export interface LinkageAction {
  type: LinkageActionType | string;
  config: Record<string, unknown>;
}

/** `camera_scope` — `{ scope: "all" | "cameras" | "groups", camera_ids?, group_ids? }`. */
export interface LinkageCameraScope {
  scope?: string;
  camera_ids?: string[];
  group_ids?: string[];
}

/** `schedule` — `{ days: { mon: [["08:00","18:00"], …] } }`-style weekly windows
 *  (editor-defined; the backend stores the dict verbatim). */
export type LinkageSchedule = Record<string, unknown>;

export interface LinkageRuleCreate {
  name: string;
  description?: string | null;
  is_active?: boolean;
  trigger_event_type: string;
  trigger_filter?: Record<string, unknown>;
  camera_scope?: LinkageCameraScope;
  actions?: LinkageAction[];
  cooldown_seconds?: number;
  schedule?: LinkageSchedule;
}

export type LinkageRuleUpdate = Partial<LinkageRuleCreate>;

export interface LinkageRulePublic {
  id: string;
  name: string;
  description?: string | null;
  is_active: boolean;
  trigger_event_type: string;
  trigger_filter: Record<string, unknown>;
  camera_scope: LinkageCameraScope;
  actions: LinkageAction[];
  cooldown_seconds: number;
  schedule: LinkageSchedule;
  created_by?: string | null;
  created_at: string;
  updated_at: string;
}

export type LinkageRuleListResponse = Paged<LinkageRulePublic>;

export interface LinkageFirePublic {
  id: string;
  rule_id: string;
  rule_name?: string | null;
  trigger_event_type: string;
  source_event_id?: string | null;
  camera_id?: string | null;
  door_ref?: string | null;
  actions_result: Record<string, unknown>[];
  recording_id?: string | null;
  fired_at: string;
}

export type LinkageFireListResponse = Paged<LinkageFirePublic>;

/* --- bookmarks (backend/vision/app/vms/bookmarks/schemas.py) --------------- */

export interface BookmarkCreate {
  camera_id: string;
  start_ts: string;
  end_ts?: string | null;
  title: string;
  note?: string | null;
  tags?: string[];
}

export type BookmarkUpdate = Partial<Omit<BookmarkCreate, "camera_id">>;

export interface BookmarkPublic {
  id: string;
  camera_id: string;
  start_ts: string;
  end_ts?: string | null;
  title: string;
  note?: string | null;
  tags: string[];
  created_by?: string | null;
  created_at: string;
  updated_at: string;
}

export type BookmarkListResponse = ItemList<BookmarkPublic>;

/* --- evidence (backend/vision/app/vms/evidence/schemas.py) ----------------- */

export interface EvidenceLockCreate {
  camera_id: string;
  start_ts: string;
  end_ts: string;
  reason?: string | null;
  case_ref?: string | null;
}

export interface EvidenceLockPublic {
  id: string;
  camera_id: string;
  start_ts: string;
  end_ts: string;
  reason?: string | null;
  case_ref?: string | null;
  is_active: boolean;
  created_by?: string | null;
  created_at: string;
  released_by?: string | null;
  released_at?: string | null;
}

export type EvidenceLockListResponse = ItemList<EvidenceLockPublic>;

export interface EvidenceCheckResult {
  camera_id: string;
  locked: boolean;
}

/* --- motion search (backend/vision/app/vms/motion_search/schemas.py) ------- */

export interface MotionRegion {
  x: number;
  y: number;
  w: number;
  h: number;
}


export interface MotionHit {
  start: string;
  end: string;
  score: number;
}


/* --- device management (backend/vision/app/vms/devicemgmt/schemas.py) ------ */





/** `GET /cameras/{id}/users` — the ONVIF device accounts (driver-shaped rows;
 *  `{ items }` or a bare list, consumers go through `asItems`). */
export interface DeviceUserPublic {
  username?: string;
  user?: string;
  name?: string;
  level?: string | null;
  [k: string]: unknown;
}



/* --- reports (backend/vision/app/vms/reports/schemas.py) ------------------- */

export type ReportKind =
  | "camera-uptime"
  | "recording-coverage"
  | "storage-usage"
  | "event-stats"
  | "health-summary";

/** `ReportResponse` — the computed report dict. Rows are kind-specific, so a
 *  row is an open record; the totals/by-* maps are documented per kind in the
 *  Reports view. */
export interface ReportResponse {
  kind: string;
  window: { from: string; to: string; seconds?: number };
  rows: Record<string, unknown>[];
  totals: Record<string, unknown>;
  by_type?: Record<string, number>;
  by_severity?: Record<string, number>;
  status_counts?: Record<string, number>;
  [k: string]: unknown;
}

export interface ReportScheduleCreate {
  name: string;
  kind: string;
  cadence?: string;
  export_format?: string;
  recipients?: string[];
  filters?: Record<string, unknown>;
  channel?: string;
  enabled?: boolean;
  hour_utc?: number;
}

export type ReportScheduleUpdate = Partial<ReportScheduleCreate>;

export interface ReportSchedulePublic {
  id: string;
  name: string;
  kind: string;
  cadence: string;
  export_format: string;
  recipients: string[];
  filters: Record<string, unknown>;
  channel: string;
  enabled: boolean;
  hour_utc: number;
  last_run_at?: string | null;
  next_run_at?: string | null;
  last_error?: string | null;
  run_count: number;
  created_at: string;
}

export type ReportScheduleList = ItemList<ReportSchedulePublic>;

export interface ReportRunPublic {
  id: string;
  schedule_id?: string | null;
  name: string;
  kind: string;
  export_format: string;
  window: { from?: string; to?: string; [k: string]: unknown };
  status: "done" | "error" | string;
  output_size: number;
  error?: string | null;
  computed_at: string;
  notified_at?: string | null;
}

export type ReportRunList = ItemList<ReportRunPublic>;

/* --- media nodes (backend/vision/app/vms/media_nodes/schemas.py) ----------- */

export type NodeStatus = "online" | "offline" | "draining" | "error" | "unknown";

export interface MediaNodeCreate {
  name: string;
  api_url: string;
  hls_base?: string | null;
  webrtc_base?: string | null;
  rtsp_base?: string | null;
  label?: string | null;
  capacity_channels?: number;
  host?: string | null;
  pairing_code?: string | null;
}

export interface MediaNodeUpdate extends Partial<Omit<MediaNodeCreate, "pairing_code">> {
  status?: NodeStatus | string | null;
}

export interface MediaNodePublic {
  id: string;
  name: string;
  host: string;
  api_url?: string | null;
  hls_base?: string | null;
  webrtc_base?: string | null;
  rtsp_base?: string | null;
  label?: string | null;
  capacity_channels: number;
  used_channels: number;
  status: NodeStatus | string;
  last_heartbeat?: string | null;
  created_at: string;
  updated_at: string;
  has_credential: boolean;
  warning?: string | null;
  /** Why this node's credential is not working, when it is not.
   *
   *  Read it INSTEAD of trusting `status` alone: a node whose credential went stale
   *  is still reachable and still reports `online`, so status says everything is
   *  fine while one screen quietly errors. The sentence names the missing permission
   *  and the remedy (re-enrol the node). */
  credential_error?: string | null;
}

export type MediaNodeListResponse = Paged<MediaNodePublic>;

/** `GET /vms/media-nodes/{id}/credentials` rows (backend/vision/app/vms/
 *  media_nodes/router.py — plain dicts, no schema). */
export interface NodeCredentialPublic {
  id: string;
  label?: string | null;
  grants: string[];
  created_at: string;
  last_used_at?: string | null;
  revoked_at?: string | null;
}

/** `POST /vms/media-nodes/{id}/enroll` / `/pair` → the RAW credential, once. */
export interface NodeEnrollResult {
  credential: string;
  id: string;
  label?: string | null;
  grants: string[];
}

/* --- dashboard (backend/vision/app/vms/dashboard/schemas.py) --------------- */

export interface CameraRollup {
  total: number;
  online: number;
  offline: number;
  degraded: number;
  other: number;
}

export interface RecordingRollup {
  recording: number;
  idle: number;
  failed: number;
  total_segments: number;
  bytes_last_24h: number;
}

export interface StoragePoolSummary {
  id: string;
  name: string;
  type: string;
  capacity_bytes?: number | null;
  used_bytes: number;
  used_pct?: number | null;
  days_to_full?: number | null;
}

export interface StorageRollup {
  pools: StoragePoolSummary[];
  total_capacity_bytes?: number | null;
  total_used_bytes: number;
  used_pct?: number | null;
}

export interface MediaNodeSummary {
  id: string;
  name: string;
  healthy: boolean;
  status: string;
  used_channels: number;
  capacity_channels: number;
  last_heartbeat?: string | null;
}

export interface NodesRollup {
  data_plane: "ok" | "unknown" | string;
  nodes: MediaNodeSummary[];
  total: number;
  healthy: number;
  unhealthy: number;
  resilience?: boolean | null;
  streaming?: boolean | null;
  recording?: boolean | null;
  nvr_node?: string | null;
  nats?: boolean | null;
}

export interface DashboardEventItem {
  id: string;
  camera_id?: string | null;
  event_type: string;
  severity: string;
  title: string;
  occurred_at: string;
  acknowledged: boolean;
}

export interface CountBucket {
  key: string;
  count: number;
}

export interface AlarmsRollup {
  total: number;
  unacknowledged: number;
  by_severity: CountBucket[];
  by_type: CountBucket[];
  recent: DashboardEventItem[];
}

export interface NvrRollup {
  total: number;
  healthy: number;
  unhealthy: number;
}

export interface DashboardSummary {
  cameras: CameraRollup;
  recording: RecordingRollup;
  storage: StorageRollup;
  nodes: NodesRollup;
  alarms: AlarmsRollup;
  nvrs: NvrRollup;
  generated_at: string;
}

/* --- federation (backend/vision/app/vms/federation/router.py) -------------- */
// No Pydantic models: the router forwards the recorder node's own JSON and tags
// it with `node_id` / `node_name`. The node's contract is the Go nvr's
// (backend/nvr/internal/estate/*.go); only the fields this console reads are
// fixed, the rest stays open.

/** One row of `GET /vms/federation/nodes`. */
export interface FederationNode {
  id: string;
  name: string;
  api_url?: string | null;
  status: NodeStatus | string;
  label?: string | null;
  capacity_channels: number;
  used_channels: number;
  last_heartbeat?: string | null;
}

export type FederationNodeList = ItemList<FederationNode>;

/** Tag fields the router adds to every proxied payload. */
export interface NodeTagged {
  node_id: string;
  node_name: string;
}

/** `POST …/cameras/{id}/live` — the node-issued live session. */
export interface FederatedLiveSession extends NodeTagged {
  session_id?: string;
  hls_url?: string | null;
  webrtc_url?: string | null;
  rtsp_url?: string | null;
  token?: string;
  expires_at?: string;
  profile?: string;
  [k: string]: unknown;
}

/** `GET …/cameras/{id}/timeline` — the node's recorded ranges. */
export interface FederatedTimeline extends NodeTagged {
  ranges?: PlaybackRange[] | null;
  [k: string]: unknown;
}

/** One recorded segment in `GET …/cameras/{id}/recordings`. */
export interface FederatedRecording {
  id?: string;
  start?: string;
  end?: string | null;
  duration?: number | null;
  file_size?: number | null;
  trigger_type?: string | null;
  [k: string]: unknown;
}

export interface FederatedRecordingList extends NodeTagged {
  items?: FederatedRecording[] | null;
  total?: number;
  [k: string]: unknown;
}

/** `POST …/cameras/{id}/playback` — EITHER `hls_url`/`webrtc_url` (mediamtx
 *  proxy channels) OR `playback_url` (locally-recorded fmp4). An empty
 *  `playback_url` = no footage in the window (200, not an error). */
export interface FederatedPlaybackSession extends NodeTagged {
  session_id?: string;
  playback_url?: string | null;
  hls_url?: string | null;
  webrtc_url?: string | null;
  token?: string;
  /** The node's clamp-forward answer — the video's true t=0. */
  start?: string | null;
  ranges?: PlaybackRange[] | null;
  expires_at?: string | null;
  /** The node's on-demand H.264 variant of `playback_url` (H.265 sources). */
  playback_transcode_url?: string | null;
  codec?: string | null;
  [k: string]: unknown;
}

/** `POST …/cameras/{id}/ptz` — `{ action, …payload }` forwarded to the node. */
export interface FederatedPtzBody {
  action: "move" | "stop";
  mode?: PtzMoveBody["mode"];
  pan?: number;
  tilt?: number;
  zoom?: number;
  speed?: number;
}

/** One preset as the CAMERA reports it (`GET …/ptz/presets`).
 *
 *  `token` is the device's own handle and the only thing a goto can be issued
 *  against — there is no VMS-side preset row behind a federated camera, because the
 *  preset lives in the camera's firmware and the recorder reads it from there. */
export interface FederatedPreset {
  token: string;
  name?: string | null;
  [k: string]: unknown;
}

/** `GET …/ptz/presets`. `supported:false` means the head has no preset service —
 *  distinct from an empty list, which means it has one and nothing is stored. */
export interface FederatedPresetList extends NodeTagged {
  supported?: boolean;
  items?: FederatedPreset[] | null;
  total?: number | null;
  detail?: string | null;
}

/** One stop in the recorder's host-driven patrol: dwell at a device preset. */
export interface FederatedPatrolStop {
  preset_token: string;
  dwell_seconds?: number | null;
}

/** `GET …/ptz/patrol` — the HOST-DRIVEN patrol (`kind:"host_driven"`): the recorder
 *  drives it, it is not stored on the camera.
 *
 *  There is exactly ONE per camera, not a list. That is the node's model and the
 *  console follows it rather than inventing a multi-patrol shape the recorder would
 *  have to fake. `native_tours_supported` ABSENT means "could not ask", not "no". */
export interface FederatedPatrol extends NodeTagged {
  enabled?: boolean;
  stops?: FederatedPatrolStop[] | null;
  default_dwell_seconds?: number | null;
  random_order?: boolean;
  runnable?: boolean;
  last_tick_at?: string | null;
  last_error?: string | null;
  kind?: string | null;
  note?: string | null;
  native_tours_supported?: boolean;
  presets?: FederatedPreset[] | null;
  [k: string]: unknown;
}

/** `PUT …/ptz/patrol` — an absent field leaves the recorder's setting untouched. */
export interface FederatedPatrolBody {
  enabled?: boolean;
  stops?: FederatedPatrolStop[];
  default_dwell_seconds?: number;
  random_order?: boolean;
}

/** A node-side operational result (record start/stop, reboot) — best-effort echo. */
export interface FederatedOpResult {
  ok?: boolean;
  supported?: boolean;
  detail?: string | null;
  [k: string]: unknown;
}

/** `GET …/backchannel` — can this camera receive talk-back, and can the recorder
 *  carry it there?
 *
 *  TWO facts, deliberately separate. `support.supported` is the CAMERA's answer
 *  (it has an audio output and a decoder); `talk_stream_ready` is the RECORDER's
 *  (its uplink transport is configured — off by default until bench-validated).
 *  Push-to-talk needs both, and collapsing them would report a camera as incapable
 *  when it is the recorder that is not ready. `outputs_error`/`decoders_error` mark
 *  a probe that DROPPED rather than answered "none" — a failed read, worth a retry,
 *  not a camera without talk-back. */
export interface FederatedBackchannel extends NodeTagged {
  support?: {
    supported?: boolean;
    detail?: string | null;
    decoder_formats?: string[] | null;
    [k: string]: unknown;
  } | null;
  talk_stream_ready?: boolean;
  transport?: Record<string, unknown> | null;
  outputs_error?: string | null;
  decoders_error?: string | null;
  [k: string]: unknown;
}

/** A stretch of time with no recording, inside a searched range. */
export interface FederatedCoverageGap {
  start?: string | null;
  end?: string | null;
  [k: string]: unknown;
}

/** `POST …/cameras/{id}/motion-search` — the recorder's forensic region search over
 *  its OWN recorded footage, relayed whole.
 *
 *  Four fields here carry weight and must not be dropped in rendering:
 *
 *   - `method` / `summary` — the recorder's own disclosure that this is pixel
 *     difference, NOT object detection. A hit list without it is what somebody reads
 *     as "three intruders".
 *   - `complete` / `notes` — the search is BOUNDED (span, frame budget, deadline).
 *     A bounded search that gave up must never present an empty hit list as "the
 *     footage is clear"; `notes` says which bound bit.
 *   - `examined_from` / `examined_to` — what was ACTUALLY covered, which is not
 *     necessarily the window that was asked for.
 *   - `gaps` — minutes with no footage inside the examined range. Nothing can be
 *     found in footage that does not exist. */
/** `POST …/cameras/{id}/motion-search` body. One region or none (whole frame);
 *  `sensitivity` is the recorder's 1..100 scale, and the sample rate is an INTERVAL
 *  in seconds, not a frame rate. */
export interface FederatedMotionSearchBody {
  from: string;
  to: string;
  region?: MotionRegion;
  sensitivity?: number;
  sample_interval_sec?: number;
  min_duration_sec?: number;
  merge_gap_sec?: number;
}

export interface FederatedMotionSearch extends NodeTagged {
  hits?: MotionHit[] | null;
  examined_from?: string | null;
  examined_to?: string | null;
  frames_examined?: number | null;
  sample_interval_sec?: number | null;
  complete?: boolean;
  notes?: string[] | null;
  gaps?: FederatedCoverageGap[] | null;
  summary?: string | null;
  method?: string | null;
  [k: string]: unknown;
}

/** `POST …/exports/{id}/verify` — the recorder's own answer about its own clip.
 *
 *  `valid:false` is a normal, expected result and carries `reason`:
 *    unsigned | manifest_missing | manifest_malformed | signature | clip_missing |
 *    clip_unreadable | tampered
 *
 *  `signed_by_this_node` false is NOT a failure — a manifest signed before a key
 *  rotation, or produced by another recorder, is still internally valid. It says
 *  which of the two the operator is looking at. */
export interface FederatedExportVerify extends NodeTagged {
  valid: boolean;
  reason?: string | null;
  detail?: string | null;
  public_key?: string | null;
  signed_by_this_node?: boolean;
  expected_sha256?: string | null;
  actual_sha256?: string | null;
  manifest?: Record<string, unknown> | null;
}

/** `GET …/exports/public-key` — the recorder's ed25519 export-signing identity. */
export interface FederatedExportPublicKey extends NodeTagged {
  algorithm?: string | null;
  /** The first 16 hex characters — a handle for comparing by eye, never a substitute. */
  key_id?: string | null;
  public_key?: string | null;
}

/** A node-side clip-export job (`…/exports`). */
export interface FederatedExportJob {
  id: string;
  status?: string;
  camera_id?: string;
  from?: string;
  to?: string;
  file_size?: number | null;
  error?: string | null;
  /** Hex SHA-256 of the produced clip, as the recorder hashed it on its own disk. */
  sha256?: string | null;
  /** "copy" when the segments concatenated without re-encoding, else "reencode". */
  encode_mode?: string | null;
  /** Whether a signed chain-of-custody manifest was produced alongside the clip.
   *  Signing is best-effort on the recorder: a signing failure leaves a valid,
   *  hashed download with no manifest rather than failing the export. */
  signed?: boolean;
  manifest_sha256?: string | null;
  [k: string]: unknown;
}

export type FederatedExportList = ItemList<FederatedExportJob> | FederatedExportJob[];

/** A node-side evidence hold (`…/holds`). */
export interface FederatedHold {
  id?: string;
  from?: string;
  to?: string;
  reason?: string | null;
  created_at?: string;
  [k: string]: unknown;
}

export type FederatedHoldList = ItemList<FederatedHold> | FederatedHold[];

/** `GET …/storage/usage` — the recorder's own disk summary. */
export interface NodeStorageUsage extends Partial<NodeTagged> {
  total_bytes?: number | null;
  free_bytes?: number | null;
  used_bytes?: number | null;
  used_percent?: number | null;
  reachable?: boolean;
  [k: string]: unknown;
}

/** One md array in `GET …/storage/raid` (backend/nvr/internal/store RaidArray). */
export interface NodeRaidArray {
  device?: string;
  level?: string | null;
  health?: string;
  working_devices?: number | null;
  failed_devices?: number | null;
  total_devices?: number | null;
  rebuild_percent?: number | null;
  [k: string]: unknown;
}

export interface NodeRaidStatus extends Partial<NodeTagged> {
  available?: boolean;
  reason?: string | null;
  arrays?: NodeRaidArray[] | null;
  [k: string]: unknown;
}

/** One pool in `GET …/storage/pools` (backend/nvr/internal/estate/storage/storage.go). */
export interface NodeStoragePool {
  id: string;
  name: string;
  pool_type?: string;
  kind?: string;
  path?: string | null;
  priority?: number;
  max_size_bytes?: number | null;
  is_default?: boolean;
  is_active?: boolean;
  mount_state?: string | null;
  reachable?: boolean | null;
  camera_count?: number;
  usage?: NodeStorageUsage | null;
  [k: string]: unknown;
}

export interface NodeStoragePoolList extends Partial<NodeTagged> {
  items?: NodeStoragePool[] | null;
  [k: string]: unknown;
}

/** One rule in `GET …/storage/tier-rules`. */
export interface NodeTierRule {
  id: string;
  name?: string;
  source_pool_id?: string;
  target_pool_id?: string;
  after_age_hours?: number;
  enabled?: boolean;
  last_run_at?: string | null;
  [k: string]: unknown;
}

export interface NodeTierRuleList extends Partial<NodeTagged> {
  items?: NodeTierRule[] | null;
  [k: string]: unknown;
}

/** `GET …/nvrs/{id}/storage` — a 3rd-party NVR's HDDs via the recorder, or
 *  `{ available: false }` when the node has nothing for it yet. */
export interface NodeUpstreamNvrStorage extends Partial<NodeTagged> {
  available?: boolean;
  disks?: NodeStorageUsage[] | null;
  items?: NodeStorageUsage[] | null;
  [k: string]: unknown;
}

/* --- console-side derived shapes ------------------------------------------ */

/** A federated camera as `useEstateCameras` folds it into the rail: the
 *  composite `id` (`fed:<node>:<camera>`), the node-side `real_id`, and the
 *  recorder as a synthetic site so the rail groups it under its NVR. */
export interface EstateFederatedCamera {
  id: string;
  real_id: string;
  name: string;
  status?: string;
  federated: true;
  ptz_capable: boolean;
  node_id: string;
  node_name: string;
  site_id: string;
  site_name: string;
}

/** One row of the merged estate list — a local `VmsCameraPublic` or an
 *  `EstateFederatedCamera`. Only `id`/`name` are common to both sources, so
 *  everything else is optional: a rail reads `placement?.site_id` on a local
 *  row and `node_id` on a federated one and gets `undefined` for the other. */
export interface EstateCamera extends Partial<Omit<VmsCameraPublic, "id" | "name" | "status">> {
  id: string;
  name: string;
  status?: string;
  federated?: boolean;
  real_id?: string;
  ptz_capable?: boolean;
  node_id?: string;
  node_name?: string;
  site_id?: string;
  site_name?: string;
}

/** The recorded-playback source a tile/player pulls from: our own camera, a
 *  3rd-party NVR channel, or a recorder-owned camera through federation. */
export type PlaybackSourceKind = "local" | "nvr" | "federated";

/** A `[from, to]` ISO window. */
export interface IsoWindow {
  from: string;
  to: string;
}

/** The live session shape `useLiveSession` manages — vision's
 *  `PlaybackSessionPublic` or a node-issued `FederatedLiveSession`, narrowed to
 *  the fields the lifecycle and the player read. */
export interface LiveSessionLike {
  session_id?: string;
  hls_url?: string | null;
  webrtc_url?: string | null;
  rtsp_url?: string | null;
  token?: string;
  expires_at?: string;
  ready?: boolean;
}

/** A pluggable control plane for `useLiveSession` (vision by default; a
 *  federated camera mints/renews/releases through its node instead). */
export interface LiveSessionSource {
  start: (cameraId: string, profile: string) => Promise<LiveSessionLike>;
  renew: (cameraId: string, sessionId: string) => Promise<LiveSessionLike>;
  release: (sessionId: string) => Promise<unknown>;
}

/** The playback session shape `usePlaybackSession` / `PlaybackPlayer` consume —
 *  the union of what vision, a 3rd-party NVR channel and a federation node each
 *  hand back, narrowed to the fields the player reads. */
export interface PlayableSession {
  session_id?: string;
  hls_url?: string | null;
  webrtc_url?: string | null;
  rtsp_url?: string | null;
  token?: string | null;
  from?: string | null;
  to?: string | null;
  ranges?: PlaybackRange[] | null;
  expires_at?: string | null;
}

/** A source override for `usePlaybackSession` — mints a session over a window. */
export type PlaybackSourceFn = (win: IsoWindow) => Promise<PlayableSession>;

/** One recorded span as the scrub bars consume it — vision's `TimelineSegment`,
 *  a merged/union span, or a 3rd-party NVR range folded to the same shape.
 *  `start` may be missing on a malformed row; renderers skip those. */
export interface CoverageSpan {
  start?: string | null;
  end?: string | null;
  trigger_type?: string | null;
}

/** What a `timelineFn` override hands PlaybackPlayer: vision's envelope, a
 *  coverage-only envelope, or a bare span list. */
export type TimelineLike = { coverage: CoverageSpan[]; markers?: TimelineMarker[] } | CoverageSpan[];

/** A motion-search hit as the scrub bar plots it (`MotionHit` with end/score optional). */
export interface MotionHitLike {
  start: string;
  end?: string | null;
  score?: number | null;
}

/** "Export this range" — a window plus the camera it belongs to (ExportDialog). */
export interface ExportRangeRequest extends IsoWindow {
  cameraId?: string | null;
  cameraName?: string | null;
}

/** The FLAT camera form the onboard/edit modal binds to (constants.
 *  DEFAULT_CAMERA_FORM); formUtils maps it to/from the nested wire shapes.
 *  Numeric fields are `number | string` because they bind to text inputs. */
export interface CameraForm {
  name: string;
  brand: string;
  connection_type: ConnectionType;
  is_enabled: boolean;
  ip: string;
  port: number | string;
  rtsp_port: number | string;
  onvif_host: string;
  onvif_port: number | string;
  onvif_user: string;
  onvif_password: string;
  onvif_profile_token: string;
  has_password?: boolean;
  recording_mode: RecordingMode;
  recording_schedule: Record<string, unknown> | null;
  recording_fps: number | string;
  record_substream: boolean;
  retention_days: number | string;
  pre_buffer_seconds: number | string;
  post_buffer_seconds: number | string;
  anr_enabled: boolean;
  audio_enabled: boolean;
  media_node_id: string;
  storage_pool_id?: string;
  ptz_capable: boolean;
  site_id: string;
  floor_id: string;
  zone_id: string;
}

/** `{ field: message }` from `validateCamera`. */
export type CameraFormErrors = Partial<Record<keyof CameraForm, string>>;

/** A wall preset — the ENTIRE wall state a saved layout / pattern stop restores
 *  in one call: the layout key + one camera id (or null) per tile. */
export interface WallPreset {
  layout: string;
  tiles: (string | null)[];
}

/** One resolved stop of a rotating pattern (usePatternRotation): a camera
 *  group turned into the wall layout + camera ids it paints. */
export interface PatternStop {
  groupId: string;
  name: string;
  layoutKey: string;
  wallLayout: string;
  cameraIds: string[];
}

/** One `vms.popup` SSE frame (the linkage `popup` action) — see useVmsPopups. */
export interface VmsPopupFrame {
  camera_id?: string | null;
  reason?: string | null;
  event_id?: string | null;
  event_type?: string | null;
  severity?: string | null;
  occurred_at?: string | null;
  [k: string]: unknown;
}

/* --- report bodies as the Reports view reads them -------------------------
 * (backend/vision/app/vms/reports/computations.py — each `compute_*` builds the
 * `rows` / `totals` dicts below. `ReportResponse` above keeps them open because
 * the columns are kind-specific; these narrow them to the scalars the renderer
 * actually does arithmetic and formatting on.) */

/** One cell of a report row or totals map — every value the computations emit
 *  is a string, a number, or null. */
export type ReportCell = string | number | null | undefined;

/** One report row. Every column is optional: a row only carries the columns of
 *  its own `kind`, and the index signature keeps unknown kinds renderable. */
export interface ReportRow {
  // camera-uptime
  camera_id?: string | null;
  camera_name?: string;
  samples?: number;
  online_samples?: number;
  uptime_pct?: number;
  // recording-coverage
  expected_seconds?: number;
  recorded_seconds?: number;
  coverage_pct?: number;
  segments?: number;
  bytes?: number;
  // storage-usage
  pool_id?: string | null;
  pool_name?: string;
  pool_type?: string | null;
  max_size_bytes?: number | null;
  // event-stats
  events?: number;
  // health-summary
  metric?: string;
  value?: number;
  // operator-activity
  operator?: string;
  total_actions?: number;
  exports?: number;
  motion_searches?: number;
  bookmarks?: number;
  evidence_locks?: number;
  evidence_releases?: number;
  event_acks?: number;
  // alarm-response
  alarms?: number;
  acknowledged?: number;
  unacknowledged?: number;
  ack_rate_pct?: number;
  avg_time_to_ack_s?: number | null;
  max_time_to_ack_s?: number | null;
  [k: string]: ReportCell;
}

/** One row of a NON-flat breakdown map. `alarm-response.by_severity` is keyed by
 *  severity and each value is this stats record, not a count — see
 *  backend/vision/app/vms/reports/computations.py (`compute_alarm_response`). */
export interface AlarmSeverityBreakdown {
  alarms: number;
  acked: number;
  ack_rate_pct: number;
}

/** What a breakdown map can be. `event-stats` emits flat count maps (`by_type`,
 *  `by_severity`) and `operator-activity` a flat `by_action`; `alarm-response`
 *  emits a map of rows under the SAME `by_severity` key. Both live in
 *  backend/vision/app/vms/reports/computations.py. */
export type BreakdownMap = Record<string, number> | Record<string, AlarmSeverityBreakdown>;

/** The `totals` map — the estate-wide numbers each kind contributes. */
export interface ReportTotals {
  cameras?: number;
  avg_uptime_pct?: number;
  avg_coverage_pct?: number;
  total_bytes?: number;
  pools?: number;
  total_segments?: number;
  total_events?: number;
  events?: number;
  operators?: number;
  total_actions?: number;
  alarms?: number;
  acknowledged?: number;
  unacknowledged?: number;
  ack_rate_pct?: number;
  avg_time_to_ack_s?: number | null;
  max_time_to_ack_s?: number | null;
  [k: string]: ReportCell;
}

/** `ReportResponse` as the Reports view consumes it: the same envelope with
 *  `rows`/`totals` narrowed and the G8-only maps (`by_action`, `source_note`)
 *  named. The report endpoint is typed `ReportResponse`; the view narrows once. */
export interface ReportViewData {
  kind: string;
  window: { from: string; to: string; seconds?: number };
  rows: ReportRow[];
  totals: ReportTotals;
  by_type?: Record<string, number>;
  /** Flat counts for `event-stats`, a row map for `alarm-response`. */
  by_severity?: BreakdownMap;
  by_action?: Record<string, number>;
  status_counts?: Record<string, number>;
  source_note?: string | null;
  [k: string]: unknown;
}
