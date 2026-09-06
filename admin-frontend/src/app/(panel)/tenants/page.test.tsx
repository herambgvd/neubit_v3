import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { adminApi } from "@/lib/api";
import type { Paged, Tenant } from "@/lib/types";
import { renderWithProviders } from "@/test/render";

import TenantsPage from "./page";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, replace: vi.fn() }) }));

function tenant(over: Partial<Tenant> = {}): Tenant {
  return {
    id: "t1",
    name: "Acme",
    slug: "acme",
    status: "active",
    plan: "pro",
    features: {},
    limits: {},
    license_expires_at: null,
    grace_days: 0,
    license_state: "active",
    created_at: "2026-01-01T00:00:00Z",
    users: 7,
    ...over,
  };
}

const page = (items: Tenant[], over: Partial<Paged<Tenant>> = {}): Paged<Tenant> => ({
  items,
  total: items.length,
  page: 1,
  page_size: 20,
  ...over,
});

beforeEach(() => {
  push.mockClear();
  vi.spyOn(adminApi, "listTenants").mockImplementation(async () =>
    page([
      tenant(),
      tenant({ id: "t2", name: "Globex", slug: "globex", status: "suspended", users: 3 }),
    ])
  );
});

describe("tenants list", () => {
  it("renders each tenant with its status and license state", async () => {
    renderWithProviders(<TenantsPage />);
    await screen.findByText("Acme");
    // Scoped to the table: "Suspended" is also the name of a filter tab.
    const table = within(screen.getByRole("table"));

    expect(table.getByText("Globex")).toBeInTheDocument();
    expect(table.getByText("Suspended")).toBeInTheDocument();
    expect(table.getAllByText("Licensed")).toHaveLength(2);
  });

  it("labels an expired licence distinctly from a grace period", async () => {
    vi.spyOn(adminApi, "listTenants").mockImplementation(async () =>
      page([
        tenant({ license_state: "expired" }),
        tenant({ id: "t2", name: "Globex", license_state: "grace" }),
      ])
    );

    renderWithProviders(<TenantsPage />);

    expect(await screen.findByText("Expired")).toBeInTheDocument();
    expect(screen.getByText("Grace")).toBeInTheDocument();
  });

  it("opens the tenant when its row is clicked", async () => {
    renderWithProviders(<TenantsPage />);
    await screen.findByText("Acme");
    // Click a cell, not the name — the name is a Link that stops propagation.
    await userEvent.click(within(screen.getByRole("table")).getByText("7"));

    expect(push).toHaveBeenCalledWith("/tenants/t1");
  });

  it("passes the search term and status filter to the API", async () => {
    const listTenants = vi.spyOn(adminApi, "listTenants");
    renderWithProviders(<TenantsPage />);
    await screen.findByText("Acme");

    await userEvent.type(screen.getByPlaceholderText(/search name or slug/i), "glo");

    await waitFor(() =>
      expect(listTenants).toHaveBeenLastCalledWith(
        expect.objectContaining({ q: "glo", page: 1 })
      )
    );

    await userEvent.click(screen.getByRole("tab", { name: /suspended/i }));

    await waitFor(() =>
      expect(listTenants).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: "suspended", page: 1 })
      )
    );
  });

  it("validates the create form before calling the API", async () => {
    const createTenant = vi.spyOn(adminApi, "createTenant");

    renderWithProviders(<TenantsPage />);
    await userEvent.click(await screen.findByRole("button", { name: /create tenant/i }));
    // Submit empty: yup must reject before anything reaches the network.
    await userEvent.click(screen.getByRole("button", { name: /^create tenant$/i, hidden: false }));

    expect(await screen.findByText(/organization name is required/i)).toBeInTheDocument();
    expect(createTenant).not.toHaveBeenCalled();
  });

  it("says the load failed rather than showing an empty tenant list", async () => {
    vi.spyOn(adminApi, "listTenants").mockRejectedValue(new Error("core unreachable"));

    renderWithProviders(<TenantsPage />);

    expect(await screen.findByText(/core unreachable/i)).toBeInTheDocument();
    expect(screen.queryByText(/no tenants yet/i)).not.toBeInTheDocument();
  });
});
