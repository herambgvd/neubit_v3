import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { adminApi } from "@/lib/api";
import type { AlertList, User } from "@/lib/types";
import { renderWithProviders } from "@/test/render";

import PanelLayout from "./layout";

const replace = vi.fn();
let pathname = "/dashboard";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push: vi.fn() }),
  usePathname: () => pathname,
}));

const superadmin = { id: "u1", email: "root@neubit", is_superadmin: true } as User;
const alerts = (unread: number): AlertList => ({ items: [], total: unread, unread });

beforeEach(() => {
  pathname = "/dashboard";
  replace.mockClear();
  vi.spyOn(adminApi, "bootstrap").mockResolvedValue(superadmin);
  vi.spyOn(adminApi, "listAlerts").mockResolvedValue(alerts(0));
});

describe("panel shell", () => {
  it("renders nothing but a loader until the session is confirmed", async () => {
    vi.spyOn(adminApi, "bootstrap").mockImplementation(() => new Promise(() => {}));

    renderWithProviders(
      <PanelLayout>
        <p>tenant secrets</p>
      </PanelLayout>
    );

    // The gate must not paint the panel while the session is unknown.
    expect(screen.queryByText("tenant secrets")).not.toBeInTheDocument();
  });

  it("bounces a non-super-admin to /login and shows them nothing", async () => {
    vi.spyOn(adminApi, "bootstrap").mockResolvedValue({
      ...superadmin,
      is_superadmin: false,
    } as User);

    renderWithProviders(
      <PanelLayout>
        <p>tenant secrets</p>
      </PanelLayout>
    );

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/login"));
    expect(screen.queryByText("tenant secrets")).not.toBeInTheDocument();
  });

  it("renders the page and the grouped nav for a super-admin", async () => {
    renderWithProviders(
      <PanelLayout>
        <p>tenant secrets</p>
      </PanelLayout>
    );

    expect(await screen.findByText("tenant secrets")).toBeInTheDocument();
    const nav = within(screen.getByRole("navigation"));
    expect(nav.getByRole("link", { name: /tenants/i })).toHaveAttribute("href", "/tenants");
    expect(nav.getByRole("link", { name: /infrastructure/i })).toBeInTheDocument();
  });

  it("marks the current route for assistive tech", async () => {
    pathname = "/tenants";

    renderWithProviders(
      <PanelLayout>
        <p>x</p>
      </PanelLayout>
    );

    const link = await screen.findByRole("link", { name: /tenants/i });
    expect(link).toHaveAttribute("aria-current", "page");
  });

  it("badges unread alerts, and does not badge zero", async () => {
    vi.spyOn(adminApi, "listAlerts").mockResolvedValue(alerts(3));

    const { rerender } = renderWithProviders(
      <PanelLayout>
        <p>x</p>
      </PanelLayout>
    );

    expect(await screen.findByText("3")).toBeInTheDocument();

    vi.spyOn(adminApi, "listAlerts").mockResolvedValue(alerts(0));
    rerender(
      <PanelLayout>
        <p>x</p>
      </PanelLayout>
    );
    await waitFor(() => expect(screen.queryByText("3")).toBeInTheDocument());
  });

  it("caps a large unread count instead of stretching the badge", async () => {
    vi.spyOn(adminApi, "listAlerts").mockResolvedValue(alerts(250));

    renderWithProviders(
      <PanelLayout>
        <p>x</p>
      </PanelLayout>
    );

    expect(await screen.findByText("99+")).toBeInTheDocument();
  });

  // Logging out revokes the refresh token server-side; a stray click must not.
  it("confirms before logging out", async () => {
    const logout = vi.spyOn(adminApi, "logout").mockResolvedValue();

    renderWithProviders(
      <PanelLayout>
        <p>x</p>
      </PanelLayout>
    );
    await userEvent.click(await screen.findByRole("button", { name: /log out/i }));

    const dialog = within(await screen.findByRole("dialog"));
    expect(dialog.getByText(/sign in again/i)).toBeInTheDocument();
    expect(logout).not.toHaveBeenCalled();
  });

  it("opens the command palette on the keyboard shortcut", async () => {
    vi.spyOn(adminApi, "listTenants").mockResolvedValue([]);
    vi.spyOn(adminApi, "listUsers").mockResolvedValue([]);

    renderWithProviders(
      <PanelLayout>
        <p>x</p>
      </PanelLayout>
    );
    await screen.findByText("x");

    await userEvent.keyboard("{Meta>}k{/Meta}");

    expect(
      await screen.findByPlaceholderText(/search tenants, users, or jump to a page/i)
    ).toBeInTheDocument();
  });
});
