/**
 * The API keys table states whether a key WORKS, so it has to agree with the
 * server's own rule.
 *
 * It rendered `is_active` alone. The backend refuses a key past `expires_at`
 * (`ApiKey.usable_at`, auth/models.py) — so an expired key sat in this table
 * marked ACTIVE while every request carrying it was being rejected, and the
 * screen offered no way to find out why.
 *
 * The other guard is the failed load: an error rendered the same empty table as
 * a tenant with no keys, which invites minting a replacement for a key that
 * already exists.
 */
import { screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiKeyOut } from "../types";
import { httpError, stubApi } from "@/test/apiStub";
import { renderWithProviders } from "@/test/render";

import ApiKeysPage from "./ApiKeys";
import { apiKeyStatus } from "./format";

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { id: "me" }, can: () => true, hasModule: () => true }),
}));

const NOW = new Date("2026-06-01T00:00:00Z");

function key(over: Partial<ApiKeyOut> = {}): ApiKeyOut {
  return {
    id: "k1",
    name: "CI runner",
    description: null,
    prefix: "nbk_abc123",
    scopes: [],
    role: { id: "r1", name: "Operator" } as ApiKeyOut["role"],
    is_active: true,
    expires_at: null,
    revoked_at: null,
    created_by: null,
    created_at: "2026-01-01T00:00:00Z",
    last_used_at: null,
    ...over,
  };
}

function page(items: ApiKeyOut[], total = items.length) {
  return { items, total, page: 1, page_size: 100 };
}

describe("apiKeyStatus", () => {
  it("calls a key past its expiry EXPIRED, not active", () => {
    expect(apiKeyStatus(key({ expires_at: "2026-05-01T00:00:00Z" }), NOW)).toBe("expired");
  });

  it("leaves a key with a future expiry active", () => {
    expect(apiKeyStatus(key({ expires_at: "2027-01-01T00:00:00Z" }), NOW)).toBe("active");
  });

  it("treats no expiry as no expiry", () => {
    expect(apiKeyStatus(key({ expires_at: null }), NOW)).toBe("active");
  });

  it("reports a revoked key as revoked even when it also expired", () => {
    // Revocation is the fact someone acted on; expiry merely happened.
    expect(
      apiKeyStatus(key({ is_active: false, revoked_at: "2026-02-01T00:00:00Z", expires_at: "2026-03-01T00:00:00Z" }), NOW),
    ).toBe("revoked");
  });

  it("follows revoked_at even if is_active was left true", () => {
    expect(apiKeyStatus(key({ revoked_at: "2026-02-01T00:00:00Z" }), NOW)).toBe("revoked");
  });
});

describe("the API keys table", () => {
  beforeEach(() => {
    vi.setSystemTime(NOW);
  });

  it("does not call an expired key active", async () => {
    stubApi({
      "GET /auth/api-keys": page([key({ name: "Old key", expires_at: "2026-05-01T00:00:00Z" })]),
      "GET /auth/roles": page([]),
    });
    renderWithProviders(<ApiKeysPage />);

    const row = (await screen.findByText("Old key")).closest("tr")!;
    expect(within(row).getByText("Expired")).toBeInTheDocument();
    expect(within(row).queryByText("Active")).not.toBeInTheDocument();
  });

  it("shows the expiry date behind the verdict", async () => {
    stubApi({
      "GET /auth/api-keys": page([key({ expires_at: "2026-05-01T00:00:00Z" })]),
      "GET /auth/roles": page([]),
    });
    renderWithProviders(<ApiKeysPage />);

    const row = (await screen.findByText("CI runner")).closest("tr")!;
    expect(within(row).getByText(/May 1, 2026/)).toBeInTheDocument();
  });

  it("says a key was never used rather than showing a dash for it", async () => {
    stubApi({
      "GET /auth/api-keys": page([key({ last_used_at: null })]),
      "GET /auth/roles": page([]),
    });
    renderWithProviders(<ApiKeysPage />);

    const row = (await screen.findByText("CI runner")).closest("tr")!;
    expect(within(row).getAllByText("Never").length).toBeGreaterThan(0);
  });

  it("reports a failed load instead of an empty table", async () => {
    stubApi({
      "GET /auth/api-keys": () => httpError(503, "the directory is unreachable"),
      "GET /auth/roles": page([]),
    });
    renderWithProviders(<ApiKeysPage />);

    // The server's own reason, not a generic one — "Couldn't load" tells an
    // operator nothing they can act on.
    expect(await screen.findByText(/the directory is unreachable/i)).toBeInTheDocument();
    expect(screen.queryByText(/No API keys yet/i)).not.toBeInTheDocument();
  });

  it("says so when the list is only the first page", async () => {
    stubApi({
      "GET /auth/api-keys": page([key()], 140),
      "GET /auth/roles": page([]),
    });
    renderWithProviders(<ApiKeysPage />);

    expect(await screen.findByText(/Showing the first 1 of 140 keys/i)).toBeInTheDocument();
  });

  it("offers revoke on a live key and not on one already revoked", async () => {
    stubApi({
      "GET /auth/api-keys": page([
        key({ id: "a", name: "Live" }),
        key({ id: "b", name: "Dead", is_active: false, revoked_at: "2026-02-01T00:00:00Z" }),
      ]),
      "GET /auth/roles": page([]),
    });
    renderWithProviders(<ApiKeysPage />);

    expect(await screen.findByRole("button", { name: "Revoke Live" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Revoke Dead" })).not.toBeInTheDocument();
  });
});
