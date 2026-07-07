"use client";

// Tags API module — cross-cutting, color-coded labels + a generic tagging
// association (assign/unassign any entity, e.g. a site or zone).
//
// Wraps the shared `api` axios instance (baseURL already "/api/v1") and unwraps
// `.data` so callers keep receiving plain objects — same convention as sites.js.
// Paths are relative to /api/v1 → "/tags".
import { api } from "@/lib/api";

const TAGS = "/tags";

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

export const tags = {
  list: (params = {}) => unwrap(api.get(`${TAGS}${qs(params)}`)),
  get: (id) => unwrap(api.get(`${TAGS}/${id}`)),
  create: (body) => unwrap(api.post(TAGS, body)),
  update: (id, body) => unwrap(api.patch(`${TAGS}/${id}`, body)),
  remove: (id) => unwrap(api.delete(`${TAGS}/${id}`)),

  // Attach / detach a tag to / from an entity (site, zone, … ).
  assign: (id, { entity_type, entity_id }) =>
    unwrap(api.post(`${TAGS}/${id}/assign`, { entity_type, entity_id })),
  unassign: (id, { entity_type, entity_id }) =>
    unwrap(api.post(`${TAGS}/${id}/unassign`, { entity_type, entity_id })),

  // Reverse lookups.
  entities: (id) => unwrap(api.get(`${TAGS}/${id}/entities`)),
  forEntity: (entityType, entityId) =>
    unwrap(api.get(`${TAGS}/for/${entityType}/${entityId}`)),
};

export default tags;
