"use client";

// Ingest API module — categories + webhooks CRUD.
// Wraps the shared `api` axios instance (baseURL already "/api/v1"). Each call
// unwraps `.data` so callers get plain objects, mirroring lib/api/sites.js.
//
// Backend contract:
//   GET/POST         /ingest/categories
//   GET/PATCH/DELETE /ingest/categories/{id}
//   GET/POST         /ingest/webhooks
//   GET/PATCH/DELETE /ingest/webhooks/{id}
//     webhook fields: category_id, name, token, auth_type[none|api_key|basic],
//                     transform (JMESPath string), schema (JSON), is_active.
//   The public receiver `/ingest/hooks/{token}` is server-only — we only DISPLAY
//   the URL in the webhook detail (never call it).
import { api } from "@/lib/api";

const CATEGORIES = "/ingest/categories";
const WEBHOOKS = "/ingest/webhooks";

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

export const ingest = {
  categories: {
    list: (params = {}) => unwrap(api.get(`${CATEGORIES}${qs(params)}`)),
    get: (id) => unwrap(api.get(`${CATEGORIES}/${id}`)),
    create: (body) => unwrap(api.post(CATEGORIES, body)),
    update: (id, body) => unwrap(api.patch(`${CATEGORIES}/${id}`, body)),
    remove: (id) => unwrap(api.delete(`${CATEGORIES}/${id}`)),
  },

  webhooks: {
    list: (params = {}) => unwrap(api.get(`${WEBHOOKS}${qs(params)}`)),
    get: (id) => unwrap(api.get(`${WEBHOOKS}/${id}`)),
    create: (body) => unwrap(api.post(WEBHOOKS, body)),
    update: (id, body) => unwrap(api.patch(`${WEBHOOKS}/${id}`, body)),
    remove: (id) => unwrap(api.delete(`${WEBHOOKS}/${id}`)),
    // Dry-run: validate+transform a sample payload (no publish, no log).
    // → { schema_valid, schema_errors, transformed, transform_errors, would_publish_subject, auth_type }
    test: (id, payload) => unwrap(api.post(`${WEBHOOKS}/${id}/test`, { payload })),
    // Rotate the public receiver token (+ optional auth secret). Returned once.
    // → { id, token, ingest_url, auth_secret }
    rotateSecret: (id, rotate_auth_secret = false) =>
      unwrap(api.post(`${WEBHOOKS}/${id}/rotate-secret`, { rotate_auth_secret })),
  },

  // Inbound request audit trail (one row per receiver call).
  eventLogs: {
    list: (params = {}) => unwrap(api.get(`/ingest/event-logs${qs(params)}`)),
    get: (id) => unwrap(api.get(`/ingest/event-logs/${id}`)),
    replay: (id) => unwrap(api.post(`/ingest/event-logs/${id}/replay`, {})),
  },

  // Payload-driven routing rules per webhook (priority-ordered; first match wins).
  //   rule: { name, description?, priority, match_conditions:[{path,op,value?}],
  //           field_map:{}, event_type, target_domain?, enabled }
  eventRules: {
    list: (webhookId, params = {}) =>
      unwrap(api.get(`${WEBHOOKS}/${webhookId}/rules${qs(params)}`)),
    create: (webhookId, body) => unwrap(api.post(`${WEBHOOKS}/${webhookId}/rules`, body)),
    get: (ruleId) => unwrap(api.get(`/ingest/event-rules/${ruleId}`)),
    update: (ruleId, body) => unwrap(api.patch(`/ingest/event-rules/${ruleId}`, body)),
    remove: (ruleId) => unwrap(api.delete(`/ingest/event-rules/${ruleId}`)),
    // Dry-run a rule against a sample payload (existing rule or a proposed shape).
    // → { matched, condition_results:[{ok,op,path,actual,expected}], extracted, event_type }
    test: (ruleId, body) => unwrap(api.post(`/ingest/event-rules/${ruleId}/test`, body)),
  },
};

export default ingest;
