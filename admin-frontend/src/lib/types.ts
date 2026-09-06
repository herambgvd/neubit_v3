// Wire types for the super-admin API.
//
// These mirror the Pydantic response models in `backend/core` — the file names
// are given per block so a schema change has an obvious counterpart here. Dates
// cross the wire as ISO-8601 strings, never Date objects, so they are typed
// `string`; `dict` fields become `Record<string, unknown>` (or a narrower map
// where the backend documents one).

/** FastAPI's uniform error envelope, plus the older `detail` form. */
export interface ApiErrorBody {
  error?: { code?: string; message?: string };
  detail?: string;
}

/** The paginated envelope used by every `Paged*Out` schema. */
export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
}

/* --- auth (backend/core/app/auth/schemas.py) ------------------------------- */

export interface Role {
  id: string;
  name: string;
  description: string | null;
  permissions: string[];
  is_system: boolean;
  created_at: string;
}

/** `UserOut` — the signed-in principal. `is_superadmin` gates this whole panel. */
export interface User {
  id: string;
  email: string;
  full_name: string | null;
  role: Role;
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
  locked: boolean;
  password_changed_at: string | null;
  active_sessions: number;
  site_ids: string[];
}

/** `LoginResult` — either tokens, or an MFA challenge to exchange. */
export interface LoginResult {
  mfa_required: boolean;
  mfa_token: string | null;
  access_token: string | null;
  refresh_token: string | null;
  token_type: string;
  enrollment_required: boolean;
}

/** `AccessOut` — a null token means "no valid session" (a 200, not an error). */
export interface AccessOut {
  access_token: string | null;
  token_type: string;
}

export interface TotpStatus {
  enabled: boolean;
  recovery_codes_remaining: number;
}

export interface TotpSetup {
  secret: string;
  otpauth_uri: string;
}

export interface RecoveryCodes {
  recovery_codes: string[];
}

/** `SessionOut` — one live login session, backed by a refresh token row. */
export interface LoginSession {
  id: string;
  user_agent: string | null;
  ip: string | null;
  created_at: string;
  last_used_at: string | null;
  current: boolean;
}

/* --- tenants (backend/core/app/admin/schemas.py) --------------------------- */

/** `TenantWithCountOut` — `users` is a count, filled in by the list/detail route. */
export interface Tenant {
  id: string;
  name: string;
  slug: string;
  status: string;
  plan: string | null;
  features: Record<string, boolean>;
  limits: Record<string, number>;
  license_expires_at: string | null;
  grace_days: number;
  /** Derived server-side: "active" | "grace" | "expired". */
  license_state: string;
  created_at: string;
  users: number;
}

export interface TenantUsage {
  users: number;
  limits: Record<string, number>;
}

export interface TenantAdmin {
  id: string;
  email: string;
  full_name: string | null;
  is_active: boolean;
  created_at: string;
}

/** `ImpersonateOut` — access-only; there is deliberately no refresh token. */
export interface Impersonation {
  access_token: string;
  tenant_id: string;
  user_email: string;
}

/** `AdminUserOut` — the cross-tenant user directory row. */
export interface AdminUser {
  id: string;
  email: string;
  full_name: string | null;
  is_active: boolean;
  email_verified: boolean;
  is_superadmin: boolean;
  role_name: string | null;
  tenant_id: string | null;
  tenant_name: string | null;
  tenant_slug: string | null;
  last_login_at: string | null;
  created_at: string;
}

/* --- audit (backend/core/app/core/audit.py) -------------------------------- */

export interface AuditEntry {
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

/* --- module catalog (backend/core/app/module_catalog/router.py) ------------ */

export interface PlatformModule {
  id: string;
  key: string;
  name: string;
  description: string;
  category: string;
  default_enabled: boolean;
  /** System modules are seeded and cannot be edited or deleted. */
  is_system: boolean;
}

/* --- platform settings + branding ------------------------------------------ */

/** One row of `SettingsOut.catalog`. The catalog is data, so it stays loose. */
export interface SettingCatalogEntry {
  key: string;
  label?: string;
  description?: string;
  type?: string;
  group?: string;
  options?: unknown;
  [extra: string]: unknown;
}

export interface PlatformSettings {
  catalog: SettingCatalogEntry[];
  values: Record<string, unknown>;
}

export interface Branding {
  id: string;
  app_name: string;
  /** Resolved by the router at response time; null when no logo is uploaded. */
  logo_url: string | null;
  primary_color: string;
  accent_color: string;
  name_in_header: boolean;
}

/* --- billing (backend/core/app/billing/schemas.py) ------------------------- */

export interface Plan {
  id: string;
  key: string;
  name: string;
  description: string;
  price_cents: number;
  currency: string;
  /** "monthly" | "yearly". */
  interval: string;
  features: Record<string, boolean>;
  limits: Record<string, number>;
  is_active: boolean;
  sort_order: number;
  created_at: string;
}

export interface Subscription {
  id: string;
  tenant_id: string;
  plan_key: string;
  status: string;
  current_period_start: string | null;
  current_period_end: string | null;
  canceled_at: string | null;
  created_at: string;
  updated_at: string;
  plan: Plan | null;
}

export interface Invoice {
  id: string;
  tenant_id: string;
  number: string;
  amount_cents: number;
  currency: string;
  /** "draft" | "issued" | "paid" | "overdue" | "void". */
  status: string;
  period_start: string | null;
  period_end: string | null;
  issued_at: string | null;
  due_at: string | null;
  paid_at: string | null;
  notes: string | null;
  created_at: string;
  tenant_name: string | null;
}

export interface BillingSummary {
  mrr_cents: number;
  currency: string;
  active_subscriptions: number;
  plan_count: number;
  outstanding_cents: number;
  overdue_count: number;
  paid_last_30d_cents: number;
}

/* --- alerts + broadcasts ---------------------------------------------------- */

export interface Alert {
  key: string;
  /** "info" | "warning" | "critical". */
  severity: string;
  /** "license" | "quota" | "invoice" | "subscription" | "tenant". */
  category: string;
  title: string;
  message: string;
  link: string | null;
  ts: string | null;
  read: boolean;
}

export interface AlertList {
  items: Alert[];
  total: number;
  unread: number;
}

export interface Broadcast {
  id: string;
  title: string;
  body: string;
  severity: string;
  /** "all" | "tenants". */
  target_type: string;
  target_tenant_ids: string[];
  starts_at: string | null;
  ends_at: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

/* --- infrastructure (backend/ops-agent/main.py, proxied by core) ----------- */

/** One container in the compose project. Stats are null unless it is running. */
export interface Container {
  name: string;
  id: string;
  image: string;
  /** created | running | paused | restarting | exited | dead. */
  state: string;
  status: string;
  health: string | null;
  created_at: string | null;
  /** The compose service label, when the container carries one. */
  service: string | null;
  cpu_pct: number | null;
  mem_used_mb: number | null;
  mem_limit_mb: number | null;
}

/** Host summary. Everything below the container counts needs psutil on the host,
 *  so every one of those fields can legitimately be absent. */
export interface InfraHost {
  containers_running: number;
  containers_total: number;
  cpu_pct?: number;
  cpu_count?: number;
  mem_used_mb?: number;
  mem_total_mb?: number;
  disk_used_gb?: number;
  disk_total_gb?: number;
}

export interface ContainerLogs {
  lines: string[];
}

/** The agent's uniform ack for lifecycle/scale calls. */
export interface OkResult {
  ok: boolean;
  detail?: string | null;
}

/** Result of restoring the control DB from a dump (`POST /admin/infra/db/import`). */
export interface DbImportResult {
  ok: boolean;
  exit_code: number;
  output: string;
}
