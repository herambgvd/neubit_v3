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
  async me() {
    const { data } = await api.get("/auth/me");
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

  // Device brands — supported camera/device integrations.
  async listDeviceBrands() {
    const { data } = await api.get("/admin/device-brands");
    return data;
  },
  async getDeviceBrand(id) {
    const { data } = await api.get(`/admin/device-brands/${id}`);
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

  // Cross-tenant audit log — paginated { items, total, page, page_size }.
  async listAudit({ tenantId = "", page = 1 } = {}) {
    const params = { page };
    if (tenantId) params.tenant_id = tenantId;
    const { data } = await api.get("/admin/audit", { params });
    return data;
  },
};
