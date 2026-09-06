import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { adminApi } from "@/lib/api";
import type { AdminUser, Paged } from "@/lib/types";
import { renderWithProviders } from "@/test/render";

import UsersPage from "./page";

function user(over: Partial<AdminUser> = {}): AdminUser {
  return {
    id: "u1",
    email: "ada@acme",
    full_name: "Ada Lovelace",
    is_active: true,
    email_verified: true,
    is_superadmin: false,
    role_name: "Administrator",
    tenant_id: "t1",
    tenant_name: "Acme",
    tenant_slug: "acme",
    last_login_at: "2026-01-02T03:04:05Z",
    created_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

const page = (items: AdminUser[], over: Partial<Paged<AdminUser>> = {}): Paged<AdminUser> => ({
  items,
  total: items.length,
  page: 1,
  page_size: 20,
  ...over,
});

beforeEach(() => {
  vi.spyOn(adminApi, "listUsers").mockImplementation(async () => page([user()]));
});

describe("cross-tenant user directory", () => {
  it("shows the user, their tenant and their role", async () => {
    renderWithProviders(<UsersPage />);
    await screen.findByText("Ada Lovelace");
    const table = within(screen.getByRole("table"));

    expect(table.getByText("Acme")).toBeInTheDocument();
    expect(table.getByText("Administrator")).toBeInTheDocument();
    expect(table.getByText("Active")).toBeInTheDocument();
  });

  it("marks a platform super-admin instead of pretending they have a tenant", async () => {
    vi.spyOn(adminApi, "listUsers").mockImplementation(async () =>
      page([user({ is_superadmin: true, tenant_id: null, tenant_name: null })])
    );

    renderWithProviders(<UsersPage />);

    expect(await screen.findByText("Platform")).toBeInTheDocument();
  });

  // Disabling signs someone out, so it must never be a single stray click.
  it("confirms before disabling a user", async () => {
    const setUserActive = vi.spyOn(adminApi, "setUserActive");

    renderWithProviders(<UsersPage />);
    await userEvent.click(await screen.findByRole("button", { name: /disable/i }));

    expect(await screen.findByText(/blocked from logging in/i)).toBeInTheDocument();
    expect(setUserActive).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: /disable user/i }));

    await waitFor(() => expect(setUserActive).toHaveBeenCalledWith("u1", false));
  });

  it("re-enables without a confirmation — it is not destructive", async () => {
    vi.spyOn(adminApi, "listUsers").mockImplementation(async () =>
      page([user({ is_active: false })])
    );
    const setUserActive = vi
      .spyOn(adminApi, "setUserActive")
      .mockResolvedValue(user({ is_active: true }));

    renderWithProviders(<UsersPage />);
    await userEvent.click(await screen.findByRole("button", { name: /enable/i }));

    await waitFor(() => expect(setUserActive).toHaveBeenCalledWith("u1", true));
  });

  it("offers no enable/disable control for a platform super-admin", async () => {
    vi.spyOn(adminApi, "listUsers").mockImplementation(async () =>
      page([user({ is_superadmin: true })])
    );

    renderWithProviders(<UsersPage />);
    await screen.findByText("Ada Lovelace");

    expect(screen.queryByRole("button", { name: /disable/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /enable/i })).not.toBeInTheDocument();
  });

  it("flags an unverified address", async () => {
    vi.spyOn(adminApi, "listUsers").mockImplementation(async () =>
      page([user({ email_verified: false })])
    );

    renderWithProviders(<UsersPage />);

    expect(await screen.findByText("Unverified")).toBeInTheDocument();
  });
});
