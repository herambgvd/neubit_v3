// Axios instance for the super-admin console. Talks to the backend admin API at
// /api/v1 through the gateway. Attaches the admin JWT on every request; on 401 it
// clears the session and bounces to /login.
import axios from "axios";

// Default to the gateway origin ("http://localhost"); override with NEXT_PUBLIC_API_URL.
const BASE = (process.env.NEXT_PUBLIC_API_URL || "http://localhost") + "/api/v1";

// Kept namespaced under "neubit.admin.*" so the admin session never collides with
// an operator session in the same browser.
export const ACCESS_KEY = "neubit.admin.access";

export const tokens = {
  get access() {
    return typeof window !== "undefined" ? localStorage.getItem(ACCESS_KEY) : null;
  },
  set(access) {
    if (typeof window === "undefined") return;
    if (access) localStorage.setItem(ACCESS_KEY, access);
  },
  clear() {
    if (typeof window === "undefined") return;
    localStorage.removeItem(ACCESS_KEY);
  },
};

export const api = axios.create({ baseURL: BASE });

api.interceptors.request.use((config) => {
  const t = tokens.access;
  if (t) config.headers.Authorization = `Bearer ${t}`;
  return config;
});

api.interceptors.response.use(
  (r) => r,
  (error) => {
    if (typeof window !== "undefined" && error?.response?.status === 401) {
      tokens.clear();
      if (!window.location.pathname.startsWith("/login")) window.location.href = "/login";
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
};
