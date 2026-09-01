// Metric registry API — the /bi/metrics/* surface, served by the reading-writer
// beside the rest of Building Intelligence (backend/reading-writer/app/api/metrics.py).
//
// A METRIC here is a ROW, not code: a formula over named point ROLES with unit
// requirements and guards, versioned so an old window keeps the formula it was
// measured under. This module is deliberately separate from features/bi/api.ts —
// same conventions, different owner.
//
// Backend contract:
//   GET  /bi/metrics                    every definition (all versions)
//   POST /bi/metrics                    register (bi.manage) — TYPE-CHECKED on
//                                       insert; a spec like kWh − °C is a 422
//   GET  /bi/metrics/evaluate           ?metric&device_id&hours|start,end&resolution
//   GET  /bi/metrics/roles              points + confirmed role + tag SUGGESTION
//   POST /bi/metrics/roles/confirm      {point_ids, role} (bi.manage); role:null clears
//
// HONESTY, inherited from the rest of BI and mechanized server-side:
//   • evaluate reads ROLLUPS only and returns its resolution + reason;
//   • a guard failure is {status, reason} per device — blocked / missing_role /
//     unit_unconfirmed / undefined_frozen / … — NEVER a zero. Render the reason.
//   • a role suggestion carries the matched pattern in words and is never
//     stored until an operator confirms an explicit list of point ids.
import { api } from "@/lib/api";

const M = "/bi/metrics";

const unwrap = (p: Promise<any>): Promise<any> => p.then((r) => r.data);

function qs(params: any = {}) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries<any>(params)) {
    if (v === undefined || v === null || v === "") continue;
    sp.append(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

export const metrics = {
  /** Every definition visible to this tenant — every version, newest first. */
  list: () => unwrap(api.get(M)),

  /** Register a definition as the NEXT version of its key (bi.manage).
   *  Rejected with the dimension error verbatim if it does not type-check. */
  register: (definition: any) => unwrap(api.post(M, definition)),

  /** Evaluate over a window. Returns per-device {status, value, inputs,
   *  arithmetic, series} — status !== "ok" means render the reason, never 0. */
  evaluate: ({ metric, device_id, hours, start, end, resolution }: any) =>
    unwrap(api.get(`${M}/evaluate${qs({ metric, device_id, hours, start, end, resolution })}`)),

  /** Points with their confirmed role, the tag's SUGGESTION (with the matched
   *  pattern in words), and the closed role vocabulary for the picker. */
  roles: ({ category, search, confirmed, limit, offset }: any = {}) =>
    unwrap(api.get(`${M}/roles${qs({ category, search, confirmed, limit, offset })}`)),

  /** Operator asserts (role) or retracts (role: null) for explicit point ids. */
  confirmRoles: ({ point_ids, role }: { point_ids: string[]; role: string | null }) =>
    unwrap(api.post(`${M}/roles/confirm`, { point_ids, role })),
};
