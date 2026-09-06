/**
 * The token model, as a property rather than an implementation detail:
 *
 *   1. the access token exists only in memory — never localStorage, never a cookie
 *   2. the refresh token is never touched by JavaScript at all; /auth/refresh is
 *      called with no body and rides the httpOnly cookie
 *   3. a 401 is recovered once, and concurrent 401s share ONE refresh
 *   4. the auth lifecycle endpoints are never themselves retried
 *   5. tokens written by the OLD build are deleted, not left in localStorage
 *
 * Requests are served by a stub axios adapter, so nothing here touches a network.
 */
import axios, { AxiosError, type AxiosResponse, type InternalAxiosRequestConfig } from "axios";
import { beforeEach, describe, expect, it } from "vitest";

import { api, apiError, bootstrapSession, tokens } from "./api";

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

/** Run `fn` with window.location stubbed, so redirects can be asserted. */
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

let seen: InternalAxiosRequestConfig[] = [];
let refreshCalls: InternalAxiosRequestConfig[] = [];
let refreshToken: string | null = "refreshed-token";

beforeEach(() => {
  tokens.clear();
  seen = [];
  refreshCalls = [];
  refreshToken = "refreshed-token";
  // The bare axios instance only ever serves /auth/refresh here.
  axios.defaults.adapter = async (config) => {
    refreshCalls.push(config);
    return respond(config, { access_token: refreshToken });
  };
});

describe("access token storage", () => {
  it("sends the token as a Bearer header and persists it nowhere", async () => {
    api.defaults.adapter = async (config) => {
      seen.push(config);
      return respond(config, { ok: true });
    };
    tokens.set("in-memory-secret");

    await api.get("/anything");

    expect(seen[0]?.headers.Authorization).toBe("Bearer in-memory-secret");
    expect(JSON.stringify(localStorage)).not.toContain("in-memory-secret");
    expect(JSON.stringify(sessionStorage)).not.toContain("in-memory-secret");
    expect(document.cookie).not.toContain("in-memory-secret");
    expect(localStorage.length).toBe(0);
  });

  it("exposes no refresh token to JavaScript at all", () => {
    // The old model had `tokens.refresh`. Its absence is the point.
    expect("refresh" in tokens).toBe(false);
  });

  // An install running the old build has a 30-day refresh token in localStorage
  // right now. Shipping the new model without deleting it would leave it there.
  it("deletes tokens written by the previous build", () => {
    localStorage.setItem("vizor.access", "old-access");
    localStorage.setItem("vizor.refresh", "old-refresh");

    tokens.clear();

    expect(localStorage.getItem("vizor.access")).toBeNull();
    expect(localStorage.getItem("vizor.refresh")).toBeNull();
  });

  it("sends no Authorization header when signed out", async () => {
    api.defaults.adapter = async (config) => {
      seen.push(config);
      return respond(config);
    };

    await api.get("/anything");

    expect(seen[0]?.headers.Authorization).toBeUndefined();
  });

  it("sends credentials, so the httpOnly cookie reaches /auth/*", () => {
    // Without this a cross-origin deployment silently loses every session on reload.
    expect(api.defaults.withCredentials).toBe(true);
  });
});

describe("401 recovery", () => {
  it("refreshes once and retries the original request with the new token", async () => {
    api.defaults.adapter = async (config) => {
      seen.push(config);
      if (seen.length === 1) return reject(config, 401);
      return respond(config, { ok: true });
    };

    const res = await api.get("/cameras");

    expect(res.data).toEqual({ ok: true });
    expect(refreshCalls).toHaveLength(1);
    expect(seen[1]?.headers.Authorization).toBe("Bearer refreshed-token");
    expect(tokens.access).toBe("refreshed-token");
  });

  it("asks for the refresh with no body — the cookie carries the token", async () => {
    api.defaults.adapter = async (config) => {
      seen.push(config);
      return seen.length === 1 ? reject(config, 401) : respond(config);
    };

    await api.get("/cameras");

    expect(refreshCalls[0]?.data).toBeUndefined();
    expect(refreshCalls[0]?.withCredentials).toBe(true);
  });

  it("retries only once — a second 401 is surfaced, not looped", async () => {
    api.defaults.adapter = async (config) => {
      seen.push(config);
      return reject(config, 401);
    };

    await withStubbedLocation("/home", async () => {
      await expect(api.get("/cameras")).rejects.toBeInstanceOf(AxiosError);
    });

    expect(seen).toHaveLength(2);
    expect(refreshCalls).toHaveLength(1);
  });

  it("shares ONE refresh across concurrent 401s", async () => {
    const failed = new Set<string>();
    api.defaults.adapter = async (config) => {
      const url = config.url || "";
      if (!failed.has(url)) {
        failed.add(url);
        return reject(config, 401);
      }
      return respond(config, { url });
    };

    await Promise.all([api.get("/a"), api.get("/b"), api.get("/c")]);

    expect(refreshCalls).toHaveLength(1);
  });

  it("never tries to recover the auth lifecycle endpoints", async () => {
    api.defaults.adapter = async (config) => {
      seen.push(config);
      return reject(config, 401);
    };

    await withStubbedLocation("/login", async () => {
      for (const path of ["/auth/login", "/auth/login/mfa", "/auth/refresh", "/auth/logout"]) {
        await expect(api.post(path)).rejects.toBeInstanceOf(AxiosError);
      }
    });

    // A login 401 means "wrong credentials"; refreshing would mask it.
    expect(refreshCalls).toHaveLength(0);
    expect(seen).toHaveLength(4);
  });

  it("treats /auth/me as an ordinary request and refreshes for it", async () => {
    api.defaults.adapter = async (config) => {
      seen.push(config);
      return seen.length === 1 ? reject(config, 401) : respond(config, { id: "u1" });
    };

    await api.get("/auth/me");

    expect(refreshCalls).toHaveLength(1);
  });

  it("bounces to /login when the refresh cookie is gone", async () => {
    refreshToken = null;
    api.defaults.adapter = async (config) => reject(config, 401);

    const location = await withStubbedLocation("/home", async () => {
      await expect(api.get("/cameras")).rejects.toBeInstanceOf(AxiosError);
    });

    expect(location.href).toBe("/login");
    expect(tokens.access).toBeNull();
  });

  it("does not bounce when it is already on /login", async () => {
    refreshToken = null;
    api.defaults.adapter = async (config) => reject(config, 401);

    const location = await withStubbedLocation("/login", async () => {
      await expect(api.post("/auth/login")).rejects.toBeInstanceOf(AxiosError);
    });

    expect(location.href).toBe("");
  });

  it("routes an expired licence to its own screen instead of logging out", async () => {
    api.defaults.adapter = async (config) =>
      reject(config, 403, { error: { code: "LICENSE_EXPIRED", message: "expired" } });

    const location = await withStubbedLocation("/home", async () => {
      await expect(api.get("/cameras")).rejects.toBeInstanceOf(AxiosError);
    });

    expect(location.href).toBe("/license-expired");
  });

  it("leaves a plain 500 alone", async () => {
    api.defaults.adapter = async (config) => {
      seen.push(config);
      return reject(config, 500);
    };

    await expect(api.get("/cameras")).rejects.toBeInstanceOf(AxiosError);

    expect(refreshCalls).toHaveLength(0);
    expect(seen).toHaveLength(1);
  });
});

describe("bootstrapSession", () => {
  it("returns the in-memory token without touching the network", async () => {
    tokens.set("already-here");

    await expect(bootstrapSession()).resolves.toBe("already-here");

    expect(refreshCalls).toHaveLength(0);
  });

  it("probes the cookie after a reload and adopts the token it gets", async () => {
    await expect(bootstrapSession()).resolves.toBe("refreshed-token");

    expect(refreshCalls).toHaveLength(1);
    expect(tokens.access).toBe("refreshed-token");
  });

  it("answers null for a signed-out visitor, with nothing failing", async () => {
    refreshToken = null;

    await expect(bootstrapSession()).resolves.toBeNull();

    expect(tokens.access).toBeNull();
  });

  it("shares one probe across concurrent callers", async () => {
    await Promise.all([bootstrapSession(), bootstrapSession(), bootstrapSession()]);

    expect(refreshCalls).toHaveLength(1);
  });
});

describe("apiError", () => {
  it("prefers the uniform error envelope, then the message, then the fallback", () => {
    const withEnvelope = new AxiosError("boom", "500", undefined, null, {
      data: { error: { code: "x", message: "Camera not found" } },
      status: 500,
      statusText: "ERR",
      headers: {},
      config: {} as InternalAxiosRequestConfig,
    } as AxiosResponse);

    expect(apiError(withEnvelope)).toBe("Camera not found");
    expect(apiError(new Error("network down"))).toBe("network down");
    expect(apiError(undefined, "Could not load")).toBe("Could not load");
  });
});
