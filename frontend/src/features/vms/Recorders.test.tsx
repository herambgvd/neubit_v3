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
  // The recorder OWNS its cameras, so this — not the local camera list — is
  // where the detail pane's camera list comes from.
  vi.spyOn(vms.federation, "cameras").mockResolvedValue({
    items: [],
    total: 0,
    nodes: 0,
    unreachable: [],
  } as never);
});

const fedCam = (id: string, nodeId: string, status = "online") => ({
  id,
  name: `channel ${id}`,
  status,
  node_id: nodeId,
  node_name: nodeId,
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

  it("shows the credential and its dates, but not its grant list", async () => {
    // Fifteen chips of `vms.camera.read`-style keys is not something an operator
    // acts on here; when a grant is actually missing the recorder refuses and
    // Federation reports the refusal.
    listReturns([EDGE1]);

    renderWithProviders(<RecordersPage />);
    await screen.findByRole("button", { name: /^revoke$/i });

    expect(screen.getByText("vms-key")).toBeInTheDocument();
    expect(screen.queryByText("cameras.read")).toBeNull();
    // And the paragraph explaining what a credential is has gone with it — the
    // Enrolled badge and the two buttons already say the state and the actions.
    expect(screen.queryByText(/lets the VMS read this recorder/i)).toBeNull();
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

describe("a recorder that is online but refusing our credential", () => {
  // The failure `status` cannot express. A federation credential keeps the grants it
  // was minted with, so widening the recorder's grant set leaves an existing one
  // short — and the node stays reachable and reports online the whole time. An
  // operator scanning this list would see a perfectly healthy recorder while a
  // screen somewhere quietly errors, and nothing would connect the two.
  const STALE =
    "the recorder refused this call: the federation credential is missing " +
    "vms.storage.read. ... re-enrol this node";

  it("marks it in the list, where status alone says everything is fine", async () => {
    listReturns([node("r1", "edge-one", { credential_error: STALE })]);

    renderWithProviders(<RecordersPage />);

    expect(await screen.findByText(/credential needs re-enrolling/i)).toBeInTheDocument();
    // The node is NOT down, and must not be shown as if it were.
    expect(screen.getAllByText(/online/i).length).toBeGreaterThan(0);
  });

  it("shows the recorder's own sentence, which names the permission and the remedy", async () => {
    listReturns([node("r1", "edge-one", { credential_error: STALE })]);

    renderWithProviders(<RecordersPage />);

    expect(await screen.findByText(/refusing our credential/i)).toBeInTheDocument();
    // Paraphrasing it here would lose the two things it is for.
    expect(screen.getByText(/vms\.storage\.read/)).toBeInTheDocument();
    expect(screen.getByText(/re-enrol this node/i)).toBeInTheDocument();
  });

  it("says nothing when the credential is working", async () => {
    listReturns([node("r1", "edge-one")]);

    renderWithProviders(<RecordersPage />);
    await screen.findAllByText("edge-one");

    expect(screen.queryByText(/credential needs re-enrolling/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/refusing our credential/i)).not.toBeInTheDocument();
  });
});

describe("the cameras a recorder runs", () => {
  it("lists the recorder's OWN cameras, not just the rows the VMS pinned to it", async () => {
    // A single-ownership estate — the normal one — has no VMS-owned camera rows
    // at all. This pane filtered on exactly those, so a recorder running three
    // cameras read "0 / 32, no cameras pinned yet" while Federation, one click
    // away, listed all three. Same box, two numbers, and this one was wrong.
    listReturns([EDGE1]);
    vi.spyOn(vms.federation, "cameras").mockResolvedValue({
      items: [fedCam("c1", "r1"), fedCam("c2", "r1", "offline"), fedCam("c9", "r2")],
      unreachable: [],
    } as never);

    renderWithProviders(<RecordersPage />);

    expect(await screen.findByText("channel c1")).toBeInTheDocument();
    expect(screen.getByText("channel c2")).toBeInTheDocument();
    // Another recorder's camera does not appear under this one.
    expect(screen.queryByText("channel c9")).toBeNull();
    expect(screen.queryByText(/runs no cameras yet/i)).toBeNull();
  });

  it("counts capacity from what the recorder actually runs", async () => {
    // The capacity meter read 0/32 beside a Federation page saying 3/32.
    listReturns([EDGE1]);
    vi.spyOn(vms.federation, "cameras").mockResolvedValue({
      items: [fedCam("c1", "r1"), fedCam("c2", "r1")],
      unreachable: [],
    } as never);

    renderWithProviders(<RecordersPage />);
    await screen.findByText("channel c1");

    // The capacity cell, not the list badge that also reads "2".
    const capacity = screen.getByText(/^Capacity$/i).closest("div")!;
    expect(capacity.textContent).toContain("2");
    expect(capacity.textContent).toContain("/ 32");
  });

  it("says an unreachable recorder cannot be listed, rather than that it runs none", async () => {
    listReturns([EDGE1]);
    vi.spyOn(vms.federation, "cameras").mockResolvedValue({
      items: [],
      unreachable: [{ node_id: "r1", name: "edge-one", error: "timeout" }],
    } as never);

    renderWithProviders(<RecordersPage />);

    expect(await screen.findByText(/not answering, so its cameras cannot be listed/i)).toBeInTheDocument();
    expect(screen.queryByText(/runs no cameras yet/i)).toBeNull();
  });

  it("still shows a locally pinned camera, for estates that predate single ownership", async () => {
    listReturns([EDGE1]);
    vi.spyOn(vms.cameras, "list").mockResolvedValue({
      items: [{ id: "local-1", name: "lobby-cam", status: "online", media_node_id: "r1" }],
      total: 1,
    } as never);

    renderWithProviders(<RecordersPage />);

    expect(await screen.findByText("lobby-cam")).toBeInTheDocument();
  });

  it("does not print the recorder's endpoint URLs", async () => {
    // They are set in Edit and read nowhere else here.
    listReturns([EDGE1]);

    renderWithProviders(<RecordersPage />);
    await screen.findAllByText("edge-one");

    expect(screen.queryByText(/hls base/i)).toBeNull();
    expect(screen.queryByText(/rtsp base/i)).toBeNull();
  });
});
