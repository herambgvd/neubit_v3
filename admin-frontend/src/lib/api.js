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
import axios from "axios";

// Same-origin with the admin UI by default (empty base → "/api/v1" on whatever
// host the panel is served from — admin.localhost, a LAN IP, or a domain), routed
// by the gateway. Keeps the refresh cookie first-party (SameSite=Lax) and needs no
// per-host rebuild. An explicit NEXT_PUBLIC_API_URL still overrides.
const BASE = (process.env.NEXT_PUBLIC_API_URL || "") + "/api/v1";

// In-memory access token. Deliberately NOT persisted.
let accessToken = null;

export const tokens = {
  get access() {
    return accessToken;
  },
  set(access) {
    accessToken = access || null;
  },
  clear() {
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

// Single-flight refresh: concurrent callers share one /auth/refresh call. The
// endpoint is a session probe — it answers 200 with a token when the httpOnly
// cookie is valid, else 200 with a null token — so this never throws and never
// logs a failing request. Send NO body (an empty {} would fail body validation).
let refreshPromise = null;
function refreshAccess() {
  if (!refreshPromise) {
    refreshPromise = axios
      .post(`${BASE}/auth/refresh`, undefined, { withCredentials: true })
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
  async (error) => {
    const original = error?.config;
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
    if (recoverable) {
      original._retry = true;
      try {
        const fresh = await refreshAccess();
        if (fresh) {
          original.headers = original.headers || {};
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
export function apiError(error, fallback = "Something went wrong") {
  return (
    error?.response?.data?.error?.message ||
    error?.response?.data?.detail ||
    error?.message ||
    fallback
  );
}

// Typed helpers for the admin surface. The tenants list may come back as either a
// paginated envelope { items: [...] } or a plain array — callers should handle both.
export const adminApi = {
  async login(email, password) {
    const { data } = await api.post("/auth/login", { email, password });
    return data;
  },
  async loginMfa(mfaToken, code) {
    const { data } = await api.post("/auth/login/mfa", { mfa_token: mfaToken, code });
    return data;
  },
  async me() {
    const { data } = await api.get("/auth/me");
    return data;
  },
  // Session bootstrap for gates (panel guard / login page). Uses the in-memory
  // access token if present (e.g. right after login); otherwise probes the
  // refresh cookie. Only calls /auth/me when a session actually exists — so a
  // signed-out user triggers ZERO failing requests. Returns the user or null.
  async bootstrap() {
    const token = accessToken || (await refreshAccess());
    if (!token) return null;
    const { data } = await api.get("/auth/me");
    return data;
  },
  // Revoke the refresh token server-side + clear the httpOnly cookie, then drop
  // the in-memory access token. Best-effort: always clears locally even if the
  // network call fails.
  async logout() {
    try {
      await api.post("/auth/logout");
    } catch {
      /* ignore — clear locally regardless */
    }
    tokens.clear();
  },

  // --- Account security (self-service, for the signed-in super-admin) ---------
  async changePassword(current_password, new_password) {
    const { data } = await api.post("/auth/change-password", { current_password, new_password });
    return data;
  },
  // Two-factor auth. Status → { enabled, recovery_codes_remaining }.
  async twoFactorStatus() {
    const { data } = await api.get("/auth/me/2fa");
    return data;
  },
  // Begin enrolment → { secret, otpauth_uri } (not active until confirmed).
  async twoFactorSetup() {
    const { data } = await api.post("/auth/me/2fa/setup");
    return data;
  },
  // Confirm the first code, enabling 2FA → { recovery_codes }.
  async twoFactorConfirm(code) {
    const { data } = await api.post("/auth/me/2fa/confirm", { code });
    return data;
  },
  async twoFactorDisable(code) {
    const { data } = await api.post("/auth/me/2fa/disable", { code });
    return data;
  },
  // Regenerate recovery codes (invalidates the old set) → { recovery_codes }.
  async twoFactorRecoveryCodes(code) {
    const { data } = await api.post("/auth/me/2fa/recovery-codes", { code });
    return data;
  },
  // Live sessions. Each { id, user_agent, ip, created_at, last_used_at, current }.
  async listSessions() {
    const { data } = await api.get("/auth/me/sessions");
    return data;
  },
  async revokeSession(sessionId) {
    const { data } = await api.delete(`/auth/me/sessions/${sessionId}`);
    return data;
  },
  async revokeOtherSessions() {
    const { data } = await api.post("/auth/me/sessions/revoke-others");
    return data;
  },
  // Tenants — paginated { items, total, page, page_size } (also tolerates a bare array).
  async listTenants({ page = 1, pageSize = 20, q = "", status = "" } = {}) {
    const params = { page, page_size: pageSize };
    if (q) params.q = q;
    if (status) params.status = status;
    const { data } = await api.get("/admin/tenants", { params });
    return data;
  },
  async getTenant(id) {
    const { data } = await api.get(`/admin/tenants/${id}`);
    return data;
  },
  async createTenant({ name, admin_email, admin_password }) {
    const { data } = await api.post("/admin/tenants", { name, admin_email, admin_password });
    return data;
  },
  async updateTenant(id, body) {
    const { data } = await api.patch(`/admin/tenants/${id}`, body);
    return data;
  },
  async deleteTenant(id) {
    const { data } = await api.delete(`/admin/tenants/${id}`);
    return data;
  },
  async setLicense(id, body) {
    const { data } = await api.put(`/admin/tenants/${id}/license`, body);
    return data;
  },
  async suspendTenant(id) {
    const { data } = await api.post(`/admin/tenants/${id}/suspend`);
    return data;
  },
  async reactivateTenant(id) {
    const { data } = await api.post(`/admin/tenants/${id}/reactivate`);
    return data;
  },
  async tenantUsage(id) {
    const { data } = await api.get(`/admin/tenants/${id}/usage`);
    return data;
  },
  async listTenantAdmins(id) {
    const { data } = await api.get(`/admin/tenants/${id}/admins`);
    return data;
  },
  async createTenantAdmin(id, body) {
    const { data } = await api.post(`/admin/tenants/${id}/admins`, body);
    return data;
  },
  async deleteTenantAdmin(id, userId) {
    const { data } = await api.delete(`/admin/tenants/${id}/admins/${userId}`);
    return data;
  },
  async impersonate(id) {
    const { data } = await api.post(`/admin/tenants/${id}/impersonate`);
    return data;
  },

  // Infrastructure — container fleet controls for the host.
  async listContainers() {
    const { data } = await api.get("/admin/infra/containers");
    return data;
  },
  async containerLogs(name, tail = 200) {
    const { data } = await api.get(`/admin/infra/containers/${name}/logs`, {
      params: { tail },
    });
    return data;
  },
  async restartContainer(name) {
    const { data } = await api.post(`/admin/infra/containers/${name}/restart`);
    return data;
  },
  async stopContainer(name) {
    const { data } = await api.post(`/admin/infra/containers/${name}/stop`);
    return data;
  },
  async startContainer(name) {
    const { data } = await api.post(`/admin/infra/containers/${name}/start`);
    return data;
  },
  async scaleService(name, replicas) {
    const { data } = await api.post(`/admin/infra/services/${name}/scale`, { replicas });
    return data;
  },
  async infraHost() {
    const { data } = await api.get("/admin/infra/host");
    return data;
  },

  // Database backup/restore (control DB). Export returns a downloadable Blob.
  async exportDatabase() {
    const resp = await api.get("/admin/infra/db/export", { responseType: "blob" });
    return resp.data;
  },
  async importDatabase(file) {
    const body = new FormData();
    body.append("file", file);
    // Restore can wait for a lock gap on the live DB — give it plenty of time.
    const { data } = await api.post("/admin/infra/db/import", body, { timeout: 210000 });
    return data;
  },

  // Module catalog — platform features tenants inherit.
  async listModules() {
    const { data } = await api.get("/admin/modules");
    return data;
  },
  async createModule(body) {
    const { data } = await api.post("/admin/modules", body);
    return data;
  },
  async updateModule(key, body) {
    const { data } = await api.patch(`/admin/modules/${key}`, body);
    return data;
  },
  async deleteModule(key) {
    const { data } = await api.delete(`/admin/modules/${key}`);
    return data;
  },

  // Platform-wide defaults tenants inherit.
  async getPlatformSettings() {
    const { data } = await api.get("/admin/platform/settings");
    return data;
  },
  async updatePlatformSettings(body) {
    const { data } = await api.patch("/admin/platform/settings", body);
    return data;
  },
  async getPlatformBranding() {
    const { data } = await api.get("/admin/platform/branding");
    return data;
  },
  async updatePlatformBranding(body) {
    const { data } = await api.patch("/admin/platform/branding", body);
    return data;
  },
  // Upload the platform-default logo. As a super-admin (tenant_id NULL) this
  // targets the platform-default branding row. Returns BrandingOut with the
  // resolved, fetchable logo_url. Logo is stored server-side by key — there is
  // no logo_url field on the branding PATCH, so uploading is the only way to set it.
  async uploadPlatformLogo(file) {
    const body = new FormData();
    body.append("file", file);
    // Let axios/the browser set the multipart Content-Type (with boundary) itself.
    const { data } = await api.post("/branding/logo", body);
    return data;
  },

  // Cross-tenant user directory — paginated { items, total, page, page_size }.
  async listUsers({ page = 1, pageSize = 20, q = "", status = "", tenantId = "" } = {}) {
    const params = { page, page_size: pageSize };
    if (q) params.q = q;
    if (status) params.status = status;
    if (tenantId) params.tenant_id = tenantId;
    const { data } = await api.get("/admin/users", { params });
    return data;
  },
  async setUserActive(userId, isActive) {
    const { data } = await api.post(`/admin/users/${userId}/set-active`, { is_active: isActive });
    return data;
  },

  // Cross-tenant audit log — paginated { items, total, page, page_size }.
  async listAudit({ tenantId = "", page = 1 } = {}) {
    const params = { page };
    if (tenantId) params.tenant_id = tenantId;
    const { data } = await api.get("/admin/audit", { params });
    return data;
  },

  // --- Billing: plans, subscriptions, invoices (internal records) -------------
  async billingSummary() {
    const { data } = await api.get("/admin/billing/summary");
    return data;
  },
  async listPlans() {
    const { data } = await api.get("/admin/billing/plans");
    return data;
  },
  async createPlan(body) {
    const { data } = await api.post("/admin/billing/plans", body);
    return data;
  },
  async updatePlan(key, body) {
    const { data } = await api.patch(`/admin/billing/plans/${key}`, body);
    return data;
  },
  async deletePlan(key) {
    const { data } = await api.delete(`/admin/billing/plans/${key}`);
    return data;
  },
  async getSubscription(tenantId) {
    const { data } = await api.get(`/admin/billing/tenants/${tenantId}/subscription`);
    return data;
  },
  async subscribe(tenantId, body) {
    const { data } = await api.put(`/admin/billing/tenants/${tenantId}/subscription`, body);
    return data;
  },
  async cancelSubscription(tenantId) {
    const { data } = await api.post(`/admin/billing/tenants/${tenantId}/subscription/cancel`);
    return data;
  },
  // Invoices — paginated { items, total, page, page_size }.
  async listInvoices({ page = 1, pageSize = 20, tenantId = "", status = "", q = "" } = {}) {
    const params = { page, page_size: pageSize };
    if (tenantId) params.tenant_id = tenantId;
    if (status) params.status = status;
    if (q) params.q = q;
    const { data } = await api.get("/admin/billing/invoices", { params });
    return data;
  },
  async createInvoice(tenantId, body) {
    const { data } = await api.post(`/admin/billing/tenants/${tenantId}/invoices`, body);
    return data;
  },
  async markInvoicePaid(invoiceId) {
    const { data } = await api.post(`/admin/billing/invoices/${invoiceId}/mark-paid`);
    return data;
  },
  async voidInvoice(invoiceId) {
    const { data } = await api.post(`/admin/billing/invoices/${invoiceId}/void`);
    return data;
  },

  // --- Alerts inbox (derived platform alerts + per-admin read state) ----------
  async listAlerts() {
    const { data } = await api.get("/admin/alerts");
    return data;
  },
  async markAlertRead(key) {
    const { data } = await api.post("/admin/alerts/read", { key });
    return data;
  },
  async dismissAlert(key) {
    const { data } = await api.post("/admin/alerts/dismiss", { key });
    return data;
  },
  async markAllAlertsRead() {
    const { data } = await api.post("/admin/alerts/read-all");
    return data;
  },

  // --- Broadcasts (platform announcements) ------------------------------------
  async listBroadcasts() {
    const { data } = await api.get("/admin/broadcasts");
    return data;
  },
  async createBroadcast(body) {
    const { data } = await api.post("/admin/broadcasts", body);
    return data;
  },
  async updateBroadcast(id, body) {
    const { data } = await api.patch(`/admin/broadcasts/${id}`, body);
    return data;
  },
  async deleteBroadcast(id) {
    const { data } = await api.delete(`/admin/broadcasts/${id}`);
    return data;
  },
};
