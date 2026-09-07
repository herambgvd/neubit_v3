/**
 * Video wall → management. Everything on this screen is CRUD over shared control-
 * room furniture, so:
 *
 *   1. deleting a wall takes its monitors, presets and tours with it — the API
 *      must not be called until the operator confirms; the same holds for a
 *      monitor and a decoder
 *   2. a failed load must not read as "No walls yet", which invites an operator
 *      to recreate walls that already exist
 *   3. permission gates the destructive controls, not just the create button
 *   4. selection is derived, so the first wall shows with no clicking and an
 *      explicit choice survives a refetch
 */
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";

import WallManagement from "./WallManagement";
import { videowall } from "./api";
import type { WallMonitor, WallPublic } from "./types";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

/** Which permissions the signed-in operator holds for this render. */
const permissions = { view: true, manage: true };
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    can: (p: string) => (p === "vms.wall.manage" ? permissions.manage : permissions.view),
  }),
}));

function wall(id: string, name: string): WallPublic {
  return {
    id,
    name,
    description: null,
    rows: 2,
    cols: 2,
    is_active: true,
  } as WallPublic;
}

function monitor(id: string, name: string): WallMonitor {
  return {
    id,
    wall_id: "w1",
    name,
    position: 0,
    kind: "browser",
    layout: 4,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  } as WallMonitor;
}

const MAIN = wall("w1", "Main wall");
const BACKUP = wall("w2", "Backup wall");

beforeEach(() => {
  permissions.view = true;
  permissions.manage = true;
  vi.spyOn(videowall.monitors, "list").mockResolvedValue({ items: [], total: 0 } as never);
  vi.spyOn(videowall.presets, "list").mockResolvedValue({ items: [], total: 0 } as never);
  vi.spyOn(videowall.tours, "list").mockResolvedValue({ items: [], total: 0 } as never);
  vi.spyOn(videowall.decoders, "list").mockResolvedValue({ items: [], total: 0 } as never);
});

const wallsReturn = (items: WallPublic[]) =>
  vi.spyOn(videowall.walls, "list").mockResolvedValue({ items, total: items.length } as never);

describe("a failed load", () => {
  it("reports the failure instead of an estate with no walls", async () => {
    vi.spyOn(videowall.walls, "list").mockRejectedValue(new Error("wall service is down"));

    renderWithProviders(<WallManagement />);

    expect(await screen.findByText(/wall service is down/i)).toBeInTheDocument();
    expect(screen.queryByText(/no walls yet/i)).not.toBeInTheDocument();
  });

  it("says there are no walls only when the call actually succeeded", async () => {
    wallsReturn([]);

    renderWithProviders(<WallManagement />);

    expect(await screen.findByText(/no walls yet/i)).toBeInTheDocument();
  });

  it("distinguishes 'nothing matches your search' from 'nothing exists'", async () => {
    wallsReturn([MAIN]);

    renderWithProviders(<WallManagement />);
    await screen.findByRole("button", { name: /main wall/i });

    await userEvent.type(screen.getByPlaceholderText(/search walls/i), "zzz");

    expect(await screen.findByText(/no walls match your search/i)).toBeInTheDocument();
  });
});

describe("deleting a wall", () => {
  it("does not call the API until the operator confirms", async () => {
    wallsReturn([MAIN]);
    const remove = vi.spyOn(videowall.walls, "remove").mockResolvedValue(undefined as never);

    renderWithProviders(<WallManagement />);
    await userEvent.click(await screen.findByRole("button", { name: /^delete$/i }));

    expect(await screen.findByRole("heading", { name: /delete wall/i })).toBeInTheDocument();
    expect(remove).not.toHaveBeenCalled();
  });

  it("spells out that the monitors, presets and tours go with it", async () => {
    wallsReturn([MAIN]);
    vi.spyOn(videowall.walls, "remove").mockResolvedValue(undefined as never);

    renderWithProviders(<WallManagement />);
    await userEvent.click(await screen.findByRole("button", { name: /^delete$/i }));

    expect(await screen.findByText(/monitors, presets and tours/i)).toBeInTheDocument();
    expect(screen.getByText(/can't be undone/i)).toBeInTheDocument();
  });

  it("deletes the wall once the operator confirms", async () => {
    wallsReturn([MAIN]);
    const remove = vi.spyOn(videowall.walls, "remove").mockResolvedValue(undefined as never);

    renderWithProviders(<WallManagement />);
    await userEvent.click(await screen.findByRole("button", { name: /^delete$/i }));
    await userEvent.click(screen.getAllByRole("button", { name: /^delete$/i }).at(-1)!);

    await waitFor(() => expect(remove).toHaveBeenCalledWith("w1"));
  });

  it("leaves the wall alone when the operator cancels", async () => {
    wallsReturn([MAIN]);
    const remove = vi.spyOn(videowall.walls, "remove").mockResolvedValue(undefined as never);

    renderWithProviders(<WallManagement />);
    await userEvent.click(await screen.findByRole("button", { name: /^delete$/i }));
    await userEvent.click(await screen.findByRole("button", { name: /cancel/i }));

    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: /delete wall/i })).not.toBeInTheDocument(),
    );
    expect(remove).not.toHaveBeenCalled();
  });
});

describe("removing a monitor from a wall", () => {
  it("does not call the API until the operator confirms", async () => {
    wallsReturn([MAIN]);
    vi.spyOn(videowall.monitors, "list").mockResolvedValue({
      items: [monitor("m1", "Screen A")],
      total: 1,
    } as never);
    const remove = vi.spyOn(videowall.monitors, "remove").mockResolvedValue(undefined as never);

    renderWithProviders(<WallManagement />);
    // The per-row trash control on the Monitors tab.
    await userEvent.click(await screen.findByTitle("Delete"));

    expect(await screen.findByRole("heading", { name: /remove monitor/i })).toBeInTheDocument();
    expect(remove).not.toHaveBeenCalled();

    await userEvent.click(await screen.findByRole("button", { name: /^remove$/i }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith("w1", "m1"));
  });
});

describe("permissions", () => {
  it("shows a read-only operator the walls but none of the destructive controls", async () => {
    permissions.manage = false;
    wallsReturn([MAIN]);

    renderWithProviders(<WallManagement />);

    expect(await screen.findByRole("heading", { name: "Main wall" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^delete$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /new wall/i })).toBeNull();
  });

  it("shows nothing at all to an operator without view access", async () => {
    permissions.view = false;
    const list = wallsReturn([MAIN]);

    renderWithProviders(<WallManagement />);

    expect(await screen.findByText(/no access/i)).toBeInTheDocument();
    expect(list).not.toHaveBeenCalled();
  });
});

describe("which wall is shown", () => {
  it("shows the first wall without the operator choosing anything", async () => {
    wallsReturn([MAIN, BACKUP]);

    renderWithProviders(<WallManagement />);

    expect(await screen.findByRole("heading", { name: "Main wall" })).toBeInTheDocument();
    expect(screen.queryByText(/no wall selected/i)).not.toBeInTheDocument();
  });

  it("keeps the operator's choice when the list refetches", async () => {
    const list = wallsReturn([MAIN, BACKUP]);

    const { client } = renderWithProviders(<WallManagement />);
    await userEvent.click(await screen.findByRole("button", { name: /backup wall/i }));
    expect(await screen.findByRole("heading", { name: "Backup wall" })).toBeInTheDocument();

    list.mockResolvedValue({ items: [MAIN, BACKUP], total: 2 } as never);
    await client.refetchQueries({ queryKey: ["walls"] });

    expect(await screen.findByRole("heading", { name: "Backup wall" })).toBeInTheDocument();
  });
});
