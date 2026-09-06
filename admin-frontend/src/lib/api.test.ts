/**
 * The token model is the security property this console rests on, so it is
 * tested as a property, not as an implementation detail:
 *
 *   1. the access token exists only in memory — never localStorage, never a cookie
 *   2. a 401 is recovered once, via the httpOnly refresh cookie, then retried
 *   3. concurrent 401s share ONE refresh call
 *   4. the auth endpoints themselves are never retried
 *
 * Requests are served by a stub axios adapter, so nothing here touches a network.
 */
import axios, {
  AxiosError,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from "axios";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { adminApi, api, apiError, tokens } from "@/lib/api";

function respond(
  config: InternalAxiosRequestConfig,
  data: unknown = {},
  status = 200
): AxiosResponse {
  return { data, status, statusText: "OK", headers: {}, config } as AxiosResponse;
}

function reject(config: InternalAxiosRequestConfig, status: number, data: unknown = {}) {
  return Promise.reject(
    new AxiosError("request failed", String(status), config, null, {
      data,
      status,
      statusText: "ERR",
      headers: {},
      config,
    } as AxiosResponse)
  );
}

/** Requests the stub adapter saw, in order. */
let seen: InternalAxiosRequestConfig[] = [];
/** Calls to /auth/refresh (which goes through the bare axios default instance). */
let refreshCalls = 0;
/** What the next /auth/refresh answers with. */
let refreshToken: string | null = "refreshed-token";

beforeEach(() => {
  tokens.clear();
  seen = [];
  refreshCalls = 0;
  refreshToken = "refreshed-token";
  // The bare axios instance only ever serves /auth/refresh here.
  axios.defaults.adapter = async (config) => {
    refreshCalls += 1;
    return respond(config, { access_token: refreshToken, token_type: "bearer" });
  };
});

/**
 * Run `fn` with window.location swapped for a plain object, so the redirect can
 * be asserted instead of hitting jsdom's unimplemented navigation.
 */
async function withStubbedLocation(pathname: string, fn: () => Promise<void>) {
  const original = Object.getOwnPropertyDescriptor(window, "location");
  const stub = { pathname, href: "" };
  Object.defineProperty(window, "location", { configurable: true, value: stub });
  try {
    await fn();
  } finally {
    if (original) Object.defineProperty(window, "location", original);
  }
  return stub;
}

describe("access token storage", () => {
  it("sends the token as a Bearer header and persists it nowhere", async () => {
    api.defaults.adapter = async (config) => {
      seen.push(config);
      return respond(config, { ok: true });
    };
    tokens.set("in-memory-secret");

    await api.get("/anything");

    expect(seen[0]?.headers.Authorization).toBe("Bearer in-memory-secret");
    // The whole point: an XSS that reads browser storage finds no credential.
    expect(JSON.stringify(localStorage)).not.toContain("in-memory-secret");
    expect(JSON.stringify(sessionStorage)).not.toContain("in-memory-secret");
    expect(document.cookie).not.toContain("in-memory-secret");
    expect(localStorage.length).toBe(0);
  });

  it("sends no Authorization header when signed out", async () => {
    api.defaults.adapter = async (config) => {
      seen.push(config);
      return respond(config);
    };

    await api.get("/anything");

    expect(seen[0]?.headers.Authorization).toBeUndefined();
  });
});

describe("401 recovery", () => {
  it("refreshes once and retries the original request with the new token", async () => {
    api.defaults.adapter = async (config) => {
      seen.push(config);
      // Only the first attempt 401s; the retry (which carries the fresh token) works.
      if (seen.length === 1) return reject(config, 401);
      return respond(config, { ok: true });
    };

    const res = await api.get("/admin/tenants");

    expect(res.data).toEqual({ ok: true });
    expect(refreshCalls).toBe(1);
    expect(seen).toHaveLength(2);
    expect(seen[1]?.headers.Authorization).toBe("Bearer refreshed-token");
    expect(tokens.access).toBe("refreshed-token");
  });

  it("retries only once — a second 401 is surfaced, not looped", async () => {
    api.defaults.adapter = async (config) => {
      seen.push(config);
      return reject(config, 401);
    };

    await expect(api.get("/admin/tenants")).rejects.toBeInstanceOf(AxiosError);

    expect(seen).toHaveLength(2); // original + one retry, then it gives up
    expect(refreshCalls).toBe(1);
  });

  it("shares ONE refresh across concurrent 401s", async () => {
    const failed = new Set<string>();
    api.defaults.adapter = async (config) => {
      seen.push(config);
      const url = config.url || "";
      if (!failed.has(url)) {
        failed.add(url);
        return reject(config, 401);
      }
      return respond(config, { url });
    };

    await Promise.all([api.get("/a"), api.get("/b"), api.get("/c")]);

    // Three requests 401'd at once; they must not each fetch their own token.
    expect(refreshCalls).toBe(1);
  });

  it("never tries to recover the auth endpoints themselves", async () => {
    api.defaults.adapter = async (config) => {
      seen.push(config);
      return reject(config, 401);
    };

    await expect(adminApi.login("a@b.c", "pw")).rejects.toBeInstanceOf(AxiosError);

    expect(refreshCalls).toBe(0);
    expect(seen).toHaveLength(1);
  });

  it("leaves a non-401 failure alone", async () => {
    api.defaults.adapter = async (config) => {
      seen.push(config);
      return reject(config, 500);
    };

    await expect(api.get("/admin/tenants")).rejects.toBeInstanceOf(AxiosError);

    expect(refreshCalls).toBe(0);
    expect(seen).toHaveLength(1);
  });
});

describe("session bootstrap", () => {
  it("makes no /auth/me call when there is no session", async () => {
    refreshToken = null; // the probe answers 200 with a null token
    api.defaults.adapter = async (config) => {
      seen.push(config);
      return respond(config);
    };

    await expect(adminApi.bootstrap()).resolves.toBeNull();

    // A signed-out visitor must produce zero failing requests.
    expect(seen).toHaveLength(0);
    expect(refreshCalls).toBe(1);
  });

  it("loads the user once the cookie yields a token", async () => {
    api.defaults.adapter = async (config) => {
      seen.push(config);
      return respond(config, { id: "u1", email: "root@neubit", is_superadmin: true });
    };

    const user = await adminApi.bootstrap();

    expect(user?.is_superadmin).toBe(true);
    expect(seen.map((c) => c.url)).toEqual(["/auth/me"]);
  });

  it("clears the in-memory token on logout even when the call fails", async () => {
    tokens.set("still-here");
    api.defaults.adapter = async (config) => reject(config, 500);

    await adminApi.logout();

    expect(tokens.access).toBeNull();
  });
});

describe("apiError", () => {
  const withBody = (data: unknown) =>
    new AxiosError("boom", "500", undefined, null, {
      data,
      status: 500,
      statusText: "ERR",
      headers: {},
      config: {} as InternalAxiosRequestConfig,
    } as AxiosResponse);

  it("prefers the uniform error envelope", () => {
    expect(apiError(withBody({ error: { code: "x", message: "Tenant not found" } }))).toBe(
      "Tenant not found"
    );
  });

  it("falls back to FastAPI's detail, then the error message, then the fallback", () => {
    expect(apiError(withBody({ detail: "Not authenticated" }))).toBe("Not authenticated");
    expect(apiError(new Error("network down"))).toBe("network down");
    expect(apiError(undefined, "Could not load")).toBe("Could not load");
  });
});

describe("request shaping", () => {
  it("omits blank list filters instead of sending empty params", async () => {
    api.defaults.adapter = async (config) => {
      seen.push(config);
      return respond(config, { items: [], total: 0, page: 1, page_size: 20 });
    };

    await adminApi.listUsers({ page: 2, pageSize: 50 });

    expect(seen[0]?.params).toEqual({ page: 2, page_size: 50 });
  });

  it("passes the filters it is given", async () => {
    api.defaults.adapter = async (config) => {
      seen.push(config);
      return respond(config, { items: [], total: 0, page: 1, page_size: 20 });
    };

    await adminApi.listUsers({ q: "ada", status: "active", tenantId: "t1" });

    expect(seen[0]?.params).toMatchObject({ q: "ada", status: "active", tenant_id: "t1" });
  });
});

describe("credentials", () => {
  it("sends the refresh cookie with every request", () => {
    // Without this the httpOnly cookie never reaches /auth/refresh and the
    // whole in-memory model silently degrades to "logged out on every reload".
    expect(api.defaults.withCredentials).toBe(true);
  });

  it("does not swallow the refresh failure as a signed-in state", async () => {
    refreshToken = null;
    api.defaults.adapter = async (config) => {
      seen.push(config);
      return reject(config, 401);
    };

    await withStubbedLocation("/dashboard", async () => {
      await expect(api.get("/admin/tenants")).rejects.toBeInstanceOf(AxiosError);
    });

    expect(tokens.access).toBeNull();
  });

  it("bounces to /login once the refresh cookie is gone", async () => {
    refreshToken = null;
    api.defaults.adapter = async (config) => reject(config, 401);

    const location = await withStubbedLocation("/dashboard", async () => {
      await expect(api.get("/admin/tenants")).rejects.toBeInstanceOf(AxiosError);
    });

    expect(location.href).toBe("/login");
  });

  it("does not bounce when it is already on /login", async () => {
    refreshToken = null;
    api.defaults.adapter = async (config) => reject(config, 401);

    const location = await withStubbedLocation("/login", async () => {
      await expect(api.get("/admin/tenants")).rejects.toBeInstanceOf(AxiosError);
    });

    // Redirecting /login to /login is a reload loop, not a recovery.
    expect(location.href).toBe("");
  });
});

// Guard against a future edit reintroducing persistent storage of credentials.
describe("no persistent credential storage", () => {
  it("uses neither localStorage nor sessionStorage", async () => {
    const setLocal = vi.spyOn(Storage.prototype, "setItem");
    api.defaults.adapter = async (config) => respond(config, { ok: true });

    tokens.set("abc");
    await api.get("/x");
    await adminApi.logout();

    expect(setLocal).not.toHaveBeenCalled();
  });
});
