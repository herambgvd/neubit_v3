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
import { api } from "@/lib/api";

const BASE = "/access";

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

export const gates = {
  // ── Instances ─────────────────────────────────────────────────
  instances: {
    list: (params = {}) => unwrap(api.get(`${BASE}/instances${qs(params)}`)),
    get: (id) => unwrap(api.get(`${BASE}/instances/${id}`)),
    create: (body) => unwrap(api.post(`${BASE}/instances`, body)),
    update: (id, body) => unwrap(api.patch(`${BASE}/instances/${id}`, body)),
    remove: (id) => unwrap(api.delete(`${BASE}/instances/${id}`)),
    // Probe upstream reachability → { ok, status, ... }.
    test: (id) => unwrap(api.post(`${BASE}/instances/${id}/test-connection`, {})),
    // Queue a full reconcile → returns a sync-job document.
    reconcile: (id) => unwrap(api.post(`${BASE}/instances/${id}/reconcile`, {})),
    syncJobs: (id, params = {}) =>
      unwrap(api.get(`${BASE}/instances/${id}/sync-jobs${qs(params)}`)),
  },

  // ── Cardholders (DDS write-through; reads from the local mirror) ─
  cardholders: {
    list: (instanceId, params = {}) =>
      unwrap(api.get(`${BASE}/instances/${instanceId}/cardholders${qs(params)}`)),
    get: (instanceId, chId) =>
      unwrap(api.get(`${BASE}/instances/${instanceId}/cardholders/${chId}`)),
    create: (instanceId, body) =>
      unwrap(api.post(`${BASE}/instances/${instanceId}/cardholders`, body)),
    update: (instanceId, chId, body) =>
      unwrap(api.patch(`${BASE}/instances/${instanceId}/cardholders/${chId}`, body)),
    remove: (instanceId, chId) =>
      unwrap(api.delete(`${BASE}/instances/${instanceId}/cardholders/${chId}`)),
    suspend: (instanceId, chId) =>
      unwrap(api.post(`${BASE}/instances/${instanceId}/cardholders/${chId}/suspend`, {})),
    reinstate: (instanceId, chId) =>
      unwrap(api.post(`${BASE}/instances/${instanceId}/cardholders/${chId}/reinstate`, {})),
    addCard: (instanceId, chId, cardId) =>
      unwrap(
        api.post(`${BASE}/instances/${instanceId}/cardholders/${chId}/cards`, {
          card_id: cardId,
        }),
      ),
    removeCard: (instanceId, chId, cardId) =>
      unwrap(api.delete(`${BASE}/instances/${instanceId}/cardholders/${chId}/cards/${cardId}`)),
    addGroup: (instanceId, chId, groupId) =>
      unwrap(
        api.post(`${BASE}/instances/${instanceId}/cardholders/${chId}/access-groups`, {
          access_group_id: groupId,
        }),
      ),
    removeGroup: (instanceId, chId, groupId) =>
      unwrap(
        api.delete(`${BASE}/instances/${instanceId}/cardholders/${chId}/access-groups/${groupId}`),
      ),
  },

  // ── Cards (DDS write-through) ─────────────────────────────────
  cards: {
    list: (instanceId, params = {}) =>
      unwrap(api.get(`${BASE}/instances/${instanceId}/cards${qs(params)}`)),
    create: (instanceId, body) =>
      unwrap(api.post(`${BASE}/instances/${instanceId}/cards`, body)),
    update: (instanceId, cardId, body) =>
      unwrap(api.patch(`${BASE}/instances/${instanceId}/cards/${cardId}`, body)),
    remove: (instanceId, cardId) =>
      unwrap(api.delete(`${BASE}/instances/${instanceId}/cards/${cardId}`)),
    setStatus: (instanceId, cardId, statusValue) =>
      unwrap(
        api.post(`${BASE}/instances/${instanceId}/cards/${cardId}/status`, {
          status: statusValue,
        }),
      ),
  },

  // ── Access groups (LOCAL catalog, instance-scoped) ────────────
  accessGroups: {
    list: (instanceId, params = {}) =>
      unwrap(api.get(`${BASE}/access-groups${qs({ instance_id: instanceId, ...params })}`)),
    get: (instanceId, groupId) =>
      unwrap(api.get(`${BASE}/access-groups/${groupId}${qs({ instance_id: instanceId })}`)),
    create: (instanceId, body) =>
      unwrap(api.post(`${BASE}/access-groups${qs({ instance_id: instanceId })}`, body)),
    update: (instanceId, groupId, body) =>
      unwrap(api.patch(`${BASE}/access-groups/${groupId}${qs({ instance_id: instanceId })}`, body)),
    remove: (instanceId, groupId) =>
      unwrap(api.delete(`${BASE}/access-groups/${groupId}${qs({ instance_id: instanceId })}`)),
  },

  // ── Schedules (LOCAL catalog, instance-scoped) ────────────────
  schedules: {
    list: (instanceId, params = {}) =>
      unwrap(api.get(`${BASE}/schedules${qs({ instance_id: instanceId, ...params })}`)),
    get: (instanceId, scheduleId) =>
      unwrap(api.get(`${BASE}/schedules/${scheduleId}${qs({ instance_id: instanceId })}`)),
    create: (instanceId, body) =>
      unwrap(api.post(`${BASE}/schedules${qs({ instance_id: instanceId })}`, body)),
    update: (instanceId, scheduleId, body) =>
      unwrap(api.patch(`${BASE}/schedules/${scheduleId}${qs({ instance_id: instanceId })}`, body)),
    remove: (instanceId, scheduleId) =>
      unwrap(api.delete(`${BASE}/schedules/${scheduleId}${qs({ instance_id: instanceId })}`)),
  },

  // ── Doors (local) ─────────────────────────────────────────────
  doors: {
    list: (params = {}) => unwrap(api.get(`${BASE}/doors${qs(params)}`)),
    get: (id) => unwrap(api.get(`${BASE}/doors/${id}`)),
    update: (id, body) => unwrap(api.patch(`${BASE}/doors/${id}`, body)),
    unlock: (id) => unwrap(api.post(`${BASE}/doors/${id}/unlock`, {})),
    lock: (id) => unwrap(api.post(`${BASE}/doors/${id}/lock`, {})),
  },

  // ── Hardware (read-only DDS proxy, per instance) ──────────────
  //   set ∈ sites | controllers | readers | inputs | outputs | alarm_zones | areas
  hardware: {
    list: (instanceId, set, params = {}) =>
      unwrap(api.get(`${BASE}/instances/${instanceId}/hardware/${set}${qs(params)}`)),
  },

  // ── Events (per-instance; polled, no SSE in v3) ───────────────
  events: {
    list: (instanceId, params = {}) =>
      unwrap(api.get(`${BASE}/instances/${instanceId}/events${qs(params)}`)),
  },
};

export default gates;
