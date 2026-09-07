"use client";

// Access-control (gates) API module — the v3 access service, mounted at /api/v1
// behind the gateway. Wraps the shared `api` axios instance and unwraps `.data`
// so callers get plain objects (mirrors features/ingest/api.js + lib/api/sites.js).
//
// Ported from neubit_v2's lib/api/gates.js: SAME method set (which tab calls what),
// but rebuilt against the v3 route contract — the v3 base is /access (not v2's
// /api/access/v2), events are PER-INSTANCE (no global SSE stream), and
// access-groups / schedules are top-level with a required `?instance_id=`.
//
// Backend contract (all under /api/v1):
//   instances     GET/POST /access/instances · GET/PATCH/DELETE /access/instances/{id}
//                 POST .../test-connection · POST .../reconcile · GET .../sync-jobs
//   cardholders   GET/POST/PATCH/DELETE /access/instances/{id}/cardholders[/{ch}]
//                 POST .../suspend · .../reinstate
//                 POST/DELETE .../cards[/{card}] · POST/DELETE .../access-groups[/{g}]
//   cards         GET /access/instances/{id}/cards · POST/PATCH/DELETE .../cards[/{card}]
//                 POST .../cards/{card}/status
//   access-groups GET/POST /access/access-groups?instance_id= · GET/PATCH/DELETE /access/access-groups/{id}?instance_id=
//   schedules     GET/POST /access/schedules?instance_id= · GET/PATCH/DELETE /access/schedules/{id}?instance_id=
//   doors         GET/POST /access/doors[?instance_id=] · GET/PATCH/DELETE /access/doors/{id} · POST .../unlock · .../lock
//   hardware      GET /access/instances/{id}/hardware/{set}
//   events        GET /access/instances/{id}/events (category,result,door_ref,cardholder_ref,event_type,from,to)
//   sync-jobs     GET /access/instances/{id}/sync-jobs
import type { AxiosResponse } from "axios";

import { api } from "@/lib/api";
import type { AccessDoorPublic, AccessInstancePublic, Paged, QueryParams } from "@/lib/types";
import type {
  AccessCard,
  AccessCardholder,
  AccessCardholderStatus,
  AccessCardList,
  AccessCardholderList,
  AccessEventPublic,
  AccessGroupCreate,
  AccessGroupListResponse,
  AccessGroupPublic,
  AccessGroupUpdate,
  CardCreate,
  CardUpdate,
  CardholderCreate,
  CardholderUpdate,
  DoorUpdate,
  HardwareItem,
  HardwareListResponse,
  HardwareSet,
  InstanceCreate,
  InstanceUpdate,
  MirrorRow,
  ScheduleCreate,
  ScheduleListResponse,
  SchedulePublic,
  ScheduleUpdate,
  ScheduledSet,
  SyncJobListResponse,
  SyncJobPublic,
  TestConnectionResponse,
} from "./types";

const BASE = "/access";

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

// ── Mirror rows → the cardholder / card shapes the tabs read ──────────
//
// GET .../cardholders and .../cards return `MirrorListResponse`: each item is a
// `MirrorRow` whose `dto` is the VERBATIM DDS DTO (PascalCase `UID`, `FirstName`,
// `CardCode` …). Every WRITE endpoint, by contrast, answers with the snake_case
// shape `writethrough._cardholder_from_dds` / `_card_from_dds` build — and that
// is the shape the tabs were written against. These two are ports of those
// backend functions so the list reads the same as the writes. Should the list
// routes one day map rows server-side, delete these and read `Paged<…>` directly.

/** A DTO value as text; anything that is not a string/number reads as "". */
const text = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

// `_CH_DDS_TO_STATUS` (writethrough.py).
const CH_DDS_TO_STATUS: Record<string, AccessCardholderStatus> = {
  Validated: "active",
  Invalidated: "suspended",
  Archived: "terminated",
};

/** Port of `writethrough._cardholder_from_dds`. */
function cardholderFromMirror(row: MirrorRow): AccessCardholder {
  const dto = row.dto || {};
  const first = text(dto.FirstName) || text(dto.firstName);
  const last = text(dto.LastName) || text(dto.lastName);
  const name = `${first} ${last}`.trim() || text(dto.Name) || text(dto.name) || "(unknown)";
  const ddsStatus = text(dto.Status) || text(dto.status) || "Validated";
  const agRaw = text(dto.AccessGroupUIDs) || text(dto.accessGroupUIDs);
  return {
    cardholder_id: text(dto.UID) || text(dto.uid) || "",
    name,
    first_name: first,
    last_name: last,
    employee_id: text(dto.CardholderIdNumber) || text(dto.cardholderIdNumber) || null,
    email: text(dto.Email) || text(dto.email) || null,
    cards: [],
    access_groups: agRaw
      .split(",")
      .map((g) => g.trim())
      .filter(Boolean),
    valid_from: dto.IsFromDateActive ? text(dto.FromDateValid) || null : null,
    valid_until: dto.IsToDateActive ? text(dto.ToDateValid) || null : null,
    status: CH_DDS_TO_STATUS[ddsStatus] || "active",
    photo_url: text(dto.Photo) || text(dto.photo) || null,
    department_uid: text(dto.DepartmentUID) || text(dto.departmentUID) || null,
    security_group_uid: text(dto.SecurityGroupUID) || text(dto.securityGroupUID) || null,
    is_supervisor: Boolean(dto.IsSupervisor || dto.isSupervisor),
    need_escort: Boolean(dto.NeedEscort || dto.needEscort),
    description: text(dto.Description) || text(dto.description) || null,
  };
}

// `_CARD_DDS_TO_SNAKE` + `_CARD_CAMEL_TO_SNAKE` (writethrough.py).
const CARD_KEY_TO_SNAKE: Record<string, string> = {
  CardCode: "card_code",
  cardCode: "card_code",
  Status: "status",
  status: "status",
  CardType: "card_type",
  cardType: "card_type",
  CardholderUID: "cardholder_uid",
  cardholderUID: "cardholder_uid",
  ReaderFunctionUID: "reader_function_uid",
  readerFunctionUID: "reader_function_uid",
  TechnologyType: "technology_type",
  technologyType: "technology_type",
  Description: "description",
  description: "description",
};

/** Port of `writethrough._card_from_dds`. */
function cardFromMirror(row: MirrorRow): AccessCard {
  const dto = row.dto || {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(dto)) {
    if (k.toUpperCase() === "UID") continue;
    out[CARD_KEY_TO_SNAKE[k] || k] = v;
  }
  const tt = out.technology_type;
  return {
    ...out,
    dds_uid: text(dto.UID) || text(dto.uid) || row.remote_uid || "",
    card_code: text(out.card_code),
    status: text(out.status),
    card_type: text(out.card_type) || null,
    cardholder_uid: text(out.cardholder_uid) || null,
    reader_function_uid: text(out.reader_function_uid) || null,
    technology_type: typeof tt === "number" ? tt : text(tt) !== "" && !Number.isNaN(Number(tt)) ? Number(tt) : null,
    description: text(out.description) || null,
  };
}

const foldMirror = <T>(page: Paged<MirrorRow>, fold: (row: MirrorRow) => T): Paged<T> => ({
  ...page,
  items: page.items.map(fold),
});

export const gates = {
  // ── Instances ─────────────────────────────────────────────────
  instances: {
    list: (params: QueryParams = {}) =>
      unwrap(api.get<Paged<AccessInstancePublic>>(`${BASE}/instances${qs(params)}`)),
    get: (id: string) => unwrap(api.get<AccessInstancePublic>(`${BASE}/instances/${id}`)),
    create: (body: InstanceCreate) => unwrap(api.post<AccessInstancePublic>(`${BASE}/instances`, body)),
    update: (id: string, body: InstanceUpdate) =>
      unwrap(api.patch<AccessInstancePublic>(`${BASE}/instances/${id}`, body)),
    remove: (id: string) => unwrap(api.delete<void>(`${BASE}/instances/${id}`)),
    // Probe upstream reachability → { ok, status, ... }.
    test: (id: string) => unwrap(api.post<TestConnectionResponse>(`${BASE}/instances/${id}/test-connection`, {})),
    // Queue a full reconcile → returns a sync-job document.
    reconcile: (id: string) => unwrap(api.post<SyncJobPublic>(`${BASE}/instances/${id}/reconcile`, {})),
    syncJobs: (id: string, params: QueryParams = {}) =>
      unwrap(api.get<SyncJobListResponse>(`${BASE}/instances/${id}/sync-jobs${qs(params)}`)),
  },

  // ── Cardholders (DDS write-through; reads from the local mirror) ─
  cardholders: {
    list: (instanceId: string, params: QueryParams = {}): Promise<AccessCardholderList> =>
      unwrap(api.get<Paged<MirrorRow>>(`${BASE}/instances/${instanceId}/cardholders${qs(params)}`)).then((page) =>
        foldMirror(page, cardholderFromMirror),
      ),
    // NOTE: the backend router exposes no GET for a single cardholder (only
    // list / POST / PATCH / DELETE + the action routes); this call 404s today.
    get: (instanceId: string, chId: string) =>
      unwrap(api.get<AccessCardholder>(`${BASE}/instances/${instanceId}/cardholders/${chId}`)),
    create: (instanceId: string, body: CardholderCreate) =>
      unwrap(api.post<AccessCardholder>(`${BASE}/instances/${instanceId}/cardholders`, body)),
    update: (instanceId: string, chId: string, body: CardholderUpdate) =>
      unwrap(api.patch<AccessCardholder>(`${BASE}/instances/${instanceId}/cardholders/${chId}`, body)),
    remove: (instanceId: string, chId: string) =>
      unwrap(api.delete<void>(`${BASE}/instances/${instanceId}/cardholders/${chId}`)),
    suspend: (instanceId: string, chId: string) =>
      unwrap(api.post<AccessCardholder>(`${BASE}/instances/${instanceId}/cardholders/${chId}/suspend`, {})),
    reinstate: (instanceId: string, chId: string) =>
      unwrap(api.post<AccessCardholder>(`${BASE}/instances/${instanceId}/cardholders/${chId}/reinstate`, {})),
    addCard: (instanceId: string, chId: string, cardId: string) =>
      unwrap(
        api.post<AccessCardholder>(`${BASE}/instances/${instanceId}/cardholders/${chId}/cards`, {
          card_id: cardId,
        }),
      ),
    removeCard: (instanceId: string, chId: string, cardId: string) =>
      unwrap(api.delete<AccessCardholder>(`${BASE}/instances/${instanceId}/cardholders/${chId}/cards/${cardId}`)),
    addGroup: (instanceId: string, chId: string, groupId: string) =>
      unwrap(
        api.post<AccessCardholder>(`${BASE}/instances/${instanceId}/cardholders/${chId}/access-groups`, {
          access_group_id: groupId,
        }),
      ),
    removeGroup: (instanceId: string, chId: string, groupId: string) =>
      unwrap(
        api.delete<AccessCardholder>(
          `${BASE}/instances/${instanceId}/cardholders/${chId}/access-groups/${groupId}`,
        ),
      ),
  },

  // ── Cards (DDS write-through) ─────────────────────────────────
  cards: {
    list: (instanceId: string, params: QueryParams = {}): Promise<AccessCardList> =>
      unwrap(api.get<Paged<MirrorRow>>(`${BASE}/instances/${instanceId}/cards${qs(params)}`)).then((page) =>
        foldMirror(page, cardFromMirror),
      ),
    create: (instanceId: string, body: CardCreate) =>
      unwrap(api.post<AccessCard>(`${BASE}/instances/${instanceId}/cards`, body)),
    update: (instanceId: string, cardId: string, body: CardUpdate) =>
      unwrap(api.patch<AccessCard>(`${BASE}/instances/${instanceId}/cards/${cardId}`, body)),
    remove: (instanceId: string, cardId: string) =>
      unwrap(api.delete<void>(`${BASE}/instances/${instanceId}/cards/${cardId}`)),
    setStatus: (instanceId: string, cardId: string, statusValue: string) =>
      unwrap(
        api.post<AccessCard>(`${BASE}/instances/${instanceId}/cards/${cardId}/status`, {
          status: statusValue,
        }),
      ),
  },

  // ── Access groups (LOCAL catalog, instance-scoped) ────────────
  accessGroups: {
    list: (instanceId: string, params: QueryParams = {}) =>
      unwrap(api.get<AccessGroupListResponse>(`${BASE}/access-groups${qs({ instance_id: instanceId, ...params })}`)),
    get: (instanceId: string, groupId: string) =>
      unwrap(api.get<AccessGroupPublic>(`${BASE}/access-groups/${groupId}${qs({ instance_id: instanceId })}`)),
    create: (instanceId: string, body: AccessGroupCreate) =>
      unwrap(api.post<AccessGroupPublic>(`${BASE}/access-groups${qs({ instance_id: instanceId })}`, body)),
    update: (instanceId: string, groupId: string, body: AccessGroupUpdate) =>
      unwrap(api.patch<AccessGroupPublic>(`${BASE}/access-groups/${groupId}${qs({ instance_id: instanceId })}`, body)),
    remove: (instanceId: string, groupId: string) =>
      unwrap(api.delete<void>(`${BASE}/access-groups/${groupId}${qs({ instance_id: instanceId })}`)),
  },

  // ── Schedules (LOCAL catalog, instance-scoped) ────────────────
  schedules: {
    list: (instanceId: string, params: QueryParams = {}) =>
      unwrap(api.get<ScheduleListResponse>(`${BASE}/schedules${qs({ instance_id: instanceId, ...params })}`)),
    get: (instanceId: string, scheduleId: string) =>
      unwrap(api.get<SchedulePublic>(`${BASE}/schedules/${scheduleId}${qs({ instance_id: instanceId })}`)),
    create: (instanceId: string, body: ScheduleCreate) =>
      unwrap(api.post<SchedulePublic>(`${BASE}/schedules${qs({ instance_id: instanceId })}`, body)),
    update: (instanceId: string, scheduleId: string, body: ScheduleUpdate) =>
      unwrap(api.patch<SchedulePublic>(`${BASE}/schedules/${scheduleId}${qs({ instance_id: instanceId })}`, body)),
    remove: (instanceId: string, scheduleId: string) =>
      unwrap(api.delete<void>(`${BASE}/schedules/${scheduleId}${qs({ instance_id: instanceId })}`)),
  },

  // ── Doors (local) ─────────────────────────────────────────────
  doors: {
    list: (params: QueryParams = {}) => unwrap(api.get<Paged<AccessDoorPublic>>(`${BASE}/doors${qs(params)}`)),
    get: (id: string) => unwrap(api.get<AccessDoorPublic>(`${BASE}/doors/${id}`)),
    update: (id: string, body: DoorUpdate) =>
      unwrap(api.patch<AccessDoorPublic>(`${BASE}/doors/${id}`, body)),
    // Both relay the controller's action result verbatim (DoorService.command).
    unlock: (id: string) => unwrap(api.post<Record<string, unknown>>(`${BASE}/doors/${id}/unlock`, {})),
    lock: (id: string) => unwrap(api.post<Record<string, unknown>>(`${BASE}/doors/${id}/lock`, {})),
  },

  // ── Hardware (read-only DDS proxy, per instance) ──────────────
  //   set ∈ sites | controllers | readers | inputs | outputs | alarm_zones | areas
  hardware: {
    list: (instanceId: string, set: HardwareSet, params: QueryParams = {}) =>
      unwrap(
        api.get<HardwareListResponse<HardwareItem>>(`${BASE}/instances/${instanceId}/hardware/${set}${qs(params)}`),
      ),
  },

  // ── Scheduled collections (read-only OData proxy, per instance) ─
  //   kind ∈ scheduled_mags | scheduled_readers → { items, count }.
  //   Weekly Programs are the `schedules` catalog (API_WeeklyPrograms) —
  //   use `schedules.list` for those.
  scheduled: {
    list: (instanceId: string, kind: ScheduledSet, params: QueryParams = {}) =>
      unwrap(
        api.get<HardwareListResponse<HardwareItem>>(`${BASE}/instances/${instanceId}/scheduled/${kind}${qs(params)}`),
      ),
  },

  // ── Events (per-instance; polled, no SSE in v3) ───────────────
  events: {
    list: (instanceId: string, params: QueryParams = {}) =>
      unwrap(api.get<Paged<AccessEventPublic>>(`${BASE}/instances/${instanceId}/events${qs(params)}`)),
  },
};

export default gates;
