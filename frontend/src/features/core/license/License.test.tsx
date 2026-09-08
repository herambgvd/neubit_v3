/**
 * License — two sources, one screen.
 *
 * The page reads the tenant's entitlements (plan, modules, quotas) and the
 * platform's signed licence (client, expiry, limits, features). What is pinned
 * here is what went wrong when they were simply stacked: modules printed twice,
 * an expiry with no reading, and the renewal box open on a screen people come to
 * read rather than to change.
 */
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { stubApi, type ApiStub } from "@/test/apiStub";
import { renderWithProviders } from "@/test/render";

import LicensePage from "./License";

const reload = vi.fn();
const ent = {
  current: {
    plan: "Enterprise",
    modules: [
      { key: "vms", name: "Video", enabled: true },
      { key: "bi", name: "Building Intelligence", enabled: false },
    ],
    limits: { cameras: 64, users: 25 } as Record<string, number>,
    license_state: "active",
    expires_at: null as string | null,
  },
};

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    user: { id: "me" },
    can: () => true,
    hasModule: () => true,
    entitlements: ent.current,
    reload,
  }),
}));

const LICENSE = {
  client: "Acme Industrial",
  expires_at: "2099-01-01T00:00:00Z",
  is_expired: false,
  modules: ["vms"],
  limits: { cameras: 64, storage_gb: 4096 },
  features: { export_watermark: true, offline_maps: false },
  dev: false,
};

let stub: ApiStub;

function stubAll(over: Record<string, unknown> = {}) {
  stub = stubApi({ "GET /license": LICENSE, "POST /license": { ok: true }, ...over });
  return stub;
}

beforeEach(() => {
  reload.mockClear();
  ent.current = { ...ent.current, expires_at: null };
  stubAll();
});

describe("the licence at a glance", () => {
  it("names the licensee and reads the expiry as a countdown, not just a date", async () => {
    renderWithProviders(<LicensePage />);
    expect(await screen.findByText("Acme Industrial")).toBeInTheDocument();
    expect(screen.getByText(/days left/i)).toBeInTheDocument();
  });

  it("prefers the tenant's own expiry over the platform licence's", async () => {
    // A tenant can be wound down inside a platform licence that runs for another
    // year; showing the longer of the two would tell them they are fine.
    // +1h so the floor lands on 5 rather than on 4 by a few milliseconds.
    const soon = new Date(Date.now() + 5 * 86_400_000 + 3_600_000).toISOString();
    ent.current = { ...ent.current, expires_at: soon };
    renderWithProviders(<LicensePage />);
    expect(await screen.findByText(/5 days left/i)).toBeInTheDocument();
  });

  it("says a limit is unlimited rather than printing a dash", async () => {
    stubAll({ "GET /license": { ...LICENSE, limits: {} } });
    ent.current = { ...ent.current, limits: {} };
    renderWithProviders(<LicensePage />);
    // Both of them: a dash where a cap should be reads as "unknown", and an
    // operator cannot tell an uncapped deployment from a page that failed to load.
    expect(await screen.findAllByText(/unlimited/i)).toHaveLength(2);
  });

  it("explains development mode where the limits are shown", async () => {
    stubAll({ "GET /license": { ...LICENSE, dev: true, limits: {}, features: {} } });
    renderWithProviders(<LicensePage />);
    expect(await screen.findByText(/development mode/i)).toBeInTheDocument();
  });
});

describe("modules", () => {
  it("lists each module once, marking the ones the platform licence names", async () => {
    renderWithProviders(<LicensePage />);
    // The catalog is the list — the licence's own "vms" is a mark on the row,
    // not a second chip in a second card.
    expect(await screen.findAllByText("Video")).toHaveLength(1);
    expect(screen.getAllByText("Building Intelligence")).toHaveLength(1);
    expect(screen.getByTitle(/named by the platform license/i)).toBeInTheDocument();
  });

  it("falls back to the licence's own modules when there is no catalog", async () => {
    // A super-admin has no tenant, so no catalog. Printing "no modules" while
    // the licence names them would be plainly wrong.
    ent.current = { ...ent.current, modules: [] };
    renderWithProviders(<LicensePage />);
    expect(await screen.findByText("vms")).toBeInTheDocument();
  });
});

describe("renewal", () => {
  it("keeps the token form closed until an operator says they have one", async () => {
    renderWithProviders(<LicensePage />);
    await screen.findByText("Acme Industrial");

    expect(screen.queryByLabelText(/signed license token/i)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /apply a license token/i }));
    expect(screen.getByLabelText(/signed license token/i)).toBeInTheDocument();
  });

  it("refuses to post an empty token", async () => {
    renderWithProviders(<LicensePage />);
    await screen.findByText("Acme Industrial");
    await userEvent.click(screen.getByRole("button", { name: /apply a license token/i }));

    expect(screen.getByRole("button", { name: /^apply$/i })).toBeDisabled();
    expect(stub.matching("POST /license")).toHaveLength(0);
  });

  it("applies a token and re-reads the entitlements it changes", async () => {
    renderWithProviders(<LicensePage />);
    await screen.findByText("Acme Industrial");
    await userEvent.click(screen.getByRole("button", { name: /apply a license token/i }));

    await userEvent.type(screen.getByLabelText(/signed license token/i), "signed.jwt.token");
    await userEvent.click(screen.getByRole("button", { name: /^apply$/i }));

    await waitFor(() => expect(stub.matching("POST /license")).toHaveLength(1));
    expect(stub.body("POST /license")).toEqual({ token: "signed.jwt.token" });
    // Modules and quotas come off the auth context, not the query cache — a
    // renewal that leaves the old plan on screen is a lie until the next reload.
    await waitFor(() => expect(reload).toHaveBeenCalled());
  });
});
