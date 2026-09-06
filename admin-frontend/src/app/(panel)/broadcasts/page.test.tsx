import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { adminApi } from "@/lib/api";
import type { Broadcast } from "@/lib/types";
import { renderWithProviders } from "@/test/render";

import BroadcastsPage from "./page";

function broadcast(over: Partial<Broadcast> = {}): Broadcast {
  return {
    id: "b1",
    title: "Scheduled maintenance",
    body: "Sunday 02:00–04:00 UTC.",
    severity: "warning",
    target_type: "all",
    target_tenant_ids: [],
    starts_at: null,
    ends_at: null,
    is_active: true,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

beforeEach(() => {
  vi.spyOn(adminApi, "listBroadcasts").mockImplementation(async () => [broadcast()]);
});

describe("broadcasts", () => {
  it("shows the audience and the schedule window", async () => {
    renderWithProviders(<BroadcastsPage />);

    expect(await screen.findByText("Scheduled maintenance")).toBeInTheDocument();
    expect(screen.getByText("All tenants")).toBeInTheDocument();
    expect(screen.getByText("Always on")).toBeInTheDocument();
  });

  it("counts the targeted tenants when the audience is not everyone", async () => {
    vi.spyOn(adminApi, "listBroadcasts").mockImplementation(async () => [
      broadcast({ target_type: "tenants", target_tenant_ids: ["t1", "t2"] }),
    ]);

    renderWithProviders(<BroadcastsPage />);

    expect(await screen.findByText("2 tenant(s)")).toBeInTheDocument();
  });

  it("marks an inactive broadcast", async () => {
    vi.spyOn(adminApi, "listBroadcasts").mockImplementation(async () => [
      broadcast({ is_active: false }),
    ]);

    renderWithProviders(<BroadcastsPage />);

    expect(await screen.findByText("Inactive")).toBeInTheDocument();
  });

  it("toggles active from the list without opening the editor", async () => {
    const updateBroadcast = vi.spyOn(adminApi, "updateBroadcast").mockResolvedValue(broadcast());

    renderWithProviders(<BroadcastsPage />);
    await userEvent.click(await screen.findByRole("switch"));

    await waitFor(() =>
      expect(updateBroadcast).toHaveBeenCalledWith("b1", { is_active: false })
    );
  });

  it("confirms before deleting", async () => {
    const deleteBroadcast = vi.spyOn(adminApi, "deleteBroadcast");

    renderWithProviders(<BroadcastsPage />);
    await userEvent.click(await screen.findByRole("button", { name: /^delete$/i }));

    const dialog = within(await screen.findByRole("dialog"));
    expect(dialog.getByText(/removes the announcement/i)).toBeInTheDocument();
    expect(deleteBroadcast).not.toHaveBeenCalled();
  });

  it("requires a title before creating one", async () => {
    const createBroadcast = vi.spyOn(adminApi, "createBroadcast");

    renderWithProviders(<BroadcastsPage />);
    await userEvent.click(await screen.findByRole("button", { name: /new broadcast/i }));
    await userEvent.click(await screen.findByRole("button", { name: /create broadcast/i }));

    await waitFor(() => expect(createBroadcast).not.toHaveBeenCalled());
  });

  it("sends the typed announcement, converting a blank window to nulls", async () => {
    const createBroadcast = vi.spyOn(adminApi, "createBroadcast").mockResolvedValue(broadcast());

    renderWithProviders(<BroadcastsPage />);
    await userEvent.click(await screen.findByRole("button", { name: /new broadcast/i }));
    await userEvent.type(
      await screen.findByPlaceholderText("Scheduled maintenance"),
      "Password policy change"
    );
    await userEvent.click(screen.getByRole("button", { name: /create broadcast/i }));

    await waitFor(() =>
      expect(createBroadcast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Password policy change",
          target_type: "all",
          target_tenant_ids: [],
          starts_at: null,
          ends_at: null,
          is_active: true,
        })
      )
    );
  });

  it("offers a way in from the empty state", async () => {
    vi.spyOn(adminApi, "listBroadcasts").mockImplementation(async () => []);

    renderWithProviders(<BroadcastsPage />);

    expect(await screen.findByText(/no broadcasts/i)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /new broadcast/i }).length).toBeGreaterThan(0);
  });
});
