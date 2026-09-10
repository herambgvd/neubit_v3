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
import type { AxiosResponse } from "axios";

import { api } from "@/lib/api";
import type { Paged, QueryParams } from "@/lib/types";
import type {
  AlertFormatPublic,
  ChannelPublic,
  CreateAlertFormatRequest,
  CreateChannelRequest,
  CreateFormRequest,
  CreateInstanceRequest,
  CreateSopRequest,
  CreateStateRequest,
  CreateTemplateRequest,
  CreateTransitionRequest,
  CreateTriggerRequest,
  FormPublic,
  InstancePublic,
  InstanceStatsResponse,
  InstanceStatus,
  InstallStartersResponse,
  SetThreatLevelRequest,
  SimulateEventRequest,
  SimulateEventResponse,
  SopPublic,
  StatePublic,
  TemplatePublic,
  ThreatLevelPublic,
  TransitionInstanceRequest,
  TransitionPublic,
  TriggerPublic,
} from "./types";

const WF = "/workflow";

const unwrap = <T>(p: Promise<AxiosResponse<T>>): Promise<T> => p.then((r) => r.data);

function qs(params: QueryParams = {}): string {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") clean[k] = String(v);
  }
  const s = new URLSearchParams(clean).toString();
  return s ? `?${s}` : "";
}

// Factory for the seven identical definition resources. `List` is the list
// envelope: most resources page (`Paged<Pub>`), forms + notifications return a
// bare array. `Update` is the PATCH body (every field optional).
function resource<Pub, Create, List = Paged<Pub>, Update = Partial<Create>>(path: string) {
  const base = `${WF}/${path}`;
  return {
    list: (params: QueryParams = {}) => unwrap(api.get<List>(`${base}${qs(params)}`)),
    get: (id: string) => unwrap(api.get<Pub>(`${base}/${id}`)),
    create: (body: Create) => unwrap(api.post<Pub>(base, body)),
    update: (id: string, body: Update) => unwrap(api.patch<Pub>(`${base}/${id}`, body)),
    remove: (id: string) => unwrap(api.delete<void>(`${base}/${id}`)),
  };
}

// States + transitions are NESTED under a SOP on the backend
// (/workflow/sops/{sop_id}/states, .../transitions) — not flat resources. Their
// lists are bare arrays (`list[StatePublic]`), not paged.
function nested<Pub, Create, Update = Partial<Create>>(child: string) {
  return {
    list: (sopId: string, params: QueryParams = {}) =>
      unwrap(api.get<Pub[]>(`${WF}/sops/${sopId}/${child}${qs(params)}`)),
    create: (sopId: string, body: Create) => unwrap(api.post<Pub>(`${WF}/sops/${sopId}/${child}`, body)),
    update: (sopId: string, childId: string, body: Update) =>
      unwrap(api.patch<Pub>(`${WF}/sops/${sopId}/${child}/${childId}`, body)),
    remove: (sopId: string, childId: string) =>
      unwrap(api.delete<void>(`${WF}/sops/${sopId}/${child}/${childId}`)),
  };
}

export const workflow = {
  sops: {
    ...resource<SopPublic, CreateSopRequest>("sops"),
    // POST /workflow/sops/starters — install the starter playbooks this tenant is
    // missing. Idempotent, so it is safe behind a button somebody presses twice.
    installStarters: () => unwrap(api.post<InstallStartersResponse>(`${WF}/sops/starters`, {})),
  },
  states: nested<StatePublic, CreateStateRequest>("states"),
  transitions: nested<TransitionPublic, CreateTransitionRequest>("transitions"),
  triggers: {
    ...resource<TriggerPublic, CreateTriggerRequest>("triggers"),
    enable: (id: string) => unwrap(api.post<TriggerPublic>(`${WF}/triggers/${id}/enable`)),
    disable: (id: string) => unwrap(api.post<TriggerPublic>(`${WF}/triggers/${id}/disable`)),
  },
  forms: resource<FormPublic, CreateFormRequest, FormPublic[]>("forms"),

  // Alert formats — map an alert_code to a SOP (category/severity/priority/icon/sound).
  alertFormats: resource<AlertFormatPublic, CreateAlertFormatRequest>("alert-formats"),

  // Dry-run (or live) a synthetic event through trigger + alert-format matching.
  //   body { event_type, payload?, site_id?, alert_code?, dry_run=true }
  //   → { matched_triggers, matched_format, skipped, created_instance_id?, ... }
  simulate: (body: SimulateEventRequest) =>
    unwrap(api.post<SimulateEventResponse>(`${WF}/events/simulate`, body)),

  // Notifications split into templates + channels (backend: /notifications/{templates,channels}).
  notifications: {
    templates: resource<TemplatePublic, CreateTemplateRequest, TemplatePublic[]>("notifications/templates"),
    channels: resource<ChannelPublic, CreateChannelRequest, ChannelPublic[]>("notifications/channels"),
  },

  // Threat-level is a per-site (or deployment-wide) posture register: GET list + PUT set.
  threatLevels: {
    list: (params: QueryParams = {}) =>
      unwrap(api.get<ThreatLevelPublic[]>(`${WF}/threat-levels${qs(params)}`)),
    set: (body: SetThreatLevelRequest) => unwrap(api.put<ThreatLevelPublic>(`${WF}/threat-levels`, body)),
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
    list: (params: QueryParams = {}) =>
      unwrap(api.get<Paged<InstancePublic>>(`${WF}/instances${qs(params)}`)),
    // POST /workflow/instances — an operator raising an incident by hand, which is
    // what "escalate this event" is. The correlation engine uses the same table by
    // a different door.
    create: (body: CreateInstanceRequest) =>
      unwrap(api.post<InstancePublic>(`${WF}/instances`, body)),
    get: (id: string) => unwrap(api.get<InstancePublic>(`${WF}/instances/${id}`)),
    stats: (params: QueryParams = {}) =>
      unwrap(api.get<InstanceStatsResponse>(`${WF}/instances/stats${qs(params)}`)),
    availableTransitions: (id: string) =>
      unwrap(api.get<TransitionPublic[]>(`${WF}/instances/${id}/available-transitions`)),
    // Advance the state machine by transition_id (backend contract); `form_data` is
    // the filled form payload when the chosen transition requires one.
    transition: (id: string, body: TransitionInstanceRequest) =>
      unwrap(api.patch<InstancePublic>(`${WF}/instances/${id}/transition`, body)),
    assign: (id: string, assigned_to: string | null | undefined) =>
      unwrap(api.patch<InstancePublic>(`${WF}/instances/${id}/assign`, { assigned_to: assigned_to || null })),
    // Status machine: pause/resume/resolve/cancel via {status, outcome?}.
    setStatus: (id: string, status: InstanceStatus, outcome?: string | null) =>
      unwrap(api.patch<InstancePublic>(`${WF}/instances/${id}/status`, { status, outcome })),
    escalate: (id: string, reason: string | null | undefined) =>
      unwrap(api.patch<InstancePublic>(`${WF}/instances/${id}/escalate`, { reason })),
    // Incident PDF export — fetched as an authed blob (header auth; <a> can't set it).
    pdfBlob: (id: string) =>
      api.get<Blob>(`${WF}/instances/${id}/pdf`, { responseType: "blob" }).then((r) => r.data),
  },
};

export default workflow;
