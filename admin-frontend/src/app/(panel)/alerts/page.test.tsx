import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { adminApi } from "@/lib/api";
import type { Alert, AlertList } from "@/lib/types";
import { renderWithProviders } from "@/test/render";

import AlertsPage from "./page";

function alert(over: Partial<Alert> = {}): Alert {
  return {
    key: "license:t1",
    severity: "warning",
    category: "license",
    title: "Licence expires in 5 days",
    message: "Acme's licence expires on 2026-01-07.",
    link: "/tenants/t1",
    ts: new Date(Date.now() - 90_000).toISOString(),
    read: false,
    ...over,
  };
}

const list = (items: Alert[]): AlertList => ({
  items,
  total: items.length,
  unread: items.filter((a) => !a.read).length,
});

beforeEach(() => {
  vi.spyOn(adminApi, "listAlerts").mockImplementation(async () => list([alert()]));
});

describe("alerts inbox", () => {
  it("renders an alert with its severity and age", async () => {
    renderWithProviders(<AlertsPage />);

    expect(await screen.findByText(/licence expires in 5 days/i)).toBeInTheDocument();
    expect(screen.getByText("warning")).toBeInTheDocument();
    expect(screen.getByText(/ago$/)).toBeInTheDocument();
  });

  it("offers Mark all read only while something is unread", async () => {
    renderWithProviders(<AlertsPage />);

    expect(await screen.findByRole("button", { name: /mark all read/i })).toBeInTheDocument();
  });

  it("hides Mark all read when everything has been read", async () => {
    vi.spyOn(adminApi, "listAlerts").mockImplementation(async () => list([alert({ read: true })]));

    renderWithProviders(<AlertsPage />);
    await screen.findByText(/licence expires in 5 days/i);

    expect(screen.queryByRole("button", { name: /mark all read/i })).not.toBeInTheDocument();
  });

  it("marks one alert read by its key", async () => {
    const markAlertRead = vi.spyOn(adminApi, "markAlertRead").mockResolvedValue({});

    renderWithProviders(<AlertsPage />);
    await userEvent.click(await screen.findByRole("button", { name: /^mark read$/i }));

    await waitFor(() => expect(markAlertRead).toHaveBeenCalledWith("license:t1"));
  });

  it("dismisses an alert by its key", async () => {
    const dismissAlert = vi.spyOn(adminApi, "dismissAlert").mockResolvedValue({});

    renderWithProviders(<AlertsPage />);
    await userEvent.click(await screen.findByRole("button", { name: /dismiss/i }));

    await waitFor(() => expect(dismissAlert).toHaveBeenCalledWith("license:t1"));
  });

  it("says all clear when there is nothing to act on", async () => {
    vi.spyOn(adminApi, "listAlerts").mockImplementation(async () => list([]));

    renderWithProviders(<AlertsPage />);

    expect(await screen.findByText(/all clear/i)).toBeInTheDocument();
  });

  it("falls back to the severity icon for an unknown category", async () => {
    vi.spyOn(adminApi, "listAlerts").mockImplementation(async () =>
      list([alert({ category: "something-new", severity: "critical" })])
    );

    renderWithProviders(<AlertsPage />);

    // The point is that it renders at all: an unmapped category must not crash.
    expect(await screen.findByText("critical")).toBeInTheDocument();
  });
});
