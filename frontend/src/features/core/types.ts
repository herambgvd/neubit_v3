// Wire types local to the core feature (auth admin, audit, security posture,
// settings, messaging, licensing). Each interface mirrors one Pydantic model —
// the backend file is named per block. Dates cross the wire as ISO-8601 strings;
// `dict` fields become `Record<string, unknown>`. Shapes shared across features
// (SitePublic, TagPublic, AuthUser, Entitlements, …) live in @/lib/types.
import type { BrandingOut } from "@/lib/types";

/* --- auth: roles + users (backend/core/app/auth/schemas.py) ---------------- */

/** `RoleOut`. */
export interface RoleOut {
  id: string;
  name: string;
  description: string | null;
  /** Permission keys; `"*"` is the Administrator wildcard. */
  permissions: string[];
  is_system: boolean;
  created_at: string;
}

/** `UserOut` — a user as the admin console lists them. */
export interface UserOut {
  id: string;
  email: string;
  full_name: string | null;
  role: RoleOut;
  is_superadmin: boolean;
  is_active: boolean;
  email_verified: boolean;
  created_at: string;
  last_login_at: string | null;
  avatar_url: string | null;
  preferences: Record<string, unknown>;
  totp_enabled: boolean;
  failed_login_count: number;
  locked_until: string | null;
  /** Derived: auto lockout OR an admin lock. */
  locked: boolean;
  password_changed_at: string | null;
  active_sessions: number;
  /** Site ids the user is confined to; EMPTY = unrestricted. */
  site_ids: string[];
}

/** `CreateUserIn` — the Add-user form body. */
export interface CreateUserIn {
  email: string;
  password: string;
  full_name?: string | null;
  role_id: string;
  is_active?: boolean;
  send_invite?: boolean;
  site_ids?: string[];
}

/** `UpdateUserIn` — PATCH semantics; only sent fields change. */
export interface UpdateUserIn {
  role_id?: string | null;
  is_active?: boolean | null;
  full_name?: string | null;
  email?: string | null;
  password?: string | null;
  /** null/omitted = unchanged; a list (incl. []) REPLACES the scope. */
  site_ids?: string[] | null;
}

/** `CloneUserIn`. */
export interface CloneUserIn {
  email: string;
  full_name?: string | null;
  send_invite?: boolean;
}

/** POST /auth/users/import — hand-built dict in auth/routes/users.py. */
export interface UserImportResult {
  created: number;
  skipped: number;
  errors: Record<string, unknown>[];
}

/** `CreateRoleIn` / `UpdateRoleIn` share the role form's fields. */
export interface RoleBody {
  name: string;
  description?: string | null;
  permissions?: string[];
}

/** `SessionOut` — a live login session. */
export interface SessionOut {
  id: string;
  user_agent: string | null;
  ip: string | null;
  created_at: string;
  last_used_at: string | null;
  current: boolean;
}

/** GET /auth/setup-status — auth/routes/session.py. */
export interface SetupStatus {
  needs_setup: boolean;
}

/** `TokenOut` — what first-run setup answers with. */
export interface TokenOut {
  access_token: string;
  refresh_token: string;
  token_type: string;
}

/** `TotpSetupOut` — the secret to enrol in an authenticator app. */
export interface TotpSetupOut {
  secret: string;
  otpauth_uri: string;
}

/** `RecoveryCodesOut`. */
export interface RecoveryCodesOut {
  recovery_codes: string[];
}

/** `TotpStatusOut` — GET /auth/me/2fa. */
export interface TotpStatusOut {
  enabled: boolean;
  recovery_codes_remaining: number;
}

/* --- auth: permission catalog (backend/core/app/auth/permissions.py) ------- */

/** One `Permission` as `grouped()` emits it for the role editor. */
export interface PermissionEntry {
  key: string;
  label: string;
  description: string;
}

/** GET /auth/permissions → `{ groups: { "<Category>": [PermissionEntry, …] } }`. */
export type PermissionGroups = Record<string, PermissionEntry[]>;

export interface PermissionCatalog {
  groups: PermissionGroups;
}

/* --- auth: API keys (backend/core/app/auth/schemas.py) --------------------- */

/** `ApiKeyOut` — the secret is never here. */
export interface ApiKeyOut {
  id: string;
  name: string;
  description: string | null;
  prefix: string;
  scopes: string[];
  role: RoleOut | null;
  is_active: boolean;
  expires_at: string | null;
  revoked_at: string | null;
  created_by: string | null;
  created_at: string;
  last_used_at: string | null;
}

/** `ApiKeyCreatedOut` — the raw key, returned ONCE at creation. */
export interface ApiKeyCreatedOut extends ApiKeyOut {
  key: string;
}

/* --- audit (backend/core/app/core/audit.py) -------------------------------- */

/** `AuditLogOut`. */
export interface AuditLogOut {
  id: string;
  tenant_id: string | null;
  actor_id: string | null;
  actor_email: string | null;
  actor_name: string | null;
  actor_type: string;
  action: string;
  target_type: string | null;
  target_id: string | null;
  meta: Record<string, unknown>;
  ts: string;
}

/** `RetentionOut`. */
export interface AuditRetentionOut {
  retention_days: number;
  total: number;
}

/** POST /audit/purge — hand-built dict. */
export interface AuditPurgeOut {
  deleted: number;
  older_than_days: number;
}

/* --- security (backend/core/app/security/schemas.py) ----------------------- */

/** `SecurityPolicyOut`. */
export interface SecurityPolicyOut {
  require_2fa: boolean;
  require_2fa_roles: string[];
  session_idle_minutes: number;
  updated_at: string | null;
}

/** `DirectoryConfigOut` — only the fields the posture screen reads are named. */
export interface DirectoryConfigOut {
  id: string;
  name: string;
  enabled: boolean;
  server_uri: string;
  last_sync_at: string | null;
  created_at: string;
  [k: string]: unknown;
}

/** `SsoConfigOut` — only the fields the posture screen reads are named. */
export interface SsoConfigOut {
  id: string;
  provider: string;
  enabled: boolean;
  issuer: string;
  created_at: string;
  [k: string]: unknown;
}

/** `DualAuthRequestOut`. */
export interface DualAuthRequestOut {
  id: string;
  action: string;
  target_type: string | null;
  target_id: string | null;
  reason: string | null;
  payload: Record<string, unknown>;
  status: string;
  requested_by: string | null;
  requested_by_email: string | null;
  decided_by: string | null;
  decided_by_email: string | null;
  decided_at: string | null;
  decision_note: string | null;
  expires_at: string | null;
  created_at: string;
}

/* --- settings (backend/core/app/settings/schemas.py, settings/catalog.py) -- */

/** What a setting holds: the catalog only declares bool / text / number. */
export type SettingValue = string | number | boolean | null;

/** One catalog entry — the dict shape in settings/catalog.py. */
export interface SettingCatalogItem {
  key: string;
  type: "bool" | "text" | "number";
  default: SettingValue;
  group: string;
  label: string;
  description?: string;
  placeholder?: string;
  /** Masked in the UI (API keys, passwords). */
  secret?: boolean;
}

/** `SettingsOut` — the editable catalog + current effective values. */
export interface SettingsOut {
  catalog: SettingCatalogItem[];
  values: Record<string, SettingValue>;
}

/** `MapsConfigOut` — GET /settings/maps. */
export interface MapsConfigOut {
  enabled: boolean;
  api_key: string;
  tiles_url: string;
  default_lat: number;
  default_lng: number;
  default_zoom: number;
}

/* --- messaging (backend/core/app/messaging/router.py) ---------------------- */

/** `ChannelOut` — secret fields in `config` are masked to `"***"`. */
export interface ChannelOut {
  channel: string;
  enabled: boolean;
  config: Record<string, unknown>;
}

/** `TemplateSummaryOut`. */
export interface TemplateSummaryOut {
  name: string;
  overridden: boolean;
  subject: string;
}

/** `TemplateOut` — one template's editable subject + HTML body. */
export interface TemplateOut {
  name: string;
  subject: string;
  html: string;
  is_override: boolean;
}

/** GET /messaging/templates/{name}/preview — rendered with sample data. */
export interface TemplatePreviewOut {
  subject: string;
  html: string;
}

/* --- branding (backend/core/app/branding/schemas.py) ----------------------- */

/** `UpdateBrandingIn` as the Branding form holds it — every field present. */
export type BrandingForm = Pick<BrandingOut, "app_name" | "primary_color" | "accent_color" | "name_in_header">;

/* --- licensing (backend/core/app/licensing/router.py) ---------------------- */

/** GET /license — `_status()`, a hand-built dict. */
export interface LicenseStatus {
  client: string | null;
  expires_at: string | null;
  is_expired: boolean;
  modules: string[];
  limits: Record<string, unknown> & { cameras?: number; storage_gb?: number };
  features: Record<string, unknown>;
  /** Running unlicensed in a dev environment — limits are ignored. */
  dev: boolean;
}

/* --- system (backend/core/app/core/health.py) ------------------------------ */

/** GET /system/health — `{ status, checks: { <dep>: "ok" | "error: …" } }`. */
export interface SystemHealthOut {
  status: string;
  checks: Record<string, string>;
}
