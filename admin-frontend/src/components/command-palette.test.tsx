import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { adminApi } from "@/lib/api";
import type { AdminUser, Paged, Tenant } from "@/lib/types";
import { renderWithProviders } from "@/test/render";

import { CommandPalette, type PaletteAction, type PaletteNavItem } from "./command-palette";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, replace: vi.fn() }) }));

const navItems: PaletteNavItem[] = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/tenants", label: "Tenants" },
];

const tenantPage: Paged<Tenant> = {
  items: [{ id: "t1", name: "Acme", slug: "acme" } as Tenant],
  total: 1,
  page: 1,
  page_size: 6,
};

const userPage: Paged<AdminUser> = {
  items: [
    { id: "u1", email: "ada@acme", full_name: "Ada Lovelace", tenant_id: "t1", tenant_name: "Acme" } as AdminUser,
  ],
  total: 1,
  page: 1,
  page_size: 6,
};

beforeEach(() => {
  push.mockClear();
  vi.spyOn(adminApi, "listTenants").mockResolvedValue(tenantPage);
  vi.spyOn(adminApi, "listUsers").mockResolvedValue(userPage);
});

function open(actions: PaletteAction[] = []) {
  const onOpenChange = vi.fn();
  renderWithProviders(
    <CommandPalette open onOpenChange={onOpenChange} navItems={navItems} actions={actions} />
  );
  return onOpenChange;
}

describe("command palette", () => {
  it("lists the pages it can jump to before anything is typed", async () => {
    open();

    expect(await screen.findByText("Dashboard")).toBeInTheDocument();
    expect(screen.getByText("Tenants")).toBeInTheDocument();
    // No query yet, so it must not have searched.
    expect(adminApi.listTenants).not.toHaveBeenCalled();
  });

  it("navigates and closes when a page is chosen", async () => {
    const onOpenChange = open();
    await userEvent.click(await screen.findByText("Tenants"));

    expect(push).toHaveBeenCalledWith("/tenants");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("runs an action and closes", async () => {
    const run = vi.fn();
    const onOpenChange = open([{ id: "logout", label: "Log out", run }]);

    await userEvent.click(await screen.findByText("Log out"));

    expect(run).toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("filters the static entries as you type, without waiting on the network", async () => {
    open();
    await userEvent.type(await screen.findByRole("combobox"), "dash");

    await waitFor(() => expect(screen.queryByText("Tenants")).not.toBeInTheDocument());
    expect(screen.getByText("Dashboard")).toBeInTheDocument();
  });

  it("searches tenants and users once a term is entered", async () => {
    open();
    await userEvent.type(await screen.findByRole("combobox"), "ac");

    expect(await screen.findByText("Acme")).toBeInTheDocument();
    expect(await screen.findByText("Ada Lovelace")).toBeInTheDocument();
    await waitFor(() =>
      expect(adminApi.listTenants).toHaveBeenCalledWith({ q: "ac", pageSize: 6 })
    );
  });

  it("opens a found tenant", async () => {
    open();
    await userEvent.type(await screen.findByRole("combobox"), "ac");
    await userEvent.click(await screen.findByText("Acme"));

    expect(push).toHaveBeenCalledWith("/tenants/t1");
  });

  it("lands a user on their tenant, since there is no standalone user page", async () => {
    open();
    await userEvent.type(await screen.findByRole("combobox"), "ada");
    await userEvent.click(await screen.findByText("Ada Lovelace"));

    expect(push).toHaveBeenCalledWith("/tenants/t1");
  });

  it("runs the highlighted row on Enter, and moves the highlight with the arrows", async () => {
    open();
    await screen.findByText("Dashboard");

    // First row is highlighted by default; one ArrowDown moves to the second.
    await userEvent.keyboard("{ArrowDown}{Enter}");

    expect(push).toHaveBeenCalledWith("/tenants");
  });

  it("wraps around at the end of the list", async () => {
    open();
    await screen.findByText("Dashboard");

    // Two entries: down twice returns to the first.
    await userEvent.keyboard("{ArrowDown}{ArrowDown}{Enter}");

    expect(push).toHaveBeenCalledWith("/dashboard");
  });

  // The palette holds its state inside the Radix portal, which unmounts on close.
  // That is what makes every open start clean without an effect resetting it.
  it("starts blank again after being closed and reopened", async () => {
    const onOpenChange = vi.fn();
    const { rerender } = renderWithProviders(
      <CommandPalette open onOpenChange={onOpenChange} navItems={navItems} actions={[]} />
    );
    await userEvent.type(await screen.findByRole("combobox"), "ada");
    expect(screen.getByRole("combobox")).toHaveValue("ada");

    rerender(
      <CommandPalette open={false} onOpenChange={onOpenChange} navItems={navItems} actions={[]} />
    );
    rerender(
      <CommandPalette open onOpenChange={onOpenChange} navItems={navItems} actions={[]} />
    );

    expect(await screen.findByRole("combobox")).toHaveValue("");
  });

  it("says so when nothing matches", async () => {
    vi.spyOn(adminApi, "listTenants").mockResolvedValue({ ...tenantPage, items: [] });
    vi.spyOn(adminApi, "listUsers").mockResolvedValue({ ...userPage, items: [] });

    open();
    await userEvent.type(await screen.findByRole("combobox"), "zzzz");

    expect(await screen.findByText(/no results found/i)).toBeInTheDocument();
  });
});
