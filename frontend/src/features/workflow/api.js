"use client";

// Workflow API module — SOP definitions (sops/states/transitions/triggers/forms/
// notifications/threat-levels) + runtime incidents (instances).
// Wraps the shared `api` axios instance (baseURL "/api/v1") and unwraps `.data`,
// mirroring lib/api/sites.js.
//
// Backend contract:
//   Definition CRUD (each is GET list / POST create / GET|PATCH|DELETE {id}):
//     /workflow/sops
//     /workflow/states
//     /workflow/transitions
//     /workflow/triggers
//     /workflow/forms
//     /workflow/notifications
//     /workflow/threat-levels
//   Incidents (runtime instances):
//     GET   /workflow/instances               (filters status/priority/site/sop, paginated)
//     GET   /workflow/instances/{id}
//     PATCH /workflow/instances/{id}/transition   body { to_state, form_data? }
//     PATCH /workflow/instances/{id}/assign       body { assignee_id }
import { api } from "@/lib/api";

const WF = "/workflow";

const unwrap = (p) => p.then((r) => r.data);

function qs(params = {}) {
  const clean = {};
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") clean[k] = v;
  }
  const s = new URLSearchParams(clean).toString();
  return s ? `?${s}` : "";
}

// Factory for the seven identical definition resources.
function resource(path) {
  const base = `${WF}/${path}`;
  return {
    list: (params = {}) => unwrap(api.get(`${base}${qs(params)}`)),
    get: (id) => unwrap(api.get(`${base}/${id}`)),
    create: (body) => unwrap(api.post(base, body)),
    update: (id, body) => unwrap(api.patch(`${base}/${id}`, body)),
    remove: (id) => unwrap(api.delete(`${base}/${id}`)),
  };
}

// States + transitions are NESTED under a SOP on the backend
// (/workflow/sops/{sop_id}/states, .../transitions) — not flat resources.
function nested(child) {
  return {
    list: (sopId, params = {}) => unwrap(api.get(`${WF}/sops/${sopId}/${child}${qs(params)}`)),
    create: (sopId, body) => unwrap(api.post(`${WF}/sops/${sopId}/${child}`, body)),
    update: (sopId, childId, body) => unwrap(api.patch(`${WF}/sops/${sopId}/${child}/${childId}`, body)),
    remove: (sopId, childId) => unwrap(api.delete(`${WF}/sops/${sopId}/${child}/${childId}`)),
  };
}

export const workflow = {
  sops: resource("sops"),
  states: nested("states"),
  transitions: nested("transitions"),
  triggers: {
    ...resource("triggers"),
    enable: (id) => unwrap(api.post(`${WF}/triggers/${id}/enable`)),
    disable: (id) => unwrap(api.post(`${WF}/triggers/${id}/disable`)),
  },
  forms: resource("forms"),

  // Alert formats — map an alert_code to a SOP (category/severity/priority/icon/sound).
  alertFormats: resource("alert-formats"),

  // Dry-run (or live) a synthetic event through trigger + alert-format matching.
  //   body { event_type, payload?, site_id?, alert_code?, dry_run=true }
  //   → { matched_triggers, matched_format, skipped, created_instance_id?, ... }
  simulate: (body) => unwrap(api.post(`${WF}/events/simulate`, body)),

  // Notifications split into templates + channels (backend: /notifications/{templates,channels}).
  notifications: {
    templates: resource("notifications/templates"),
    channels: resource("notifications/channels"),
  },

  // Threat-level is a per-site (or deployment-wide) posture register: GET list + PUT set.
  threatLevels: {
    list: (params = {}) => unwrap(api.get(`${WF}/threat-levels${qs(params)}`)),
    set: (body) => unwrap(api.put(`${WF}/threat-levels`, body)),
  },

  instances: {
    // GET /workflow/instances — filters: q, status, priority, site_id, sop_id,
    // assigned_to, skip/limit, plus the CROSS-LINK filters:
    //   • event_id — incidents spawned by an originating event id. Matches EITHER
    //     the bus-envelope id OR trigger_data.payload.event_id, so passing a CAMERA
    //     event id (VmsEvent.id) finds the incident that camera event raised.
    //   • source   — originating domain: "vision" (camera events) | "access" |
    //     "ingest" | … | "manual" (operator-raised, no trigger envelope).
    // Each incident row also carries derived `event_source` + `source_event_id`.
    list: (params = {}) => unwrap(api.get(`${WF}/instances${qs(params)}`)),
    get: (id) => unwrap(api.get(`${WF}/instances/${id}`)),
    stats: (params = {}) => unwrap(api.get(`${WF}/instances/stats${qs(params)}`)),
    availableTransitions: (id) => unwrap(api.get(`${WF}/instances/${id}/available-transitions`)),
    // Advance the state machine by transition_id (backend contract); `form_data` is
    // the filled form payload when the chosen transition requires one.
    transition: (id, body = {}) => unwrap(api.patch(`${WF}/instances/${id}/transition`, body)),
    assign: (id, assigned_to) =>
      unwrap(api.patch(`${WF}/instances/${id}/assign`, { assigned_to: assigned_to || null })),
    // Status machine: pause/resume/resolve/cancel via {status, outcome?}.
    setStatus: (id, status, outcome) =>
      unwrap(api.patch(`${WF}/instances/${id}/status`, { status, outcome })),
    escalate: (id, reason) =>
      unwrap(api.patch(`${WF}/instances/${id}/escalate`, { reason })),
    // Incident PDF export — fetched as an authed blob (header auth; <a> can't set it).
    pdfBlob: (id) => api.get(`${WF}/instances/${id}/pdf`, { responseType: "blob" }).then((r) => r.data),
  },
};

export default workflow;
