import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { adminApi } from "@/lib/api";
import type { AuditEntry, Paged, Tenant } from "@/lib/types";
import { renderWithProviders } from "@/test/render";

import TenantDetailPage from "./page";

const replace = vi.fn();
vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "t1" }),
  useRouter: () => ({ replace, push: vi.fn() }),
}));

const tenant: Tenant = {
  id: "t1",
  name: "Acme",
  slug: "acme",
  status: "active",
  plan: "pro",
  features: {},
  limits: { max_users: 50 },
  license_expires_at: null,
  grace_days: 0,
  license_state: "active",
  created_at: "2026-01-01T00:00:00Z",
  users: 3,
};

function auditPage(page: number, total: number): Paged<AuditEntry> {
  return {
    items: [
      {
        id: `a${page}`,
        tenant_id: "t1",
        actor_id: "u1",
        actor_email: "root@neubit",
        actor_name: null,
        actor_type: "user",
        action: "tenant.license",
        target_type: "tenant",
        target_id: "t1",
        meta: {},
        ts: "2026-01-02T03:04:05Z",
      },
    ],
    total,
    page,
    page_size: 20,
  };
}

beforeEach(() => {
  vi.spyOn(adminApi, "getTenant").mockResolvedValue(tenant);
  vi.spyOn(adminApi, "tenantUsage").mockResolvedValue({ users: 3, limits: { max_users: 50 } });
  vi.spyOn(adminApi, "listTenantAdmins").mockResolvedValue([]);
  vi.spyOn(adminApi, "listModules").mockResolvedValue([]);
  vi.spyOn(adminApi, "getSubscription").mockResolvedValue(null);
  vi.spyOn(adminApi, "listPlans").mockResolvedValue([]);
  vi.spyOn(adminApi, "listInvoices").mockResolvedValue({
    items: [],
    total: 0,
    page: 1,
    page_size: 50,
  });
});

describe("tenant detail — activity timeline", () => {
  // Regression: paging asked for `last.pages`, a field the envelope does not
  // carry, so the check was always false and "Load more" never rendered no
  // matter how many entries existed. The count is derived now.
  it("offers Load more while further pages exist", async () => {
    vi.spyOn(adminApi, "listAudit").mockResolvedValue(auditPage(1, 57));

    renderWithProviders(<TenantDetailPage />);
    await userEvent.click(await screen.findByRole("tab", { name: /activity/i }));

    expect(await screen.findByRole("button", { name: /load more/i })).toBeInTheDocument();
  });

  it("fetches the next page when it is clicked", async () => {
    const listAudit = vi
      .spyOn(adminApi, "listAudit")
      .mockImplementation(async ({ page = 1 } = {}) => auditPage(page, 57));

    renderWithProviders(<TenantDetailPage />);
    await userEvent.click(await screen.findByRole("tab", { name: /activity/i }));
    await userEvent.click(await screen.findByRole("button", { name: /load more/i }));

    await waitFor(() =>
      expect(listAudit).toHaveBeenCalledWith({ tenantId: "t1", page: 2 })
    );
  });

  it("hides Load more on the last page", async () => {
    // 12 entries at 20 per page is a single page — nothing more to fetch.
    vi.spyOn(adminApi, "listAudit").mockResolvedValue(auditPage(1, 12));

    renderWithProviders(<TenantDetailPage />);
    await userEvent.click(await screen.findByRole("tab", { name: /activity/i }));

    await screen.findByText(/license updated/i);
    expect(screen.queryByRole("button", { name: /load more/i })).not.toBeInTheDocument();
  });
});

describe("tenant detail — page states", () => {
  beforeEach(() => {
    vi.spyOn(adminApi, "listAudit").mockResolvedValue(auditPage(1, 0));
  });

  it("renders the tenant once loaded", async () => {
    renderWithProviders(<TenantDetailPage />);

    expect(await screen.findByText("Acme")).toBeInTheDocument();
    expect(screen.getByText("acme")).toBeInTheDocument();
  });

  it("says the tenant is missing rather than rendering a page of blanks", async () => {
    vi.spyOn(adminApi, "getTenant").mockRejectedValue(new Error("Tenant not found"));

    renderWithProviders(<TenantDetailPage />);

    expect(await screen.findByText(/tenant not found/i)).toBeInTheDocument();
  });

  it("confirms before impersonating — the audited action must not be one click", async () => {
    const impersonate = vi.spyOn(adminApi, "impersonate");

    renderWithProviders(<TenantDetailPage />);
    await userEvent.click(await screen.findByRole("button", { name: /open console/i }));

    expect(await screen.findByText(/recorded in the audit log/i)).toBeInTheDocument();
    expect(impersonate).not.toHaveBeenCalled();
  });
});
