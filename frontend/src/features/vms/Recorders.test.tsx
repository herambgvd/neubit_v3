/**
 * VMS → Recorders. The MediaNode registry, where every mutation is expensive:
 * draining stops new recordings landing, deleting removes the box cameras are
 * pinned to, and revoking a federation credential cuts the VMS off from the
 * recorder's cameras with no way back. All three must ask first, and a failed
 * load must never read as "no recorders yet — click Add".
 */
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";

import RecordersPage from "./Recorders";
import { vms } from "./api";
import type { MediaNodePublic } from "./types";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ can: () => true }) }));

function node(id: string, name: string, over: Partial<MediaNodePublic> = {}): MediaNodePublic {
  return {
    id,
    name,
    api_url: `https://${id}.local`,
    label: null,
    status: "online",
    capacity_channels: 32,
    used_channels: 4,
    has_credential: false,
    ...over,
  } as MediaNodePublic;
}

const EDGE1 = node("r1", "edge-one");
const EDGE2 = node("r2", "edge-two", { label: "warehouse" });

beforeEach(() => {
  vi.spyOn(vms.cameras, "list").mockResolvedValue({ items: [], total: 0 } as never);
  vi.spyOn(vms.mediaNodes, "credentials").mockResolvedValue({ items: [] } as never);
});

function listReturns(items: MediaNodePublic[]) {
  return vi
    .spyOn(vms.mediaNodes, "list")
    .mockResolvedValue({ items, total: items.length } as never);
}

describe("a failed load", () => {
  it("reports the failure instead of an empty registry", async () => {
    vi.spyOn(vms.mediaNodes, "list").mockRejectedValue(new Error("recorder registry unreachable"));

    renderWithProviders(<RecordersPage />);

    expect(await screen.findByText(/recorder registry unreachable/i)).toBeInTheDocument();
    expect(screen.queryByText(/no recorders yet/i)).not.toBeInTheDocument();
  });

  it("still invites an Add when the registry genuinely is empty", async () => {
    listReturns([]);

    renderWithProviders(<RecordersPage />);

    expect(await screen.findByText(/no recorders yet/i)).toBeInTheDocument();
  });
});

describe("destructive recorder actions", () => {
  it("deletes nothing until the operator confirms", async () => {
    listReturns([EDGE1]);
    const remove = vi.spyOn(vms.mediaNodes, "remove").mockResolvedValue(undefined as never);

    renderWithProviders(<RecordersPage />);
    await userEvent.click(await screen.findByRole("button", { name: /^delete$/i }));

    expect(await screen.findByRole("heading", { name: /delete recorder/i })).toBeInTheDocument();
    expect(remove).not.toHaveBeenCalled();
  });

  it("deletes the recorder once the operator confirms", async () => {
    listReturns([EDGE1]);
    const remove = vi.spyOn(vms.mediaNodes, "remove").mockResolvedValue(undefined as never);

    renderWithProviders(<RecordersPage />);
    await userEvent.click(await screen.findByRole("button", { name: /^delete$/i }));
    await userEvent.click(screen.getAllByRole("button", { name: /^delete$/i }).at(-1)!);

    await waitFor(() => expect(remove).toHaveBeenCalledWith("r1"));
  });

  it("changes no recorder status until a drain is confirmed", async () => {
    listReturns([EDGE1]);
    const update = vi.spyOn(vms.mediaNodes, "update").mockResolvedValue(EDGE1 as never);

    renderWithProviders(<RecordersPage />);
    await userEvent.click(await screen.findByRole("button", { name: /^drain$/i }));

    expect(await screen.findByRole("heading", { name: /drain recorder/i })).toBeInTheDocument();
    expect(update).not.toHaveBeenCalled();

    await userEvent.click(screen.getAllByRole("button", { name: /^drain$/i }).at(-1)!);
    await waitFor(() => expect(update).toHaveBeenCalledWith("r1", { status: "draining" }));
  });

  it("leaves everything alone when the operator cancels", async () => {
    listReturns([EDGE1]);
    const remove = vi.spyOn(vms.mediaNodes, "remove").mockResolvedValue(undefined as never);

    renderWithProviders(<RecordersPage />);
    await userEvent.click(await screen.findByRole("button", { name: /^delete$/i }));
    await userEvent.click(await screen.findByRole("button", { name: /cancel/i }));

    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: /delete recorder/i })).not.toBeInTheDocument(),
    );
    expect(remove).not.toHaveBeenCalled();
  });
});

describe("revoking a federation credential", () => {
  beforeEach(() => {
    vi.spyOn(vms.mediaNodes, "credentials").mockResolvedValue({
      items: [
        {
          id: "c1",
          label: "vms-key",
          grants: ["cameras.read"],
          created_at: "2026-01-01T00:00:00Z",
          last_used_at: null,
          revoked_at: null,
        },
      ],
    } as never);
  });

  it("does not revoke until the operator confirms — the recorder cannot be un-cut-off", async () => {
    listReturns([EDGE1]);
    const revoke = vi
      .spyOn(vms.mediaNodes, "revokeCredential")
      .mockResolvedValue(undefined as never);

    renderWithProviders(<RecordersPage />);
    await userEvent.click(await screen.findByRole("button", { name: /^revoke$/i }));

    expect(await screen.findByRole("heading", { name: /revoke credential/i })).toBeInTheDocument();
    expect(revoke).not.toHaveBeenCalled();
  });

  it("revokes the named credential once confirmed", async () => {
    listReturns([EDGE1]);
    const revoke = vi
      .spyOn(vms.mediaNodes, "revokeCredential")
      .mockResolvedValue(undefined as never);

    renderWithProviders(<RecordersPage />);
    await userEvent.click(await screen.findByRole("button", { name: /^revoke$/i }));
    await userEvent.click(screen.getAllByRole("button", { name: /^revoke$/i }).at(-1)!);

    await waitFor(() => expect(revoke).toHaveBeenCalledWith("r1", "c1"));
  });
});

describe("which recorder is shown", () => {
  it("shows the first row without the operator choosing anything", async () => {
    listReturns([EDGE1, EDGE2]);

    renderWithProviders(<RecordersPage />);

    expect(await screen.findByRole("heading", { name: "edge-one" })).toBeInTheDocument();
    expect(screen.queryByText(/no recorder selected/i)).not.toBeInTheDocument();
  });

  it("keeps the operator's choice when the list refetches", async () => {
    const list = listReturns([EDGE1, EDGE2]);

    const { client } = renderWithProviders(<RecordersPage />);
    const rail = await screen.findByRole("button", { name: /edge-two/i });
    await userEvent.click(rail);
    expect(await screen.findByRole("heading", { name: "edge-two" })).toBeInTheDocument();

    list.mockResolvedValue({ items: [EDGE1, EDGE2], total: 2 } as never);
    await client.refetchQueries({ queryKey: ["vms-media-nodes"] });

    expect(await screen.findByRole("heading", { name: "edge-two" })).toBeInTheDocument();
  });

  it("follows the filter to the first match while nothing has been chosen", async () => {
    listReturns([EDGE1, EDGE2]);

    renderWithProviders(<RecordersPage />);
    expect(await screen.findByRole("heading", { name: "edge-one" })).toBeInTheDocument();

    await userEvent.type(screen.getByPlaceholderText(/search name, label or url/i), "warehouse");

    expect(await screen.findByRole("heading", { name: "edge-two" })).toBeInTheDocument();
  });

  it("offers no drain control for a recorder that is already draining", async () => {
    listReturns([node("r3", "edge-draining", { status: "draining" })]);

    renderWithProviders(<RecordersPage />);
    await screen.findByRole("heading", { name: "edge-draining" });

    expect(screen.queryByRole("button", { name: /^drain$/i })).toBeNull();
    // The irreversible one is still offered.
    expect(screen.getByRole("button", { name: /^delete$/i })).toBeInTheDocument();
  });
});
