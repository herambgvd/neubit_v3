/**
 * VMS → Federation. The membership lens: which enrolled recorder nodes are
 * reachable and what each one exposes. It is read-only, so the properties worth
 * pinning are honesty ones:
 *
 *   1. a failed nodes call must not read as "no recorder nodes enrolled yet"
 *   2. a node the cameras call could not reach is reported unreachable and its
 *      camera list is NOT rendered as "this node exposes no cameras" — the
 *      difference between an outage and a decommissioned site
 */
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";

import FederationPage from "./Federation";
import { vms } from "./api";
import type { FederationNode } from "./types";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

function fedNode(id: string, name: string, over: Partial<FederationNode> = {}): FederationNode {
  return {
    id,
    name,
    api_url: `https://${id}.local`,
    label: null,
    status: "online",
    ...over,
  } as FederationNode;
}

const NORTH = fedNode("n1", "north-recorder");
const SOUTH = fedNode("n2", "south-recorder", { label: "annexe" });

const camera = (id: string, nodeId: string, status = "online") => ({
  id,
  name: `cam ${id}`,
  status,
  node_id: nodeId,
  node_name: nodeId,
});

beforeEach(() => {
  vi.spyOn(vms.federation, "cameras").mockResolvedValue({ items: [], unreachable: [] } as never);
  // The per-node reads the detail pane makes. Off by default so a test that is
  // about something else does not have to describe a recorder's disks.
  vi.spyOn(vms.federation.storage, "usage").mockRejectedValue(new Error("no storage"));
  vi.spyOn(vms.federation.storage, "raid").mockRejectedValue(new Error("no raid"));
  vi.spyOn(vms.federation, "nvrs").mockResolvedValue({ items: [] } as never);
});

const nodesReturn = (items: FederationNode[]) =>
  vi.spyOn(vms.federation, "nodes").mockResolvedValue({ items, total: items.length } as never);

describe("a failed load", () => {
  it("reports the failure instead of an unenrolled estate", async () => {
    vi.spyOn(vms.federation, "nodes").mockRejectedValue(new Error("federation is unreachable"));

    renderWithProviders(<FederationPage />);

    expect(await screen.findByText(/federation is unreachable/i)).toBeInTheDocument();
    expect(screen.queryByText(/no recorder nodes enrolled yet/i)).not.toBeInTheDocument();
  });

  it("says nothing is enrolled only when the call actually succeeded", async () => {
    nodesReturn([]);

    renderWithProviders(<FederationPage />);

    expect(await screen.findByText(/no recorder nodes enrolled yet/i)).toBeInTheDocument();
  });
});

describe("reachability", () => {
  it("marks a node the camera aggregation could not reach, rather than showing it as camera-less", async () => {
    nodesReturn([NORTH]);
    vi.spyOn(vms.federation, "cameras").mockResolvedValue({
      items: [],
      unreachable: [{ node_id: "n1", error: "timeout" }],
    } as never);

    renderWithProviders(<FederationPage />);

    expect(await screen.findByText(/unreachable — cameras hidden/i)).toBeInTheDocument();
    expect(
      await screen.findByText(/cameras are unavailable while this node is unreachable/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/exposes no federated cameras/i)).not.toBeInTheDocument();
  });

  it("counts a node as reachable only when it is both online and answering", async () => {
    nodesReturn([NORTH, SOUTH]);
    vi.spyOn(vms.federation, "cameras").mockResolvedValue({
      items: [camera("c1", "n1")],
      unreachable: [{ node_id: "n2", error: "timeout" }],
    } as never);

    renderWithProviders(<FederationPage />);

    // n1 is online AND answered; n2 is online but the aggregation could not reach it.
    await waitFor(() => expect(screen.getByTitle("reachable")).toHaveTextContent("1"));
    expect(screen.getByTitle("unreachable")).toHaveTextContent("1");
  });

  it("attributes each camera to the node that owns it", async () => {
    nodesReturn([NORTH, SOUTH]);
    vi.spyOn(vms.federation, "cameras").mockResolvedValue({
      items: [camera("c1", "n1"), camera("c2", "n1", "offline"), camera("c3", "n2")],
      unreachable: [],
    } as never);

    renderWithProviders(<FederationPage />);

    // The detail pane opens on the first node, which owns two of the three.
    expect(await screen.findByText("1/2 online")).toBeInTheDocument();
  });
});

describe("which node is shown", () => {
  it("shows the first node without the operator choosing anything", async () => {
    nodesReturn([NORTH, SOUTH]);

    renderWithProviders(<FederationPage />);

    expect(await screen.findByRole("heading", { name: /north-recorder/i })).toBeInTheDocument();
    expect(screen.queryByText(/no node selected/i)).not.toBeInTheDocument();
  });

  it("keeps the operator's choice when the list refetches", async () => {
    const nodes = nodesReturn([NORTH, SOUTH]);

    const { client } = renderWithProviders(<FederationPage />);
    await userEvent.click(await screen.findByRole("button", { name: /south-recorder/i }));
    expect(await screen.findByRole("heading", { name: /south-recorder/i })).toBeInTheDocument();

    nodes.mockResolvedValue({ items: [NORTH, SOUTH], total: 2 } as never);
    await client.refetchQueries({ queryKey: ["vms-federation-nodes"] });

    expect(await screen.findByRole("heading", { name: /south-recorder/i })).toBeInTheDocument();
  });

  it("follows the filter to the first match while nothing has been chosen", async () => {
    nodesReturn([NORTH, SOUTH]);

    renderWithProviders(<FederationPage />);
    expect(await screen.findByRole("heading", { name: /north-recorder/i })).toBeInTheDocument();

    await userEvent.type(screen.getByPlaceholderText(/search name, label or url/i), "annexe");

    expect(await screen.findByRole("heading", { name: /south-recorder/i })).toBeInTheDocument();
  });
});

describe("trust", () => {
  it("says a node is refusing our credential, even though it is online", async () => {
    // The whole point of the field: the node is REACHABLE and reports online, so
    // every other signal on this screen says the federation is healthy while part
    // of its surface is closed.
    nodesReturn([
      fedNode("n1", "north-recorder", {
        has_credential: true,
        credential_error: "403 from recorder: missing grant storage:read",
      }),
    ]);

    renderWithProviders(<FederationPage />);

    expect(await screen.findByText(/credential is being refused/i)).toBeInTheDocument();
    expect(screen.getByText(/missing grant storage:read/)).toBeInTheDocument();
    // And it is countable from the estate strip without opening each node.
    expect(screen.getByTitle(/refusing our federation credential/i)).toHaveTextContent("1");
  });

  it("distinguishes a node-scoped credential from the shared service token", async () => {
    nodesReturn([
      fedNode("n1", "scoped", { has_credential: true }),
      fedNode("n2", "shared", { has_credential: false }),
    ]);

    renderWithProviders(<FederationPage />);
    expect(await screen.findByText(/scoped to this node/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /shared/i }));
    // Not an error — the ambient token still works. It is the difference between
    // access we can revoke on its own and access we cannot.
    expect(await screen.findByText(/shared service token/i)).toBeInTheDocument();
    expect(screen.queryByText(/credential is being refused/i)).not.toBeInTheDocument();
  });
});

describe("endpoints", () => {
  it("warns when an online node has no media base to stream from", async () => {
    // It answers its API, so it reports online — and a tile opened on its cameras
    // has nowhere to go. That used to show up as a black tile and nothing else.
    nodesReturn([fedNode("n1", "north-recorder", { hls_base: null, webrtc_base: null })]);

    renderWithProviders(<FederationPage />);

    expect(await screen.findByText(/no playable media base/i)).toBeInTheDocument();
  });

  it("keeps quiet, and lists no URLs, when the node can actually stream", async () => {
    // The endpoint URLs belong to the Recorders page, which is where they are
    // edited. Printing them here is four rows nobody acts on.
    nodesReturn([
      fedNode("n1", "north-recorder", {
        hls_base: "http://north:8888",
        webrtc_base: "http://north:8889",
      }),
    ]);

    renderWithProviders(<FederationPage />);
    await screen.findByRole("heading", { name: /north-recorder/i });

    expect(screen.queryByText(/no playable media base/i)).not.toBeInTheDocument();
    expect(screen.queryByText("http://north:8888")).not.toBeInTheDocument();
  });
});

describe("recorder storage", () => {
  it("reads the selected node's disks through the node", async () => {
    nodesReturn([NORTH]);
    vi.spyOn(vms.federation.storage, "usage").mockResolvedValue({
      total_bytes: 4_000_000_000_000,
      used_bytes: 3_600_000_000_000,
      free_bytes: 400_000_000_000,
      used_percent: 90,
    } as never);

    renderWithProviders(<FederationPage />);

    expect(await screen.findByText(/90% used/i)).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: /recorder disk usage/i })).toHaveAttribute(
      "aria-valuenow",
      "90",
    );
  });

  it("does not ask an unreachable node for its disks", async () => {
    // Polling storage on a node that is not answering buys a timeout per tick.
    nodesReturn([NORTH]);
    const usage = vi.spyOn(vms.federation.storage, "usage");
    vi.spyOn(vms.federation, "cameras").mockResolvedValue({
      items: [],
      unreachable: [{ node_id: "n1", error: "timeout" }],
    } as never);

    renderWithProviders(<FederationPage />);
    await screen.findByText(/unavailable while the node is unreachable/i);

    expect(usage).not.toHaveBeenCalled();
  });

  it("says the node did not answer rather than showing an empty disk", async () => {
    nodesReturn([NORTH]);
    vi.spyOn(vms.federation.storage, "usage").mockRejectedValue(new Error("node refused"));

    renderWithProviders(<FederationPage />);

    expect(await screen.findByText(/node refused/i)).toBeInTheDocument();
    expect(screen.queryByText(/0% used/i)).not.toBeInTheDocument();
  });
});

describe("the estate strip", () => {
  it("adds the estate up so nobody has to open each node", async () => {
    nodesReturn([
      fedNode("n1", "north", { used_channels: 12, capacity_channels: 64 }),
      fedNode("n2", "south", { used_channels: 4, capacity_channels: 16, status: "offline" }),
    ]);
    vi.spyOn(vms.federation, "cameras").mockResolvedValue({
      items: [camera("c1", "n1"), camera("c2", "n1", "offline")],
      unreachable: [],
    } as never);

    renderWithProviders(<FederationPage />);

    await waitFor(() =>
      expect(screen.getByTitle(/online and answering/i)).toHaveTextContent("1/2"),
    );
    expect(screen.getByTitle(/that are streaming/i)).toHaveTextContent("1/2");
    expect(screen.getByTitle(/recording channels in use/i)).toHaveTextContent("16/80");
  });
});
