// Axios instance wired to the edge backend (/api/v1). Attaches the JWT on every
// request; on 401 it refreshes the access token ONCE (single-flight across
// concurrent 401s) and retries the failed request — only when the refresh itself
// fails does it clear the session and bounce to /login; on LICENSE_EXPIRED it
// routes to the "License Expired" screen so an admin can renew.
import axios, { type AxiosError, type InternalAxiosRequestConfig } from "axios";

import type { ApiErrorBody } from "./types";

// API base resolution — host-agnostic by default:
//   • If NEXT_PUBLIC_API_URL is set, honour it (e.g. the admin panel → admin.localhost).
//   • Otherwise use a SAME-ORIGIN RELATIVE base ("") → all calls hit "/api/v1" on the
//     very host the operator opened (localhost, a LAN IP, or a domain), routed by the
//     gateway. This means one build runs on ANY IP/host with no rebuild — the whole
//     system "just works" on the server's IP without baking a hostname in.
const BASE = process.env.NEXT_PUBLIC_API_URL || "";

export const ACCESS_KEY = "vizor.access";
export const REFRESH_KEY = "vizor.refresh";

export const tokens = {
  get access(): string | null {
    return typeof window !== "undefined" ? localStorage.getItem(ACCESS_KEY) : null;
  },
  get refresh(): string | null {
    return typeof window !== "undefined" ? localStorage.getItem(REFRESH_KEY) : null;
  },
  set(access?: string | null, refresh?: string | null) {
    if (typeof window === "undefined") return;
    if (access) localStorage.setItem(ACCESS_KEY, access);
    if (refresh) localStorage.setItem(REFRESH_KEY, refresh);
  },
  clear(): void {
    if (typeof window === "undefined") return;
    localStorage.removeItem(ACCESS_KEY);
    localStorage.removeItem(REFRESH_KEY);
  },
};

export const api = axios.create({ baseURL: `${BASE}/api/v1` });

api.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  const t = tokens.access;
  if (t) config.headers.Authorization = `Bearer ${t}`;
  return config;
});

// --- access-token refresh ----------------------------------------------------
// POST /auth/refresh semantics (backend/core/app/auth/{router,service}.py):
//   • accepts {"refresh_token": ...} in the body, though the httpOnly nb_refresh
//     cookie — set at login — wins when present (both carry the same session jti);
//   • success → 200 {"access_token": "<jwt>"};
//   • missing/expired/revoked refresh token → 200 {"access_token": null}, NOT a
//     4xx (the endpoint doubles as a session probe), so a null token IS failure;
//   • refresh tokens do NOT rotate: the response carries no refresh token and the
//     stored one stays valid until its 30-day expiry or an explicit revocation
//     (logout, password change, session revoke).
const AUTH_LIFECYCLE_PATHS = ["/auth/login", "/auth/login/mfa", "/auth/refresh", "/auth/logout"];

// Token-LIFECYCLE endpoints never trigger a refresh: a login 401 means "wrong
// credentials" (refreshing would mask it), a refresh must never refresh itself
// (loop), and logout is already tearing the session down. Everything else —
// /auth/me included, it is an ordinary authenticated GET — is refresh-eligible.
function isAuthLifecycle(url?: string): boolean {
  if (!url) return false;
  const path = url.split("?")[0];
  return AUTH_LIFECYCLE_PATHS.some((p) => path === p || path.endsWith(p));
}

// Single-flight guard: when many requests 401 together (a dashboard fanning out
// after the 12h access TTL lapses) they all await ONE in-flight refresh instead
// of each firing their own — no thundering herd on /auth/refresh.
let refreshInFlight: Promise<string | null> | null = null;

async function refreshAccessToken(): Promise<string | null> {
  try {
    // Bare axios, not `api`: no interceptors, so a refresh can never recurse into
    // the 401 handler and never triggers a refresh of its own.
    const { data } = await axios.post(
      `${BASE}/api/v1/auth/refresh`,
      tokens.refresh ? { refresh_token: tokens.refresh } : {}
    );
    const access: string | null = data?.access_token ?? null;
    // No rotation server-side (see above) — only the access token is replaced.
    if (access) tokens.set(access);
    return access;
  } catch {
    return null; // network error / 5xx — same as a failed refresh
  }
}

function clearSessionAndRedirect(): void {
  tokens.clear();
  if (!window.location.pathname.startsWith("/login")) window.location.href = "/login";
}

// Marks a request that already went through one refresh+retry, so a second 401
// on the same request falls through to logout instead of looping forever.
type RetriableConfig = InternalAxiosRequestConfig & { _authRetried?: boolean };

api.interceptors.response.use(
  (r) => r,
  async (error: AxiosError<ApiErrorBody>) => {
    const code = error?.response?.data?.error?.code;
    const config = error?.config as RetriableConfig | undefined;
    if (typeof window !== "undefined") {
      if (error?.response?.status === 401) {
        if (config && !config._authRetried && !isAuthLifecycle(config.url)) {
          refreshInFlight ??= refreshAccessToken().finally(() => {
            refreshInFlight = null;
          });
          const access = await refreshInFlight;
          if (access) {
            config._authRetried = true;
            config.headers.Authorization = `Bearer ${access}`;
            return api.request(config); // one retry with the fresh token
          }
        }
        clearSessionAndRedirect();
      } else if (code === "LICENSE_EXPIRED") {
        window.location.href = "/license-expired";
      }
    }
    return Promise.reject(error);
  }
);

// Unwrap the uniform error envelope { error: { code, message } } into a string.
export function apiError(error: unknown, fallback = "Something went wrong"): string {
  const e = error as AxiosError<ApiErrorBody> | undefined;
  return e?.response?.data?.error?.message || e?.message || fallback;
}

// Resolve a backend file reference to an absolute URL the browser can load.
// The backend returns object URLs relative to its own origin ("/files/<key>"),
// but the UI runs on a different port in dev — so prefix the backend base.
// Pass either a "/files/..." url or a raw storage key.
export function fileUrl(ref?: string | null): string | null {
  if (!ref) return null;
  if (/^https?:\/\//.test(ref)) return ref;      // already absolute (e.g. S3 presigned)
  const path = ref.startsWith("/files/") ? ref : `/files/${ref.replace(/^\//, "")}`;
  return `${BASE}${path}`;
}
