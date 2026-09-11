// Axios instance for the super-admin console. Talks to the backend admin API at
// /api/v1 through the gateway.
//
// Token model (hardened): the SHORT-LIVED access token lives only in memory (a
// module variable) and is sent as a Bearer header — it is never written to
// localStorage, so XSS cannot exfiltrate a durable credential. The long-lived
// refresh token is an httpOnly cookie the browser sends automatically to
// /auth/refresh (invisible to JS). On a 401 we transparently refresh the access
// token from the cookie and retry the original request; only if that fails do we
// bounce to /login. On a hard reload the in-memory token is gone, so the first
// call 401s and self-heals via the cookie.
import axios, { type AxiosError, type InternalAxiosRequestConfig } from "axios";

import type {
  AccessOut,
  AdminUser,
  AlertList,
  ApiErrorBody,
  AuditEntry,
  BillingSummary,
  Branding,
  Broadcast,
  Container,
  ContainerLogs,
  DbImportResult,
  Impersonation,
  InfraHost,
  Invoice,
  LoginResult,
  LoginSession,
  OkResult,
  Paged,
  Plan,
  PlatformModule,
  PlatformSettings,
  RecoveryCodes,
  Subscription,
  Tenant,
  TenantAdmin,
  TenantUsage,
  TotpSetup,
  TotpStatus,
  User,
} from "./types";

// Same-origin with the admin UI by default (empty base → "/api/v1" on whatever
// host the panel is served from — admin.localhost, a LAN IP, or a domain), routed
// by the gateway. Keeps the refresh cookie first-party (SameSite=Lax) and needs no
// per-host rebuild. An explicit NEXT_PUBLIC_API_URL still overrides.
const BASE = (process.env.NEXT_PUBLIC_API_URL || "") + "/api/v1";

// In-memory access token. Deliberately NOT persisted.
let accessToken: string | null = null;

export const tokens = {
  get access(): string | null {
    return accessToken;
  },
  set(access: string | null | undefined): void {
    accessToken = access || null;
  },
  clear(): void {
    accessToken = null;
  },
};

// withCredentials so the httpOnly refresh cookie rides along (and same-origin XHR
// stays explicit about credentials).
export const api = axios.create({ baseURL: BASE, withCredentials: true });

api.interceptors.request.use((config) => {
  if (accessToken) config.headers.Authorization = `Bearer ${accessToken}`;
  return config;
});

// A request we have already tried to recover once. The flag rides on the config
// object so a retried request cannot loop.
type RetriableConfig = InternalAxiosRequestConfig & { _retry?: boolean };

// Single-flight refresh: concurrent callers share one /auth/refresh call. The
// endpoint is a session probe — it answers 200 with a token when the httpOnly
// cookie is valid, else 200 with a null token — so this never throws and never
// logs a failing request. Send NO body (an empty {} would fail body validation).
let refreshPromise: Promise<string | null> | null = null;
function refreshAccess(): Promise<string | null> {
  if (!refreshPromise) {
    refreshPromise = axios
      .post<AccessOut>(`${BASE}/auth/refresh`, undefined, { withCredentials: true })
      .then((r) => {
        accessToken = r.data?.access_token || null;
        return accessToken;
      })
      .catch(() => {
        accessToken = null;
        return null;
      })
      .finally(() => {
        refreshPromise = null;
      });
  }
  return refreshPromise;
}

api.interceptors.response.use(
  (r) => r,
  async (error: AxiosError) => {
    const original = error?.config as RetriableConfig | undefined;
    const status = error?.response?.status;
    const url = original?.url || "";
    // Only try to recover a genuine 401 once, and never for the auth endpoints
    // themselves (those failing means the session is truly gone).
    const recoverable =
      status === 401 &&
      original &&
      !original._retry &&
      !url.includes("/auth/refresh") &&
      !url.includes("/auth/login");
    if (recoverable && original) {
      original._retry = true;
      try {
        const fresh = await refreshAccess();
        if (fresh) {
          original.headers.Authorization = `Bearer ${fresh}`;
          return api(original);
        }
      } catch {
        // fall through to the redirect below
      }
      if (typeof window !== "undefined" && !window.location.pathname.startsWith("/login")) {
        window.location.href = "/login";
      }
    }
    return Promise.reject(error);
  }
);

// Unwrap the uniform error envelope { error: { code, message } } into a string.
// Takes `unknown` because that is what a catch block hands you — narrowing here
// keeps every call site free of casts.
export function apiError(error: unknown, fallback = "Something went wrong"): string {
  const body = (error as AxiosError<ApiErrorBody> | undefined)?.response?.data;
  return (
    body?.error?.message ||
    body?.detail ||
    (error as Error | undefined)?.message ||
    fallback
  );
}

/** Query options shared by the paginated list endpoints. */
export interface ListParams {
  page?: number;
  pageSize?: number;
  q?: string;
  status?: string;
}

// Typed helpers for the admin surface. The tenants list may come back as either a
// paginated envelope { items: [...] } or a plain array — callers should handle both.
export const adminApi = {
  async login(email: string, password: string): Promise<LoginResult> {
    const { data } = await api.post<LoginResult>("/auth/login", { email, password });
    return data;
  },
  async loginMfa(mfaToken: string, code: string): Promise<LoginResult> {
    const { data } = await api.post<LoginResult>("/auth/login/mfa", {
      mfa_token: mfaToken,
      code,
    });
    return data;
  },
  async me(): Promise<User> {
    const { data } = await api.get<User>("/auth/me");
    return data;
  },
  // Session bootstrap for gates (panel guard / login page). Uses the in-memory
  // access token if present (e.g. right after login); otherwise probes the
  // refresh cookie. Only calls /auth/me when a session actually exists — so a
  // signed-out user triggers ZERO failing requests. Returns the user or null.
  async bootstrap(): Promise<User | null> {
    const token = accessToken || (await refreshAccess());
    if (!token) return null;
    const { data } = await api.get<User>("/auth/me");
    return data;
  },
  // Revoke the refresh token server-side + clear the httpOnly cookie, then drop
  // the in-memory access token. Best-effort: always clears locally even if the
  // network call fails.
  async logout(): Promise<void> {
    try {
      await api.post("/auth/logout");
    } catch {
      /* ignore — clear locally regardless */
    }
    tokens.clear();
  },

  // --- Account security (self-service, for the signed-in super-admin) ---------
  async changePassword(current_password: string, new_password: string): Promise<unknown> {
    const { data } = await api.post("/auth/change-password", {
      current_password,
      new_password,
    });
    return data;
  },
  // Two-factor auth. Status → { enabled, recovery_codes_remaining }.
  async twoFactorStatus(): Promise<TotpStatus> {
    const { data } = await api.get<TotpStatus>("/auth/me/2fa");
    return data;
  },
  // Begin enrolment → { secret, otpauth_uri } (not active until confirmed).
  async twoFactorSetup(): Promise<TotpSetup> {
    const { data } = await api.post<TotpSetup>("/auth/me/2fa/setup");
    return data;
  },
  // Confirm the first code, enabling 2FA → { recovery_codes }.
  async twoFactorConfirm(code: string): Promise<RecoveryCodes> {
    const { data } = await api.post<RecoveryCodes>("/auth/me/2fa/confirm", { code });
    return data;
  },
  async twoFactorDisable(code: string): Promise<unknown> {
    const { data } = await api.post("/auth/me/2fa/disable", { code });
    return data;
  },
  // Regenerate recovery codes (invalidates the old set) → { recovery_codes }.
  async twoFactorRecoveryCodes(code: string): Promise<RecoveryCodes> {
    const { data } = await api.post<RecoveryCodes>("/auth/me/2fa/recovery-codes", { code });
    return data;
  },
  // Live sessions. Each { id, user_agent, ip, created_at, last_used_at, current }.
  async listSessions(): Promise<LoginSession[]> {
    const { data } = await api.get<LoginSession[]>("/auth/me/sessions");
    return data;
  },
  async revokeSession(sessionId: string): Promise<unknown> {
    const { data } = await api.delete(`/auth/me/sessions/${sessionId}`);
    return data;
  },
  async revokeOtherSessions(): Promise<unknown> {
    const { data } = await api.post("/auth/me/sessions/revoke-others");
    return data;
  },
  // Tenants — paginated { items, total, page, page_size } (also tolerates a bare array).
  async listTenants({
    page = 1,
    pageSize = 20,
    q = "",
    status = "",
  }: ListParams = {}): Promise<Paged<Tenant> | Tenant[]> {
    const params: Record<string, string | number> = { page, page_size: pageSize };
    if (q) params.q = q;
    if (status) params.status = status;
    const { data } = await api.get<Paged<Tenant> | Tenant[]>("/admin/tenants", { params });
    return data;
  },
  async getTenant(id: string): Promise<Tenant> {
    const { data } = await api.get<Tenant>(`/admin/tenants/${id}`);
    return data;
  },
  async createTenant(body: {
    name: string;
    admin_email: string;
    admin_password: string;
  }): Promise<Tenant> {
    const { data } = await api.post<Tenant>("/admin/tenants", body);
    return data;
  },
  async updateTenant(
    id: string,
    body: Partial<Pick<Tenant, "status" | "plan" | "features" | "limits">>
  ): Promise<Tenant> {
    const { data } = await api.patch<Tenant>(`/admin/tenants/${id}`, body);
    return data;
  },
  async deleteTenant(id: string): Promise<unknown> {
    const { data } = await api.delete(`/admin/tenants/${id}`);
    return data;
  },
  async setLicense(
    id: string,
    body: {
      plan?: string | null;
      features?: Record<string, boolean>;
      limits?: Record<string, number>;
      license_expires_at?: string | null;
      grace_days?: number | null;
    }
  ): Promise<Tenant> {
    const { data } = await api.put<Tenant>(`/admin/tenants/${id}/license`, body);
    return data;
  },
  async suspendTenant(id: string): Promise<Tenant> {
    const { data } = await api.post<Tenant>(`/admin/tenants/${id}/suspend`);
    return data;
  },
  async reactivateTenant(id: string): Promise<Tenant> {
    const { data } = await api.post<Tenant>(`/admin/tenants/${id}/reactivate`);
    return data;
  },
  async tenantUsage(id: string): Promise<TenantUsage> {
    const { data } = await api.get<TenantUsage>(`/admin/tenants/${id}/usage`);
    return data;
  },
  async listTenantAdmins(id: string): Promise<TenantAdmin[]> {
    const { data } = await api.get<TenantAdmin[]>(`/admin/tenants/${id}/admins`);
    return data;
  },
  async createTenantAdmin(
    id: string,
    body: { email: string; password: string; full_name?: string | null }
  ): Promise<TenantAdmin> {
    const { data } = await api.post<TenantAdmin>(`/admin/tenants/${id}/admins`, body);
    return data;
  },
  async deleteTenantAdmin(id: string, userId: string): Promise<unknown> {
    const { data } = await api.delete(`/admin/tenants/${id}/admins/${userId}`);
    return data;
  },
  async impersonate(id: string): Promise<Impersonation> {
    const { data } = await api.post<Impersonation>(`/admin/tenants/${id}/impersonate`);
    return data;
  },

  // Infrastructure — container fleet controls for the host.
  async listContainers(): Promise<Container[]> {
    const { data } = await api.get<Container[]>("/admin/infra/containers");
    return data;
  },
  async containerLogs(name: string, tail = 200): Promise<ContainerLogs> {
    const { data } = await api.get<ContainerLogs>(`/admin/infra/containers/${name}/logs`, {
      params: { tail },
    });
    return data;
  },
  async restartContainer(name: string): Promise<OkResult> {
    const { data } = await api.post<OkResult>(`/admin/infra/containers/${name}/restart`);
    return data;
  },
  async stopContainer(name: string): Promise<OkResult> {
    const { data } = await api.post<OkResult>(`/admin/infra/containers/${name}/stop`);
    return data;
  },
  async startContainer(name: string): Promise<OkResult> {
    const { data } = await api.post<OkResult>(`/admin/infra/containers/${name}/start`);
    return data;
  },
  async scaleService(name: string, replicas: number): Promise<OkResult> {
    const { data } = await api.post<OkResult>(`/admin/infra/services/${name}/scale`, {
      replicas,
    });
    return data;
  },
  async infraHost(): Promise<InfraHost> {
    const { data } = await api.get<InfraHost>("/admin/infra/host");
    return data;
  },

  // Database backup/restore (control DB). Export returns a downloadable Blob.
  async exportDatabase(): Promise<Blob> {
    const resp = await api.get("/admin/infra/db/export", { responseType: "blob" });
    return resp.data as Blob;
  },
  async importDatabase(file: File): Promise<DbImportResult> {
    const body = new FormData();
    body.append("file", file);
    // Restore can wait for a lock gap on the live DB — give it plenty of time.
    const { data } = await api.post<DbImportResult>("/admin/infra/db/import", body, {
      timeout: 210000,
    });
    return data;
  },

  // Module catalog — platform features tenants inherit.
  async listModules(): Promise<PlatformModule[]> {
    const { data } = await api.get<PlatformModule[]>("/admin/modules");
    return data;
  },
  async createModule(body: {
    key: string;
    name: string;
    description?: string;
    category?: string;
    default_enabled?: boolean;
  }): Promise<PlatformModule> {
    const { data } = await api.post<PlatformModule>("/admin/modules", body);
    return data;
  },
  async updateModule(
    key: string,
    body: Partial<Pick<PlatformModule, "name" | "description" | "category" | "default_enabled">>
  ): Promise<PlatformModule> {
    const { data } = await api.patch<PlatformModule>(`/admin/modules/${key}`, body);
    return data;
  },
  async deleteModule(key: string): Promise<unknown> {
    const { data } = await api.delete(`/admin/modules/${key}`);
    return data;
  },

  // Platform-wide defaults tenants inherit.
  async getPlatformSettings(): Promise<PlatformSettings> {
    const { data } = await api.get<PlatformSettings>("/admin/platform/settings");
    return data;
  },
  async updatePlatformSettings(body: {
    values: Record<string, unknown>;
  }): Promise<PlatformSettings> {
    const { data } = await api.patch<PlatformSettings>("/admin/platform/settings", body);
    return data;
  },
  async getPlatformBranding(): Promise<Branding> {
    const { data } = await api.get<Branding>("/admin/platform/branding");
    return data;
  },
  async updatePlatformBranding(
    // app_name ONLY — that is the whole of UpdateBrandingIn. The colours and the
    // header toggle were removed from the API (they governed nothing), and this
    // type went on offering them: pydantic dropped them silently, so the console
    // had a colour picker and a toggle that saved successfully and changed nothing.
    body: Partial<Pick<Branding, "app_name">>
  ): Promise<Branding> {
    const { data } = await api.patch<Branding>("/admin/platform/branding", body);
    return data;
  },
  // Upload the platform-default logo. As a super-admin (tenant_id NULL) this
  // targets the platform-default branding row. Returns BrandingOut with the
  // resolved, fetchable logo_url. Logo is stored server-side by key — there is
  // no logo_url field on the branding PATCH, so uploading is the only way to set it.
  async uploadPlatformLogo(file: File): Promise<Branding> {
    const body = new FormData();
    body.append("file", file);
    // Let axios/the browser set the multipart Content-Type (with boundary) itself.
    const { data } = await api.post<Branding>("/branding/logo", body);
    return data;
  },

  // Cross-tenant user directory — paginated { items, total, page, page_size }.
  async listUsers({
    page = 1,
    pageSize = 20,
    q = "",
    status = "",
    tenantId = "",
  }: ListParams & { tenantId?: string } = {}): Promise<Paged<AdminUser> | AdminUser[]> {
    const params: Record<string, string | number> = { page, page_size: pageSize };
    if (q) params.q = q;
    if (status) params.status = status;
    if (tenantId) params.tenant_id = tenantId;
    const { data } = await api.get<Paged<AdminUser> | AdminUser[]>("/admin/users", { params });
    return data;
  },
  async setUserActive(userId: string, isActive: boolean): Promise<AdminUser> {
    const { data } = await api.post<AdminUser>(`/admin/users/${userId}/set-active`, {
      is_active: isActive,
    });
    return data;
  },

  // Cross-tenant audit log — paginated { items, total, page, page_size }.
  async listAudit({
    tenantId = "",
    page = 1,
  }: { tenantId?: string; page?: number } = {}): Promise<Paged<AuditEntry>> {
    const params: Record<string, string | number> = { page };
    if (tenantId) params.tenant_id = tenantId;
    const { data } = await api.get<Paged<AuditEntry>>("/admin/audit", { params });
    return data;
  },

  // --- Billing: plans, subscriptions, invoices (internal records) -------------
  async billingSummary(): Promise<BillingSummary> {
    const { data } = await api.get<BillingSummary>("/admin/billing/summary");
    return data;
  },
  async listPlans(): Promise<Plan[]> {
    const { data } = await api.get<Plan[]>("/admin/billing/plans");
    return data;
  },
  async createPlan(body: Partial<Plan> & { key: string; name: string }): Promise<Plan> {
    const { data } = await api.post<Plan>("/admin/billing/plans", body);
    return data;
  },
  async updatePlan(key: string, body: Partial<Plan>): Promise<Plan> {
    const { data } = await api.patch<Plan>(`/admin/billing/plans/${key}`, body);
    return data;
  },
  async deletePlan(key: string): Promise<unknown> {
    const { data } = await api.delete(`/admin/billing/plans/${key}`);
    return data;
  },
  async getSubscription(tenantId: string): Promise<Subscription | null> {
    const { data } = await api.get<Subscription | null>(
      `/admin/billing/tenants/${tenantId}/subscription`
    );
    return data;
  },
  async subscribe(
    tenantId: string,
    body: {
      plan_key: string;
      status?: string;
      current_period_start?: string | null;
      current_period_end?: string | null;
      apply_entitlements?: boolean;
    }
  ): Promise<Subscription> {
    const { data } = await api.put<Subscription>(
      `/admin/billing/tenants/${tenantId}/subscription`,
      body
    );
    return data;
  },
  async cancelSubscription(tenantId: string): Promise<Subscription> {
    const { data } = await api.post<Subscription>(
      `/admin/billing/tenants/${tenantId}/subscription/cancel`
    );
    return data;
  },
  // Invoices — paginated { items, total, page, page_size }.
  async listInvoices({
    page = 1,
    pageSize = 20,
    tenantId = "",
    status = "",
    q = "",
  }: ListParams & { tenantId?: string } = {}): Promise<Paged<Invoice>> {
    const params: Record<string, string | number> = { page, page_size: pageSize };
    if (tenantId) params.tenant_id = tenantId;
    if (status) params.status = status;
    if (q) params.q = q;
    const { data } = await api.get<Paged<Invoice>>("/admin/billing/invoices", { params });
    return data;
  },
  async createInvoice(
    tenantId: string,
    body: {
      amount_cents: number;
      currency?: string;
      status?: string;
      period_start?: string | null;
      period_end?: string | null;
      due_at?: string | null;
      notes?: string | null;
    }
  ): Promise<Invoice> {
    const { data } = await api.post<Invoice>(`/admin/billing/tenants/${tenantId}/invoices`, body);
    return data;
  },
  async markInvoicePaid(invoiceId: string): Promise<Invoice> {
    const { data } = await api.post<Invoice>(`/admin/billing/invoices/${invoiceId}/mark-paid`);
    return data;
  },
  async voidInvoice(invoiceId: string): Promise<Invoice> {
    const { data } = await api.post<Invoice>(`/admin/billing/invoices/${invoiceId}/void`);
    return data;
  },

  // --- Alerts inbox (derived platform alerts + per-admin read state) ----------
  async listAlerts(): Promise<AlertList> {
    const { data } = await api.get<AlertList>("/admin/alerts");
    return data;
  },
  async markAlertRead(key: string): Promise<unknown> {
    const { data } = await api.post("/admin/alerts/read", { key });
    return data;
  },
  async dismissAlert(key: string): Promise<unknown> {
    const { data } = await api.post("/admin/alerts/dismiss", { key });
    return data;
  },
  async markAllAlertsRead(): Promise<unknown> {
    const { data } = await api.post("/admin/alerts/read-all");
    return data;
  },

  // --- Broadcasts (platform announcements) ------------------------------------
  async listBroadcasts(): Promise<Broadcast[]> {
    const { data } = await api.get<Broadcast[]>("/admin/broadcasts");
    return data;
  },
  async createBroadcast(body: {
    title: string;
    body?: string;
    severity?: string;
    target_type?: string;
    target_tenant_ids?: string[];
    starts_at?: string | null;
    ends_at?: string | null;
    is_active?: boolean;
  }): Promise<Broadcast> {
    const { data } = await api.post<Broadcast>("/admin/broadcasts", body);
    return data;
  },
  async updateBroadcast(id: string, body: Partial<Broadcast>): Promise<Broadcast> {
    const { data } = await api.patch<Broadcast>(`/admin/broadcasts/${id}`, body);
    return data;
  },
  async deleteBroadcast(id: string): Promise<unknown> {
    const { data } = await api.delete(`/admin/broadcasts/${id}`);
    return data;
  },
};

/** Re-export the wire types so callers can `import { Tenant } from "@/lib/api"`. */
export type * from "./types";
