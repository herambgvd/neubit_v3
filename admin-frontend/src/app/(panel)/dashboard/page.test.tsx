import { screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { adminApi } from "@/lib/api";
import type { Paged, Tenant } from "@/lib/types";
import { renderWithProviders } from "@/test/render";

import DashboardPage from "./page";

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
    users: 10,
    ...over,
  };
}

const page = (items: Tenant[], total = items.length): Paged<Tenant> => ({
  items,
  total,
  page: 1,
  page_size: 100,
});

beforeEach(() => {
  vi.spyOn(adminApi, "listTenants").mockImplementation(async () =>
    page(
      [
        tenant(),
        tenant({ id: "t2", name: "Globex", status: "suspended", users: 4 }),
        tenant({ id: "t3", name: "Initech", license_state: "expired", users: 1 }),
      ],
      3
    )
  );
});

describe("platform overview", () => {
  it("counts tenants, active, suspended and seats", async () => {
    renderWithProviders(<DashboardPage />);
    // "Tenants" is both a KPI label and the donut's centre label.
    await screen.findAllByText("Tenants");

    // 3 tenants, 1 suspended, 15 users in total.
    expect(screen.getAllByText("3").length).toBeGreaterThan(0);
    expect(screen.getByText("15")).toBeInTheDocument();
    expect(screen.getByText("Suspended")).toBeInTheDocument();
  });

  it("lists the tenants whose licence needs attention, and only those", async () => {
    renderWithProviders(<DashboardPage />);

    // "Expired" also labels a donut segment; the attention list is what matters.
    const attention = (await screen.findByText(/license attention/i)).closest("div")!
      .parentElement!;
    expect(within(attention).getByText("Initech")).toBeInTheDocument();
    // Acme and Globex are licensed, so they must not be listed as needing work.
    expect(within(attention).queryByText("Acme")).not.toBeInTheDocument();
    expect(screen.queryByText(/in grace period/i)).not.toBeInTheDocument();
  });

  it("says so when every licence is healthy", async () => {
    vi.spyOn(adminApi, "listTenants").mockImplementation(async () => page([tenant()]));

    renderWithProviders(<DashboardPage />);

    expect(await screen.findByText(/all tenant licenses are healthy/i)).toBeInTheDocument();
  });

  it("groups tenants by plan, counting the unassigned ones", async () => {
    vi.spyOn(adminApi, "listTenants").mockImplementation(async () =>
      page([tenant(), tenant({ id: "t2", name: "Globex", plan: null })])
    );

    renderWithProviders(<DashboardPage />);

    expect(await screen.findByText("Unassigned")).toBeInTheDocument();
    expect(screen.getByText("pro")).toBeInTheDocument();
  });

  it("reports a failed load instead of a dashboard of zeroes", async () => {
    vi.spyOn(adminApi, "listTenants").mockRejectedValue(new Error("core unreachable"));

    renderWithProviders(<DashboardPage />);

    expect(await screen.findByText(/core unreachable/i)).toBeInTheDocument();
    expect(screen.queryByText("Total users")).not.toBeInTheDocument();
  });
});
