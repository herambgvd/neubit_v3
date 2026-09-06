/**
 * The provider decides what the console renders before any page does, so these
 * pin the session lifecycle rather than the UI.
 */
import axios, { type AxiosResponse, type InternalAxiosRequestConfig } from "axios";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { api, tokens } from "./api";
import { AuthProvider, useAuth } from "./auth";

function respond(config: InternalAxiosRequestConfig, data: unknown = {}): AxiosResponse {
  return { data, status: 200, statusText: "OK", headers: {}, config } as AxiosResponse;
}

/** Every request the console made, in order. */
let seen: InternalAxiosRequestConfig[] = [];
let refreshCalls = 0;
let refreshToken: string | null = "cookie-derived-token";

const ME = { id: "u1", email: "ops@acme", role: { permissions: ["camera.view"] } };
const FEATURES = { modules: [{ key: "vms", enabled: true }], license_state: "active" };

function Probe() {
  const { status, user, can, hasModule, logout } = useAuth();
  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="user">{user?.email ?? "-"}</span>
      <span data-testid="can">{String(can("camera.view"))}</span>
      <span data-testid="cannot">{String(can("camera.delete"))}</span>
      <span data-testid="module">{String(hasModule("vms"))}</span>
      <button type="button" onClick={() => logout()}>
        Sign out
      </button>
    </div>
  );
}

const renderAuth = () =>
  render(
    <AuthProvider>
      <Probe />
    </AuthProvider>
  );

beforeEach(() => {
  tokens.clear();
  seen = [];
  refreshCalls = 0;
  refreshToken = "cookie-derived-token";

  axios.defaults.adapter = async (config) => {
    refreshCalls += 1;
    return respond(config, { access_token: refreshToken });
  };
  api.defaults.adapter = async (config) => {
    seen.push(config);
    const url = config.url || "";
    if (url === "/auth/me") return respond(config, ME);
    if (url === "/features") return respond(config, FEATURES);
    return respond(config, {});
  };
});

describe("session bootstrap", () => {
  // The whole point of moving the access token into memory: a reload has none,
  // and the httpOnly cookie is what brings the session back.
  it("recovers the session from the refresh cookie after a reload", async () => {
    renderAuth();

    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("authed"));
    expect(screen.getByTestId("user")).toHaveTextContent("ops@acme");
    expect(refreshCalls).toBe(1);
    expect(tokens.access).toBe("cookie-derived-token");
  });

  it("settles on anon without calling /auth/me when there is no session", async () => {
    refreshToken = null;

    renderAuth();

    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("anon"));
    // A signed-out visitor must produce no failing request.
    expect(seen.map((c) => c.url)).not.toContain("/auth/me");
  });

  it("does not probe the cookie when a token is already in memory", async () => {
    tokens.set("fresh-from-login");

    renderAuth();

    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("authed"));
    expect(refreshCalls).toBe(0);
  });

  it("falls back to anon when the session exists but /auth/me refuses", async () => {
    api.defaults.adapter = async (config) => {
      seen.push(config);
      if (config.url === "/auth/me") throw new Error("403");
      return respond(config, {});
    };

    renderAuth();

    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("anon"));
    expect(tokens.access).toBeNull();
  });

  it("keeps the session when only entitlements fail", async () => {
    api.defaults.adapter = async (config) => {
      seen.push(config);
      if (config.url === "/auth/me") return respond(config, ME);
      throw new Error("features down");
    };

    renderAuth();

    // Entitlements are permissive when absent — the nav must not flash-hide.
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("authed"));
    expect(screen.getByTestId("module")).toHaveTextContent("true");
  });
});

describe("permissions", () => {
  it("answers can() from the user's role", async () => {
    renderAuth();

    await waitFor(() => expect(screen.getByTestId("can")).toHaveTextContent("true"));
    expect(screen.getByTestId("cannot")).toHaveTextContent("false");
  });

  it("gates a module that the tenant does not have", async () => {
    api.defaults.adapter = async (config) => {
      seen.push(config);
      if (config.url === "/auth/me") return respond(config, ME);
      return respond(config, { modules: [{ key: "vms", enabled: false }] });
    };

    renderAuth();

    await waitFor(() => expect(screen.getByTestId("module")).toHaveTextContent("false"));
  });
});

describe("logout", () => {
  it("revokes server-side with no body — the cookie carries the token", async () => {
    renderAuth();
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("authed"));
    seen = [];

    await userEvent.click(screen.getByRole("button", { name: /sign out/i }));

    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("anon"));
    const logoutCall = seen.find((c) => c.url === "/auth/logout");
    expect(logoutCall).toBeDefined();
    expect(logoutCall?.data).toBeUndefined();
    expect(tokens.access).toBeNull();
  });

  it("clears the local session even when the revoke call fails", async () => {
    renderAuth();
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("authed"));
    api.defaults.adapter = async () => {
      throw new Error("gateway down");
    };

    await userEvent.click(screen.getByRole("button", { name: /sign out/i }));

    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("anon"));
    expect(tokens.access).toBeNull();
  });
});
