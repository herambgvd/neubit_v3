"use client";

// Security API module (P6-D) — the enterprise security admin surface: 2FA policy,
// LDAP/AD directory, OIDC SSO, and the four-eyes dual-authorization ledger. Wraps the
// shared `api` axios instance (baseURL already "/api/v1") and unwraps `.data`. The
// gateway routes "/api/v1/security/*" → the `core` (Python) service.
//
// Backend contract (core, all under /api/v1):
//   Policy:     GET/PUT  /security/policy
//   Directory:  GET/PUT/DELETE /security/directory · POST /security/directory/sync
//   SSO:        GET/PUT/DELETE /security/sso
//   Dual-auth:  GET /security/dual-auth?status= · GET /security/dual-auth/{id}
//               POST /security/dual-auth/{id}/approve|deny { note? }
//
// Secrets (LDAP bind_password, OIDC client_secret) are WRITE-ONLY — sent on save,
// never returned (the *Out shapes expose has_bind_password / has_client_secret).
import { api } from "@/lib/api";

const SECURITY = "/security";

const unwrap = (p) => p.then((r) => r.data);

function qs(params = {}) {
  const clean = {};
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") clean[k] = v;
  }
  const s = new URLSearchParams(clean).toString();
  return s ? `?${s}` : "";
}

export const security = {
  // ── 2FA-enforcement policy ────────────────────────────────────────────
  // { require_2fa, require_2fa_roles[], session_idle_minutes, updated_at }.
  policy: {
    get: () => unwrap(api.get(`${SECURITY}/policy`)),
    // PUT accepts partial: { require_2fa?, require_2fa_roles?, session_idle_minutes? }.
    update: (body) => unwrap(api.put(`${SECURITY}/policy`, body)),
  },

  // ── LDAP / AD directory ───────────────────────────────────────────────
  // GET returns the config or null. bind_password is write-only (has_bind_password flag).
  directory: {
    get: () => unwrap(api.get(`${SECURITY}/directory`)),
    upsert: (body) => unwrap(api.put(`${SECURITY}/directory`, body)),
    remove: () => unwrap(api.delete(`${SECURITY}/directory`)),
    // POST /security/directory/sync → { created, updated, skipped, errors[], live }.
    sync: () => unwrap(api.post(`${SECURITY}/directory/sync`, {})),
  },

  // ── OIDC SSO ──────────────────────────────────────────────────────────
  // GET returns the config or null. client_secret is write-only (has_client_secret flag).
  sso: {
    get: () => unwrap(api.get(`${SECURITY}/sso`)),
    upsert: (body) => unwrap(api.put(`${SECURITY}/sso`, body)),
    remove: () => unwrap(api.delete(`${SECURITY}/sso`)),
  },

  // ── Dual authorization (four-eyes) ────────────────────────────────────
  // Paginated ledger: { items, total, page, size } (core Page shape). A request is
  // raised by any user for a sensitive action; a DIFFERENT privileged user (with
  // dualauth.approve) approves or denies it.
  dualAuth: {
    // GET /security/dual-auth?status=pending|approved|denied|consumed&page=&size=
    list: (params = {}) => unwrap(api.get(`${SECURITY}/dual-auth${qs(params)}`)),
    get: (id) => unwrap(api.get(`${SECURITY}/dual-auth/${id}`)),
    approve: (id, note) => unwrap(api.post(`${SECURITY}/dual-auth/${id}/approve`, { note })),
    deny: (id, note) => unwrap(api.post(`${SECURITY}/dual-auth/${id}/deny`, { note })),
  },
};

export default security;
