/**
 * VMS → NVR. Three properties that would be expensive to get wrong:
 *
 *   1. deleting an NVR is IRREVERSIBLE (its channel-cameras lose their link), so
 *      the API must not be touched until the operator confirms in the dialog
 *   2. a failed load must read as a failure — an estate that failed to load and
 *      an estate with no recorders in it look identical otherwise, and the second
 *      reading is the one that gets someone to "onboard" a device that exists
 *   3. selection is DERIVED (`selectedId ?? filtered[0]`), not synced in an
 *      effect: the first row shows with no clicking, an explicit choice survives
 *      the 20s refetch, and filtering away the chosen row falls back
 */
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { sites as sitesApi } from "@/lib/api/sites";
import type { NvrPublic } from "@/lib/types";
import { renderWithProviders } from "@/test/render";

import NvrPage from "./Nvr";
import { vms } from "./api";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

function nvr(id: string, name: string, host: string): NvrPublic {
  return {
    id,
    name,
    host,
    port: 80,
    brand: "hikvision",
    status: "online",
    channel_count: 8,
  } as NvrPublic;
}

const LOBBY = nvr("n1", "Lobby NVR", "10.0.0.11");
const DOCK = nvr("n2", "Loading Dock NVR", "10.0.0.12");

/** The detail pane's own queries — stubbed so only the page under test matters. */
function stubDetailQueries() {
  vi.spyOn(vms.nvrs, "health").mockResolvedValue({} as never);
  vi.spyOn(vms.nvrs, "channels").mockResolvedValue({ items: [] } as never);
  vi.spyOn(vms.cameras, "list").mockResolvedValue({ items: [], total: 0 } as never);
}

beforeEach(() => {
  vi.spyOn(sitesApi, "list").mockResolvedValue({ items: [], total: 0 } as never);
  stubDetailQueries();
});

function listReturns(items: NvrPublic[]) {
  return vi.spyOn(vms.nvrs, "list").mockResolvedValue({ items, total: items.length } as never);
}

describe("a failed load", () => {
  it("reports the failure instead of an empty estate", async () => {
    vi.spyOn(vms.nvrs, "list").mockRejectedValue(new Error("upstream is down"));

    renderWithProviders(<NvrPage />);

    expect(await screen.findByText(/upstream is down/i)).toBeInTheDocument();
    expect(screen.queryByText(/no nvrs yet/i)).not.toBeInTheDocument();
  });

  it("still says 'no NVRs yet' when the estate genuinely is empty", async () => {
    listReturns([]);

    renderWithProviders(<NvrPage />);

    expect(await screen.findByText(/no nvrs yet/i)).toBeInTheDocument();
  });
});

describe("deleting an NVR", () => {
  it("does not call the API until the operator confirms", async () => {
    listReturns([LOBBY]);
    const remove = vi.spyOn(vms.nvrs, "remove").mockResolvedValue(undefined as never);

    renderWithProviders(<NvrPage />);
    await userEvent.click(await screen.findByRole("button", { name: /^delete$/i }));

    // The dialog is up, and nothing has been deleted yet.
    expect(await screen.findByRole("heading", { name: /delete nvr/i })).toBeInTheDocument();
    expect(remove).not.toHaveBeenCalled();
  });

  it("warns that the mapped channel-cameras lose their link", async () => {
    listReturns([LOBBY]);
    vi.spyOn(vms.nvrs, "remove").mockResolvedValue(undefined as never);

    renderWithProviders(<NvrPage />);
    await userEvent.click(await screen.findByRole("button", { name: /^delete$/i }));

    expect(await screen.findByText(/cannot be undone/i)).toBeInTheDocument();
    expect(screen.getByText(/lose their nvr link/i)).toBeInTheDocument();
  });

  it("deletes only the NVR the dialog named, once confirmed", async () => {
    listReturns([LOBBY, DOCK]);
    const remove = vi.spyOn(vms.nvrs, "remove").mockResolvedValue(undefined as never);

    renderWithProviders(<NvrPage />);
    await userEvent.click(await screen.findByRole("button", { name: /loading dock nvr/i }));
    await userEvent.click(await screen.findByRole("button", { name: /^delete$/i }));
    // The confirm button inside the dialog footer.
    const dialogDelete = screen.getAllByRole("button", { name: /^delete$/i }).at(-1);
    await userEvent.click(dialogDelete!);

    await waitFor(() => expect(remove).toHaveBeenCalledWith("n2"));
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("abandons the delete when the operator cancels", async () => {
    listReturns([LOBBY]);
    const remove = vi.spyOn(vms.nvrs, "remove").mockResolvedValue(undefined as never);

    renderWithProviders(<NvrPage />);
    await userEvent.click(await screen.findByRole("button", { name: /^delete$/i }));
    await userEvent.click(await screen.findByRole("button", { name: /cancel/i }));

    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: /delete nvr/i })).not.toBeInTheDocument(),
    );
    expect(remove).not.toHaveBeenCalled();
  });
});

describe("which NVR is shown", () => {
  it("shows the first row without the operator choosing anything", async () => {
    listReturns([LOBBY, DOCK]);

    renderWithProviders(<NvrPage />);

    expect(await screen.findByRole("heading", { name: "Lobby NVR" })).toBeInTheDocument();
    expect(screen.queryByText(/select an nvr/i)).not.toBeInTheDocument();
  });

  it("keeps the operator's choice when the list refetches", async () => {
    const list = listReturns([LOBBY, DOCK]);

    const { client } = renderWithProviders(<NvrPage />);
    await userEvent.click(await screen.findByRole("button", { name: /loading dock nvr/i }));
    expect(await screen.findByRole("heading", { name: "Loading Dock NVR" })).toBeInTheDocument();

    // A refetch returning the same rows must not drag selection back to row one.
    list.mockResolvedValue({ items: [LOBBY, DOCK], total: 2 } as never);
    await client.refetchQueries({ queryKey: ["vms-nvrs"] });

    expect(await screen.findByRole("heading", { name: "Loading Dock NVR" })).toBeInTheDocument();
  });

  it("follows the filter to the first match while nothing has been chosen", async () => {
    listReturns([LOBBY, DOCK]);

    renderWithProviders(<NvrPage />);
    expect(await screen.findByRole("heading", { name: "Lobby NVR" })).toBeInTheDocument();

    // No explicit choice was ever made, so the derived selection tracks the
    // filtered list rather than pinning to a row that is no longer displayed.
    await userEvent.type(screen.getByPlaceholderText(/search name or host/i), "Dock");

    expect(await screen.findByRole("heading", { name: "Loading Dock NVR" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Lobby NVR" })).not.toBeInTheDocument();
  });

  it("shows the empty detail pane when the estate has nothing to select", async () => {
    listReturns([]);

    renderWithProviders(<NvrPage />);

    expect(await screen.findByText(/select an nvr/i)).toBeInTheDocument();
  });
});
