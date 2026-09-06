"use client";

// Tags API module — cross-cutting, color-coded labels + a generic tagging
// association (assign/unassign any entity, e.g. a site or zone).
//
// Wraps the shared `api` axios instance (baseURL already "/api/v1") and unwraps
// `.data` so callers keep receiving plain objects — same convention as sites.js.
// Paths are relative to /api/v1 → "/tags".
import type { AxiosResponse } from "axios";

import { api } from "@/lib/api";
import type {
  CreateTagRequest,
  Paged,
  QueryParams,
  TagAssignRequest,
  TagLinkPublic,
  TagPublic,
  UpdateTagRequest,
} from "@/lib/types";

const TAGS = "/tags";

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

export const tags = {
  list: (params: QueryParams = {}) => unwrap(api.get<Paged<TagPublic>>(`${TAGS}${qs(params)}`)),
  get: (id: string) => unwrap(api.get<TagPublic>(`${TAGS}/${id}`)),
  create: (body: CreateTagRequest) => unwrap(api.post<TagPublic>(TAGS, body)),
  update: (id: string, body: UpdateTagRequest) => unwrap(api.patch<TagPublic>(`${TAGS}/${id}`, body)),
  remove: (id: string) => unwrap(api.delete<void>(`${TAGS}/${id}`)),

  // Attach / detach a tag to / from an entity (site, zone, … ).
  assign: (id: string, { entity_type, entity_id }: TagAssignRequest) =>
    unwrap(api.post<TagPublic>(`${TAGS}/${id}/assign`, { entity_type, entity_id })),
  unassign: (id: string, { entity_type, entity_id }: TagAssignRequest) =>
    unwrap(api.post<TagPublic>(`${TAGS}/${id}/unassign`, { entity_type, entity_id })),

  // Reverse lookups.
  entities: (id: string) => unwrap(api.get<TagLinkPublic[]>(`${TAGS}/${id}/entities`)),
  forEntity: (entityType: string, entityId: string) =>
    unwrap(api.get<TagPublic[]>(`${TAGS}/for/${entityType}/${entityId}`)),
};

export default tags;
