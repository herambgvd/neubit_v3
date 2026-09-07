// Shared API shapes. Each interface mirrors one Pydantic model — the file is
// named per block so a schema change has an obvious counterpart here. Dates
// cross the wire as ISO-8601 strings, never Date objects, so they are typed
// `string`; `dict` fields become `Record<string, unknown>` (or a narrower map
// where the backend documents one).

/** The uniform error envelope: `{ error: { code, message } }`. */
export interface ApiErrorBody {
  error?: { code?: string; message?: string };
}

/** The list envelope every core `*ListResponse` uses (`items/total/skip/limit`).
 *  A few endpoints return a bare array instead — see `asItems` in lib/format. */
export interface Paged<T> {
  items: T[];
  total: number;
  skip: number;
  limit: number;
}

/** `Page[T]` — backend/core/app/core/pagination.py. The page-numbered envelope
 *  (messaging, audit) as opposed to the skip/limit one above. */
export interface Page<T> {
  items: T[];
  page: number;
  page_size: number;
  total: number;
  pages: number;
  has_next: boolean;
  has_prev: boolean;
}

/** Query-string filters. Null/undefined/"" are dropped before the request is
 *  built (see `qs` in lib/api/*), so a caller can pass an unset filter freely. */
export type QueryParams = Record<string, string | number | boolean | null | undefined>;

/* --- auth (backend/core/app/auth/schemas.py) ------------------------------- */

/** The signed-in operator, as this console reads them. */
export interface AuthUser {
  id: string;
  email: string;
  full_name: string | null;
  avatar_url?: string | null;
  email_verified?: boolean;
  is_superadmin?: boolean;
  preferences?: Record<string, unknown>;
  role?: { id?: string; name?: string; permissions?: string[] };
}

/** One module's entitlement, as /features reports it. */
export interface ModuleEntitlement {
  key: string;
  enabled: boolean;
  name?: string;
  /** The catalog category the module is filed under. */
  category?: string | null;
}

/** GET /features — `effective_entitlements` in backend/core/app/tenancy/entitlements.py. */
export interface Entitlements {
  /** The tenant's plan name; null for a super-admin (no tenant). */
  plan?: string | null;
  modules?: ModuleEntitlement[];
  limits?: Record<string, number>;
  /** `effective_license_state` in backend/core/app/tenancy/models.py. */
  license_state?: "active" | "grace" | "expired";
  /** ISO timestamp; null when the license has no expiry. */
  expires_at?: string | null;
}

/** POST /auth/login and /auth/login/mfa. When 2FA is on the first step
 *  withholds tokens and returns a challenge instead. */
export interface LoginResponse {
  access_token?: string | null;
  mfa_required?: boolean;
  mfa_token?: string | null;
}

/* --- sites (backend/core/app/sites/shared.py) ------------------------------ */

export type ThreatLevel = "normal" | "elevated" | "high" | "critical" | "lockdown";

export type SiteType =
  | "building"
  | "campus"
  | "facility"
  | "warehouse"
  | "headquarters"
  | "branch"
  | "retail"
  | "office"
  | "factory"
  | "other";

export type ZoneType =
  | "entrance"
  | "parking"
  | "office"
  | "lobby"
  | "server_room"
  | "common_area"
  | "corridor"
  | "cafeteria"
  | "security"
  | "emergency_exit"
  | "other";

/** `DEVICE_TYPES` — the floor-plan placement enum (not an equipment taxonomy). */
export type DeviceType =
  | "camera"
  | "nvr"
  | "access_control"
  | "panel"
  | "sensor"
  | "door"
  | "reader"
  | "other";

/** `SERVICE_TYPES` — which backend owns a placed device. */
export type ServiceType = "vms" | "access_control" | "iot" | "fire";

/* --- sites (backend/core/app/sites/site/schemas.py) ------------------------ */

export interface Address {
  street?: string | null;
  city?: string | null;
  state?: string | null;
  zip_code?: string | null;
  country?: string | null;
}

export interface Coordinates {
  latitude: number;
  longitude: number;
}

/** `SitePublic`. The `*_type` / `threat_level` columns are `str` on the wire but
 *  are only ever written through the validated request literals, hence the unions. */
export interface SitePublic {
  site_id: string;
  name: string;
  location_code: string | null;
  description: string | null;
  site_type: SiteType;
  parent_id: string | null;
  threat_level: ThreatLevel;
  address: Address | null;
  coordinates: Coordinates | null;
  contact_person: string | null;
  contact_phone: string | null;
  email_address: string | null;
  image_url: string | null;
  /** Building facts (migration 0018). Null means "not recorded" — BI Ratings
   *  produces no rating rather than a default. */
  gross_floor_area_sqm: number | null;
  energy_tariff_per_kwh: number | null;
  tariff_currency: string | null;
  occupancy: number | null;
  building_facts_updated_at: string | null;
  building_facts_updated_by: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  floor_count: number;
}

/** One node of GET /sites/tree — `SiteService.get_tree`, a hand-built dict, so
 *  it is keyed `id` rather than `site_id` like `SitePublic`. */
export interface SiteTreeNode {
  id: string;
  name: string;
  site_type: SiteType;
  parent_id: string | null;
  threat_level: ThreatLevel;
  location_code: string | null;
  children: SiteTreeNode[];
}

export interface CreateSiteRequest {
  name: string;
  location_code?: string | null;
  description?: string | null;
  site_type?: SiteType;
  parent_id?: string | null;
  threat_level?: ThreatLevel;
  address?: Address | null;
  coordinates?: Coordinates | null;
  contact_person?: string | null;
  contact_phone?: string | null;
  email_address?: string | null;
  image_url?: string | null;
}

/** Applied with `exclude_none=True` server-side: a null here means "not
 *  mentioned", never "clear". Use `BuildingFactsUpdate` to clear a fact. */
export interface UpdateSiteRequest extends Partial<CreateSiteRequest> {
  is_active?: boolean | null;
}

/** `BuildingFactsUpdate` — a PUT of all four, where an explicit null CLEARS. */
export interface BuildingFactsUpdate {
  gross_floor_area_sqm: number | null;
  energy_tariff_per_kwh: number | null;
  tariff_currency: string | null;
  occupancy: number | null;
}

export interface ThreatLevelUpdate {
  threat_level: ThreatLevel;
}

/** `TariffSlabIn` — one time-of-use window, minutes since midnight. */
export interface TariffSlabIn {
  name: string;
  start_minute: number;
  end_minute: number;
  rate_per_kwh: number;
  currency: string;
  /** ISO date (YYYY-MM-DD). */
  effective_from: string;
}

export interface TariffSlabPublic extends TariffSlabIn {
  slab_id: string;
  site_id: string;
  position: number;
  created_at: string;
}

export interface TariffSlabListResponse {
  items: TariffSlabPublic[];
  total: number;
}

/** `EmissionFactorIn` — kg CO2 per kWh with a required source citation. */
export interface EmissionFactorIn {
  kg_co2_per_kwh: number;
  source: string;
  /** ISO date (YYYY-MM-DD). */
  effective_from: string;
}

export interface EmissionFactorPublic extends EmissionFactorIn {
  factor_id: string;
  site_id: string;
  created_at: string;
}

export interface EmissionFactorListResponse {
  items: EmissionFactorPublic[];
  total: number;
}

/* --- floors (backend/core/app/sites/floor/schemas.py) ---------------------- */

export interface FloorPublic {
  floor_id: string;
  site_id: string;
  name: string;
  floor_number: number | null;
  description: string | null;
  floorplan_url: string | null;
  total_area: number | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  zone_count: number;
}

export interface CreateFloorRequest {
  site_id: string;
  name: string;
  floor_number?: number | null;
  description?: string | null;
  floorplan_url?: string | null;
  total_area?: number | null;
}

export interface UpdateFloorRequest {
  name?: string | null;
  floor_number?: number | null;
  description?: string | null;
  floorplan_url?: string | null;
  total_area?: number | null;
  is_active?: boolean | null;
}

/* --- zones (backend/core/app/sites/zone/schemas.py) ------------------------ */

export interface ZonePublic {
  zone_id: string;
  site_id: string;
  floor_id: string;
  name: string;
  description: string | null;
  zone_type: ZoneType;
  threat_level: ThreatLevel;
  color: string | null;
  alert_on_entry: boolean;
  alert_on_exit: boolean;
  max_occupancy: number | null;
  /** `[[x, y], …]` in floor-plan pixels; at least 3 points when set. */
  polygon: number[][] | null;
  geo_polygon: Record<string, unknown> | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface CreateZoneRequest {
  site_id: string;
  floor_id: string;
  name: string;
  description?: string | null;
  zone_type?: ZoneType;
  threat_level?: ThreatLevel;
  color?: string | null;
  alert_on_entry?: boolean;
  alert_on_exit?: boolean;
  max_occupancy?: number | null;
  polygon?: number[][] | null;
  geo_polygon?: Record<string, unknown> | null;
}

export interface UpdateZoneRequest {
  name?: string | null;
  description?: string | null;
  zone_type?: ZoneType | null;
  threat_level?: ThreatLevel | null;
  color?: string | null;
  alert_on_entry?: boolean | null;
  alert_on_exit?: boolean | null;
  max_occupancy?: number | null;
  polygon?: number[][] | null;
  geo_polygon?: Record<string, unknown> | null;
  is_active?: boolean | null;
}

/* --- device placements (backend/core/app/sites/device/schemas.py) ---------- */

/** Pixel position on the floor image; `rotation` in degrees (facing direction). */
export interface FloorPosition {
  x: number;
  y: number;
  rotation: number;
}

/** `DevicePlacementPublic` — a device pinned onto a floor. Id-only: the device's
 *  name lives in the owning service (see useDeviceInventory). */
export interface DevicePlacementPublic {
  placement_id: string;
  device_id: string;
  device_type: DeviceType;
  service: ServiceType;
  site_id: string;
  floor_id: string;
  zone_id: string | null;
  floor_position: FloorPosition;
  metadata: Record<string, unknown> | null;
  status: string;
  status_updated_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface RegisterDeviceRequest {
  device_id: string;
  device_type: DeviceType;
  service: ServiceType;
  site_id: string;
  floor_id: string;
  zone_id?: string | null;
  floor_position: FloorPosition;
  metadata?: Record<string, unknown> | null;
}

export interface UpdateDeviceRequest {
  floor_position?: FloorPosition | null;
  zone_id?: string | null;
  metadata?: Record<string, unknown> | null;
}

/** `DeviceListResponse` — note `count`, not `total`. */
export interface DevicePlacementListResponse {
  items: DevicePlacementPublic[];
  count: number;
}

/* --- tags (backend/core/app/tags/schemas.py) ------------------------------- */

export interface TagPublic {
  tag_id: string;
  name: string;
  /** `#RRGGBB`. */
  color: string;
  description: string | null;
  is_active: boolean;
  usage_count: number;
  created_at: string;
  updated_at: string;
}

export interface CreateTagRequest {
  name: string;
  color?: string;
  description?: string | null;
  is_active?: boolean;
}

export interface UpdateTagRequest {
  name?: string | null;
  color?: string | null;
  description?: string | null;
  is_active?: boolean | null;
}

/** `TagAssignRequest` — attach / detach a tag to / from any entity. */
export interface TagAssignRequest {
  entity_type: string;
  entity_id: string;
}

/** `TagLinkPublic` — one entity tagged with a tag (GET /tags/{id}/entities). */
export interface TagLinkPublic {
  entity_type: string;
  entity_id: string;
}

/* --- cameras (backend/vision/app/vms/cameras/schemas.py) ------------------- */

export interface OnvifPublic {
  host?: string | null;
  port?: number | null;
  user?: string | null;
  has_password?: boolean;
  profile_token?: string | null;
  capabilities?: Record<string, unknown>;
}

/** `CameraPublic`. The nested config blocks are modelled only as far as this
 *  console reads them; everything else stays an opaque dict. */
export interface CameraPublic {
  id: string;
  name: string;
  is_enabled: boolean;
  status: string;
  brand: string;
  driver: string | null;
  connection_type: string;
  /** Free-form; the floor builder reads `ip` for its search. */
  network_info: Record<string, unknown> & { ip?: string | null };
  onvif: OnvifPublic;
  recording: Record<string, unknown>;
  advanced: Record<string, unknown>;
  ptz: { capable?: boolean; presets?: unknown[] };
  placement: { site_id?: string | null; floor_id?: string | null; zone_id?: string | null };
  media_profiles: Record<string, unknown>[];
  nvr_id: string | null;
  nvr_channel_number: number | null;
  storage_pool_id: string | null;
  media_node_id: string | null;
  display_order: number;
  thumbnail_path: string | null;
  last_seen_at: string | null;
  talk_capable: boolean;
  sub_stream_codec: string | null;
  web_codec_enforced: boolean;
  created_at: string;
  updated_at: string;
}

/** One row of GET /vms/federation/cameras — a recorder node's own camera dict,
 *  tagged with its source node (backend/vision/app/vms/federation/router.py).
 *  The node's camera shape is the recorder's, so only the tag fields are fixed. */
export interface FederatedCamera {
  id: string;
  name: string;
  status?: string;
  node_id: string;
  node_name: string;
  [k: string]: unknown;
}

export interface FederatedCameraList {
  items: FederatedCamera[];
  total: number;
  nodes: number;
  unreachable: { node_id: string; name: string; error: string }[];
}

/* --- NVRs (backend/vision/app/vms/nvr/schemas.py) -------------------------- */


/* --- access control (backend/access/app/access/schemas.py) ----------------- */

/** `InstancePublic` — a controller / panel. Its identifier is `id`. */
export interface AccessInstancePublic {
  id: string;
  name: string;
  brand: string;
  base_url: string;
  auth_type: string;
  username: string;
  has_secret: boolean;
  verify_tls: boolean;
  status: string;
  is_active: boolean;
  site_id: string | null;
  last_connected_at: string | null;
  last_sync_at: string | null;
  last_error: string | null;
  reconciler_cron: string | null;
  created_at: string;
  updated_at: string;
}

/** `DoorPublic`. Its identifier is `id`. */
export interface AccessDoorPublic {
  id: string;
  instance_id: string;
  name: string;
  remote_ref: string | null;
  site_id: string | null;
  floor_id: string | null;
  zone_id: string | null;
  is_active: boolean;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

/* --- BI devices (backend/reading-writer/app/api/schemas.py) ---------------- */

/** `DeviceRow` — one device that has REPORTED, grouped out of `points`.
 *  `device_id` is null for points the gateway never attributed to a device. */
export interface BiDeviceRow {
  device_id: string | null;
  device_tag: string | null;
  /** BI category (`energy`, `hvac`, `water`, …) — contract §11. */
  category: string | null;
  /** Equipment kind (`chiller`, `meter`, …) — NOT the placement enum. */
  device_type: string | null;
  points: number;
  numeric_points: number;
  text_points: number;
  points_reporting: number;
  first_seen_at: string | null;
  last_seen_at: string | null;
}

export interface BiDeviceListResponse {
  total: number;
  items: BiDeviceRow[];
}

/* --- messaging (backend/core/app/messaging/router.py) ---------------------- */

/** `NotificationOut` — one in-app inbox row. */
export interface NotificationOut {
  id: string;
  title: string;
  body: string | null;
  read: boolean;
  ts: string;
}

/* --- search (backend/core/app/search/router.py) ---------------------------- */

/** One row of GET /search — hand-built dicts, one per matched entity. */
export interface SearchResult {
  type: string;
  id: string;
  label: string;
  sublabel: string | null;
  href: string;
  icon: string;
}

export interface SearchResponse {
  results: SearchResult[];
}

/* --- branding + settings (backend/core/app/branding/schemas.py, settings/) - */

/** `BrandingOut` — what the console themes itself with. */
export interface BrandingOut {
  id: string;
  app_name: string;
  logo_url: string | null;
  primary_color: string;
  accent_color: string;
  name_in_header: boolean;
}

/** GET /settings/public — `SettingsService.public_values()`, the safe subset
 *  every screen may read. Only the keys this console uses are named. */
export interface PublicSettings {
  announcement?: string | null;
  [k: string]: unknown;
}

/* --- system (backend/core/app/system/resources.py) ------------------------- */

export interface GpuSample {
  index: number;
  name: string;
  /** bytes */
  mem_total: number;
  /** bytes */
  mem_used: number;
  /** 0–100 */
  util_percent: number;
  /** °C, or null when the driver does not report one. */
  temp: number | null;
}

/** `sample_resources()` — one host utilisation snapshot. */
export interface SystemResourcesSnapshot {
  cpu_percent: number;
  cpu_name: string | null;
  cpu_cores: number | null;
  cpu_freq_ghz: number | null;
  ram: { total: number; used: number; percent: number };
  disk: { total: number; used: number; percent: number };
  gpus: GpuSample[];
}
