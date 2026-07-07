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
  },
};

export default ingest;
