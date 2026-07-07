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

export const workflow = {
  sops: resource("sops"),
  states: resource("states"),
  transitions: resource("transitions"),
  triggers: resource("triggers"),
  forms: resource("forms"),
  notifications: resource("notifications"),
  threatLevels: resource("threat-levels"),

  instances: {
    list: (params = {}) => unwrap(api.get(`${WF}/instances${qs(params)}`)),
    get: (id) => unwrap(api.get(`${WF}/instances/${id}`)),
    // Advance the state machine by transition_id (backend contract); `form_data` is
    // the filled form payload when the chosen transition requires one.
    transition: (id, body = {}) => unwrap(api.patch(`${WF}/instances/${id}/transition`, body)),
    assign: (id, assignee_id) =>
      unwrap(api.patch(`${WF}/instances/${id}/assign`, { assignee_id })),
  },
};

export default workflow;
