// Wire types local to the access-control feature (instances, sync jobs, the DDS
// mirror, events, cardholders, cards, access groups, schedules, hardware). Each
// interface mirrors one Pydantic model — the backend file is named per block.
// Dates cross the wire as ISO-8601 strings; `dict` fields become
// `Record<string, unknown>`. The two shapes other features read (the instance
// and the door) live in @/lib/types as AccessInstancePublic / AccessDoorPublic.
import type { Paged } from "@/lib/types";

/* --- instances (backend/access/app/access/schemas.py) ---------------------- */

/** `AuthType`. */
export type AccessAuthType = "basic" | "jwt";

/** `InstanceCreate` — the onboard form body. Only DDS is onboardable today. */
export interface InstanceCreate {
  name: string;
  base_url: string;
  brand?: "dds";
  auth_type?: AccessAuthType;
  username?: string;
  /** Plaintext on create; the server encrypts before storing. */
  secret?: string | null;
  verify_tls?: boolean;
  site_id?: string | null;
  is_active?: boolean;
  /** Five-field cron; `""` turns the schedule off. */
  reconciler_cron?: string | null;
}

/** `InstanceUpdate` — PATCH semantics; only sent fields change. */
export interface InstanceUpdate {
  name?: string | null;
  base_url?: string | null;
  auth_type?: AccessAuthType | null;
  username?: string | null;
  /** Provide to rotate; omit to leave unchanged. */
  secret?: string | null;
  verify_tls?: boolean | null;
  site_id?: string | null;
  is_active?: boolean | null;
  reconciler_cron?: string | null;
}

/** `TestConnectionResponse`. */
export interface TestConnectionResponse {
  ok: boolean;
  detail: Record<string, unknown>;
  error: string | null;
}

/* --- sync jobs (backend/access/app/access/schemas.py) ---------------------- */

/** One collection's tally, as `InstanceService._reconcile_collection` builds it
 *  (service.py) — the values of `SyncJobPublic.counts`. */
export interface SyncCollectionCounts {
  created: number;
  updated: number;
  deleted: number;
  errors: number;
}

/** `SyncJobPublic`. `counts` is keyed by mirror collection; `errors` is the
 *  per-collection error tally `InstanceService.reconcile` appends. */
export interface SyncJobPublic {
  id: string;
  instance_id: string;
  kind: string;
  /** running | succeeded | partial | failed. */
  status: string;
  trigger: string;
  created_count: number;
  updated_count: number;
  deleted_count: number;
  error_count: number;
  counts: Record<string, SyncCollectionCounts>;
  errors: { collection: string; errors: number }[];
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

/** `SyncJobListResponse`. */
export interface SyncJobListResponse {
  items: SyncJobPublic[];
  total: number;
}

/* --- mirror (backend/access/app/access/schemas.py) ------------------------- */

/** `MirrorRow` — one mirrored controller entity: the VERBATIM DDS DTO (PascalCase
 *  keys such as `UID`, `FirstName`, `CardCode`) plus mirror metadata. This is what
 *  GET /instances/{id}/cardholders and /cards return; `api.ts` maps it to the
 *  cardholder / card shapes below. */
export interface MirrorRow {
  id: string;
  instance_id: string;
  collection: string;
  remote_uid: string | null;
  dto: Record<string, unknown>;
  last_synced_at: string;
}

/* --- events (backend/access/app/access/schemas.py) ------------------------- */

/** `AccessEventPublic` — a persisted controller event. `door_ref` /
 *  `cardholder_ref` are the CONTROLLER's identifiers (a door's `remote_ref`, a
 *  cardholder's DDS UID), not local ids. */
export interface AccessEventPublic {
  id: string;
  instance_id: string;
  category: string;
  event_type: string;
  result: string;
  remote_uid: string | null;
  door_ref: string | null;
  cardholder_ref: string | null;
  site_id: string | null;
  /** The vendor payload as received — shape varies by controller firmware. */
  raw: Record<string, unknown>;
  occurred_at: string;
}

/** One `access.event` SSE frame — the compact JSON `_compact` builds in
 *  backend/core/app/core/realtime_access.py from the NATS envelope. Every key is
 *  present; values are null when the payload lacked them. */
export interface AccessEventFrame {
  event_id: string | null;
  instance_id: string | null;
  category: string | null;
  event_type: string | null;
  result: string | null;
  remote_uid: string | null;
  door_ref: string | null;
  cardholder_ref: string | null;
  site_id: string | null;
  raw: Record<string, unknown>;
  occurred_at: string | null;
  tenant_id: string | null;
}

/** Frontend-only: a REST row or an SSE frame folded to the ONE shape every
 *  EventsFeed filter / renderer reads (see `normalizeEvent` there). */
export interface NormalizedAccessEvent {
  event_id: string | null;
  instance_id: string | null;
  category: string | null;
  event_type: string | null;
  result: string | null;
  remote_uid: string | null;
  site_id: string | null;
  timestamp: string | null;
  raw_payload: Record<string, unknown>;
  door_ref: string | null;
  /** Alias of `door_ref` (the controller ref) kept for the v2-ported helpers. */
  door_id: string | null;
  cardholder_ref: string | null;
  /** Alias of `cardholder_ref`, as above. */
  cardholder_id: string | null;
  /** `raw.CardCode`, stringified. */
  card_id: string | null;
  /** v2-era fields the ported helpers still read. NEITHER source carries them —
   *  the v3 `AccessEventPublic` / SSE frame have no `reason` or `ingested_at` —
   *  so they are always undefined; declared optional rather than silently
   *  deleting the reads. */
  reason?: string | null;
  ingested_at?: string | null;
}

/** What `normalizeEvent` accepts: a REST history row, a live SSE frame, or a
 *  record it already folded (the merge pass re-runs it — it is idempotent). */
export type RawAccessEvent = AccessEventPublic | AccessEventFrame | NormalizedAccessEvent;

/* --- cardholders (backend/access/app/access/writethrough.py) --------------- */

/** Internal status — `_CH_DDS_TO_STATUS` maps DDS Validated / Invalidated /
 *  Archived to active / suspended / terminated; `expired` is a v2 write value. */
export type AccessCardholderStatus = "active" | "suspended" | "terminated" | "expired";

/** The cardholder shape `_cardholder_from_dds` hand-builds: what every
 *  cardholder write endpoint returns and what `api.ts` derives for the list. */
export interface AccessCardholder {
  /** The DDS UID. */
  cardholder_id: string;
  name: string;
  first_name: string;
  last_name: string;
  employee_id: string | null;
  email: string | null;
  /** Always `[]` today — the DDS mirror does not join cards onto a holder. */
  cards: { card_id: string }[];
  /** DDS access-group UIDs. */
  access_groups: string[];
  valid_from: string | null;
  valid_until: string | null;
  status: AccessCardholderStatus;
  photo_url: string | null;
  department_uid: string | null;
  security_group_uid: string | null;
  is_supervisor: boolean;
  need_escort: boolean;
  description: string | null;
}

/** `CardholderCreate` (schemas.py). */
export interface CardholderCreate {
  name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  employee_id?: string | null;
  email?: string | null;
  description?: string | null;
  pin_code?: string | null;
  department_uid?: string | null;
  security_group_uid?: string | null;
  access_groups?: string[];
  valid_from?: string | null;
  valid_until?: string | null;
  is_supervisor?: boolean;
  need_escort?: boolean;
}

/** `CardholderUpdate` (schemas.py) — PATCH semantics. */
export interface CardholderUpdate {
  name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  employee_id?: string | null;
  email?: string | null;
  description?: string | null;
  pin_code?: string | null;
  department_uid?: string | null;
  security_group_uid?: string | null;
  access_groups?: string[] | null;
  valid_from?: string | null;
  valid_until?: string | null;
  is_supervisor?: boolean | null;
  need_escort?: boolean | null;
}

/* --- cards (backend/access/app/access/writethrough.py) --------------------- */

/** `CardStatusBody.status` — the v2 CardStatus set. */
export type AccessCardStatus = "Free" | "Used" | "Canceled" | "Lost" | "Stolen" | "Archived";

/** The card shape `_card_from_dds` hand-builds: the DDS DTO with its seven
 *  known keys renamed to snake_case and `UID` lifted to `dds_uid`; every other
 *  DTO key passes through as-is, hence the index signature. */
export interface AccessCard {
  [key: string]: unknown;
  /** The DDS UID — the identifier every write path takes. */
  dds_uid: string;
  card_code: string;
  /** One of `AccessCardStatus` on a well-formed controller. */
  status: string;
  card_type: string | null;
  cardholder_uid: string | null;
  reader_function_uid: string | null;
  technology_type: number | null;
  description: string | null;
}

/** `CardCreate` (schemas.py). */
export interface CardCreate {
  card_code: string;
  status?: string;
  card_type?: string | null;
  cardholder_uid?: string | null;
  reader_function_uid?: string | null;
  /** 0–255. */
  technology_type?: number | null;
  description?: string | null;
}

/** `CardUpdate` (schemas.py) — PATCH semantics. */
export interface CardUpdate {
  card_code?: string | null;
  status?: string | null;
  card_type?: string | null;
  cardholder_uid?: string | null;
  reader_function_uid?: string | null;
  technology_type?: number | null;
  description?: string | null;
}

/* --- access groups + schedules (backend/access/app/access/schemas.py) ------ */

/** `AccessGroupPublic` — a LOCAL catalog row; its identifier is `group_id`. */
export interface AccessGroupPublic {
  group_id: string;
  name: string;
  description: string | null;
  access_group_type: string;
  /** The key itself is a credential and is never returned. */
  has_api_key: boolean;
  /** Local door ids (`AccessDoorPublic.id`). */
  door_ids: string[];
  schedule_id: string | null;
  created_at: string;
  updated_at: string;
}

/** `AccessGroupCreate`. */
export interface AccessGroupCreate {
  name: string;
  description?: string | null;
  access_group_type?: string;
  api_key?: string | null;
  door_ids?: string[];
  schedule_id?: string | null;
}

/** `AccessGroupUpdate` — PATCH semantics. */
export interface AccessGroupUpdate {
  name?: string | null;
  description?: string | null;
  access_group_type?: string | null;
  api_key?: string | null;
  door_ids?: string[] | null;
  schedule_id?: string | null;
}

/** `DoorUpdate` (schemas.py) — PATCH semantics; ids must be ones core minted. */
export interface DoorUpdate {
  name?: string | null;
  remote_ref?: string | null;
  site_id?: string | null;
  floor_id?: string | null;
  zone_id?: string | null;
  is_active?: boolean | null;
  metadata?: Record<string, unknown> | null;
}

/** `AccessGroupListResponse` — bare `items`, no paging. */
export interface AccessGroupListResponse {
  items: AccessGroupPublic[];
}

/** `TimeWindow` — days 0=Sun..6=Sat plus "HH:MM" bounds. */
export interface TimeWindow {
  days: number[];
  start_time: string;
  end_time: string;
}

/** `SchedulePublic` — a LOCAL catalog row; its identifier is `schedule_id`. */
export interface SchedulePublic {
  schedule_id: string;
  name: string;
  description: string | null;
  timezone: string;
  windows: TimeWindow[];
  /** YYYY-MM-DD. */
  holidays: string[];
  created_at: string;
  updated_at: string;
}

/** `ScheduleCreate`. */
export interface ScheduleCreate {
  name: string;
  description?: string | null;
  timezone?: string;
  windows?: TimeWindow[];
  holidays?: string[];
}

/** `ScheduleUpdate` — PATCH semantics. */
export interface ScheduleUpdate {
  name?: string | null;
  description?: string | null;
  timezone?: string | null;
  windows?: TimeWindow[] | null;
  holidays?: string[] | null;
}

/** `ScheduleListResponse` — bare `items`, no paging. */
export interface ScheduleListResponse {
  items: SchedulePublic[];
}

/* --- hardware + scheduled proxies (backend/access/app/access/commands.py) -- */

/** `HARDWARE_SETS`. */
export type HardwareSet = "sites" | "controllers" | "readers" | "inputs" | "outputs" | "alarm_zones" | "areas";

/** `SCHEDULED_SETS`. */
export type ScheduledSet = "scheduled_mags" | "scheduled_readers";

/** One controller DTO, PascalCase-normalised (`_normalize`); the key set varies
 *  by hardware set and firmware, so it is an opaque record. */
export type HardwareItem = Record<string, unknown>;

/** What `CommandService.list_hardware` / `list_scheduled` return. */
export interface HardwareListResponse<T = HardwareItem> {
  items: T[];
  count: number;
}

/** The cardholder / card list after `api.ts` folds each `MirrorRow`. */
export type AccessCardholderList = Paged<AccessCardholder>;
export type AccessCardList = Paged<AccessCard>;
