/**
 * VMS → Storage. A read-only lens on recorder-owned storage, so there is nothing
 * destructive to gate here — what matters is that it never LIES about the estate:
 * a federation call that failed must not render as "no recorder nodes enrolled
 * yet", which reads as an install problem rather than an outage. Selection is the
 * same derived `selectedId ?? filtered[0]` as its sibling consoles.
 */
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";

import StoragePage from "./Storage";
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

beforeEach(() => {
  vi.spyOn(vms.federation, "cameras").mockResolvedValue({ items: [], unreachable: [] } as never);
  vi.spyOn(vms.federation.storage, "usage").mockResolvedValue({} as never);
  vi.spyOn(vms.federation.storage, "pools").mockResolvedValue({ items: [] } as never);
  vi.spyOn(vms.federation.storage, "tierRules").mockResolvedValue({ items: [] } as never);
  vi.spyOn(vms.federation.storage, "raid").mockResolvedValue({ arrays: [] } as never);
});

const nodesReturn = (items: FederationNode[]) =>
  vi.spyOn(vms.federation, "nodes").mockResolvedValue({ items, total: items.length } as never);

describe("a failed load", () => {
  it("reports the failure instead of an estate with no recorders in it", async () => {
    vi.spyOn(vms.federation, "nodes").mockRejectedValue(new Error("federation is unreachable"));

    renderWithProviders(<StoragePage />);

    expect(await screen.findByText(/federation is unreachable/i)).toBeInTheDocument();
    expect(screen.queryByText(/no recorder nodes enrolled yet/i)).not.toBeInTheDocument();
  });

  it("says the estate is empty only when the call actually succeeded", async () => {
    nodesReturn([]);

    renderWithProviders(<StoragePage />);

    expect(await screen.findByText(/no recorder nodes enrolled yet/i)).toBeInTheDocument();
  });

  it("shows a per-section failure rather than pretending the recorder reports nothing", async () => {
    nodesReturn([NORTH]);
    vi.spyOn(vms.federation.storage, "pools").mockRejectedValue(new Error("pool read failed"));

    renderWithProviders(<StoragePage />);

    expect(await screen.findByText(/pool read failed/i)).toBeInTheDocument();
    expect(screen.queryByText(/reports no storage pools/i)).not.toBeInTheDocument();
  });
});

describe("which recorder's storage is shown", () => {
  it("shows the first recorder without the operator choosing anything", async () => {
    nodesReturn([NORTH, SOUTH]);

    renderWithProviders(<StoragePage />);

    expect(await screen.findByRole("heading", { name: /north-recorder/i })).toBeInTheDocument();
    expect(screen.queryByText(/no recorder selected/i)).not.toBeInTheDocument();
  });

  it("keeps the operator's choice when the list refetches", async () => {
    const nodes = nodesReturn([NORTH, SOUTH]);

    const { client } = renderWithProviders(<StoragePage />);
    await userEvent.click(await screen.findByRole("button", { name: /south-recorder/i }));
    expect(await screen.findByRole("heading", { name: /south-recorder/i })).toBeInTheDocument();

    nodes.mockResolvedValue({ items: [NORTH, SOUTH], total: 2 } as never);
    await client.refetchQueries({ queryKey: ["vms-storage-nodes"] });

    expect(await screen.findByRole("heading", { name: /south-recorder/i })).toBeInTheDocument();
  });

  it("follows the filter to the first match while nothing has been chosen", async () => {
    nodesReturn([NORTH, SOUTH]);

    renderWithProviders(<StoragePage />);
    expect(await screen.findByRole("heading", { name: /north-recorder/i })).toBeInTheDocument();

    await userEvent.type(screen.getByPlaceholderText(/search name, label or url/i), "annexe");

    expect(await screen.findByRole("heading", { name: /south-recorder/i })).toBeInTheDocument();
  });

  it("warns that the figures may be stale for a recorder that is offline", async () => {
    nodesReturn([fedNode("n3", "dark-recorder", { status: "offline" })]);

    renderWithProviders(<StoragePage />);

    expect(await screen.findByText(/not reachable right now/i)).toBeInTheDocument();
  });
});
