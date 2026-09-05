"use client";

// DashForge embed registry API — the NeuBit side of the DashForge integration.
//
// Served by core's `app/dashforge` module (`backend/core/app/dashforge`). It was
// a `dashforge` satellite peeled off at the gateway until 2026-09-05; the prefix
// now falls through to core with the rest of `/api/`. Nothing on this side
// changed, because nothing here ever named a service — every call goes through
// the gateway prefix, which is the reason the move needed no frontend edit.
//
// Backend contract:
//   GET    /dashforge/dashboards            ?search        (dashforge.read)
//   POST   /dashforge/dashboards                           (dashforge.manage)
//   GET    /dashforge/dashboards/{id}                      (dashforge.read)
//   PATCH  /dashforge/dashboards/{id}                      (dashforge.manage)
//   DELETE /dashforge/dashboards/{id}                      (dashforge.manage)
//   POST   /dashforge/dashboards/{id}/session              (dashforge.read)
//
// WHAT THE LIST DELIBERATELY DOES NOT CARRY: a token. A registration is a
// pointer and a name; the credential comes only from `session()`, which is a
// separate call behind its own permission check. Attaching a token to the list
// response would make that check decorative — every account that can load the
// console would hold a working credential to the dashboard's data.
//
// `session()` is a POST for something that reads because it MINTS a credential
// and meters a query quota on the DashForge side: it is not cacheable and must
// not be a GET a proxy or a link prefetch can replay.
import { api } from "@/lib/api";

const BASE = "/dashforge/dashboards";

const unwrap = (p: Promise<any>): Promise<any> => p.then((r) => r.data);

export interface DashForgeEmbed {
  id: string;
  name: string;
  description: string | null;
  /** DashForge's own workspace / dashboard ids. Strings on purpose — NeuBit does
   *  not encode another product's key type. */
  workspace_ref: string;
  dashboard_ref: string;
  /** Filter bindings locked into the embed token's signature. A viewer cannot
   *  override one or widen the view by omitting it. */
  scope: Record<string, string>;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface DashForgeSession {
  embed_id: string;
  token: string;
  /** Absolute and browser-resolvable — built server-side from
   *  VE_DASHFORGE_PUBLIC_URL, never from the internal service name. */
  iframe_url: string;
  /** DashForge's own expiry, passed through. The re-mint timer reads THIS rather
   *  than a locally assumed lifetime, so the two cannot drift. */
  expires_at: string;
  scope: Record<string, string>;
}

export const dashforge = {
  list: (search?: string): Promise<{ items: DashForgeEmbed[]; total: number }> =>
    unwrap(api.get(BASE, { params: search ? { search } : undefined })),

  register: (body: {
    name: string;
    description?: string | null;
    workspace_ref: string;
    dashboard_ref: string;
    scope?: Record<string, string>;
  }): Promise<DashForgeEmbed> => unwrap(api.post(BASE, body)),

  update: (id: string, body: Partial<DashForgeEmbed>): Promise<DashForgeEmbed> =>
    unwrap(api.patch(`${BASE}/${id}`, body)),

  remove: (id: string): Promise<void> => unwrap(api.delete(`${BASE}/${id}`)),

  session: (id: string): Promise<DashForgeSession> => unwrap(api.post(`${BASE}/${id}/session`)),
};
