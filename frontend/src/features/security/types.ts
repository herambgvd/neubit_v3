// Wire types local to the enterprise security feature (2FA policy, LDAP/AD
// directory, OIDC SSO, four-eyes dual authorization). Each interface mirrors one
// Pydantic model in backend/core/app/security/schemas.py. Dates cross the wire
// as ISO-8601 strings; `dict` fields become `Record<string, …>`.
//
// Secrets (LDAP bind_password, OIDC client_secret) are WRITE-ONLY: they are sent
// on save and never returned — the *Out shapes carry a has_* flag instead.

/** A group/claim value → role name map (`group_role_map`). */
export type RoleMap = Record<string, string>;

/* --- Security policy (2FA enforcement) ----------------------------------- */

/** `SecurityPolicyOut`. */
export interface SecurityPolicyOut {
  require_2fa: boolean;
  /** Empty = enforce for everyone. */
  require_2fa_roles: string[];
  /** 0 = no idle timeout. */
  session_idle_minutes: number;
  updated_at: string | null;
}

/** `SecurityPolicyIn` — PUT accepts a partial. */
export interface SecurityPolicyIn {
  require_2fa?: boolean | null;
  require_2fa_roles?: string[] | null;
  session_idle_minutes?: number | null;
}

/* --- LDAP / AD directory -------------------------------------------------- */

/** `DirectoryConfigOut` — GET returns this or null when unconfigured. */
export interface DirectoryConfigOut {
  id: string;
  name: string;
  enabled: boolean;
  server_uri: string;
  base_dn: string;
  bind_dn: string;
  has_bind_password: boolean;
  use_ssl: boolean;
  user_dn_base: string | null;
  user_filter: string;
  email_attr: string;
  name_attr: string;
  group_attr: string;
  group_role_map: RoleMap;
  default_role: string | null;
  last_sync_at: string | null;
  created_at: string;
}

/** `DirectoryConfigIn`. */
export interface DirectoryConfigIn {
  name: string;
  enabled: boolean;
  server_uri: string;
  base_dn: string;
  bind_dn: string;
  /** Write-only — omit to keep the stored password. */
  bind_password?: string;
  use_ssl: boolean;
  user_dn_base: string | null;
  user_filter: string;
  email_attr: string;
  name_attr: string;
  group_attr: string;
  group_role_map: RoleMap;
  default_role: string | null;
}

/** `DirectorySyncResult`. `live: false` = the scaffolding path (no real bind). */
export interface DirectorySyncResult {
  created: number;
  updated: number;
  skipped: number;
  errors: Record<string, unknown>[];
  live: boolean;
}

/* --- OIDC SSO ------------------------------------------------------------- */

/** `SsoConfigOut` — GET returns this or null when unconfigured. */
export interface SsoConfigOut {
  id: string;
  provider: string;
  enabled: boolean;
  issuer: string;
  client_id: string;
  has_client_secret: boolean;
  scopes: string;
  redirect_uri: string | null;
  email_claim: string;
  name_claim: string;
  groups_claim: string | null;
  group_role_map: RoleMap;
  default_role: string | null;
  auto_provision: boolean;
  created_at: string;
}

/** `SsoConfigIn`. */
export interface SsoConfigIn {
  provider: string;
  enabled: boolean;
  issuer: string;
  client_id: string;
  /** Write-only — omit to keep the stored secret. */
  client_secret?: string;
  scopes: string;
  redirect_uri: string | null;
  email_claim: string;
  name_claim: string;
  groups_claim: string | null;
  group_role_map: RoleMap;
  default_role: string | null;
  auto_provision: boolean;
}

/* --- Dual authorization (four-eyes) --------------------------------------- */

/** The lifecycle of a dual-auth request. */
export type DualAuthStatus = "pending" | "approved" | "denied" | "consumed" | "expired";

/** `DualAuthRequestOut`. */
export interface DualAuthRequestOut {
  id: string;
  action: string;
  target_type: string | null;
  target_id: string | null;
  reason: string | null;
  payload: Record<string, unknown>;
  status: DualAuthStatus;
  requested_by: string | null;
  requested_by_email: string | null;
  decided_by: string | null;
  decided_by_email: string | null;
  decided_at: string | null;
  decision_note: string | null;
  expires_at: string | null;
  created_at: string;
}
