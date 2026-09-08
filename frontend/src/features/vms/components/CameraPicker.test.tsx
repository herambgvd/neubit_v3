/**
 * Picking cameras out of a real estate.
 *
 * A flat checkbox grid works for four cameras and fails for four hundred:
 * "Channel 1" exists on every recorder, so the list reads as duplicates with
 * nothing to tell them apart. The estate's shape is recorder → cameras, and the
 * picker has to show that AND let one search cut through both levels.
 *
 * The failures worth pinning are the quiet ones: a match hidden inside a
 * collapsed group (reads as "no results"), a group header that survives its last
 * camera being filtered out, and a select-all that silently duplicates ids
 * already chosen.
 */
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";

import CameraPicker from "./CameraPicker";

const cam = (id: string, name: string, node?: [string, string]) => ({
  id,
  name,
  status: "online",
  ...(node ? { node_id: node[0], node_name: node[1] } : {}),
});

const CAMERAS = [
  cam("a1", "Channel 1", ["n1", "rec-north"]),
  cam("a2", "Lobby door", ["n1", "rec-north"]),
  cam("b1", "Channel 1", ["n2", "rec-south"]),
  cam("l1", "Old local cam"),
];

function picker(over: Partial<React.ComponentProps<typeof CameraPicker>> = {}) {
  const props = {
    cameras: CAMERAS,
    selected: [] as string[],
    onToggle: vi.fn(),
    onToggleMany: vi.fn(),
    ...over,
  };
  renderWithProviders(<CameraPicker {...props} />);
  return props;
}

/** The cameras rendered under one recorder's header. */
function group(name: string) {
  return screen.getByRole("button", { name: new RegExp(`${name} cameras`, "i") }).parentElement!
    .parentElement!;
}

describe("the estate's shape", () => {
  it("groups cameras under the recorder that owns them", async () => {
    picker();

    expect(within(group("rec-north")).getByText("Lobby door")).toBeInTheDocument();
    // Two cameras named "Channel 1" on two recorders — the only thing that tells
    // them apart is which group they sit in.
    expect(within(group("rec-north")).getByText("Channel 1")).toBeInTheDocument();
    expect(within(group("rec-south")).getByText("Channel 1")).toBeInTheDocument();
  });

  it("keeps VMS-owned rows in their own group, last", async () => {
    picker();

    const headers = screen
      .getAllByRole("button", { name: /cameras$/i })
      .map((b) => b.textContent || "");
    expect(headers.at(-1)).toContain("This VMS");
    expect(within(group("This VMS")).getByText("Old local cam")).toBeInTheDocument();
  });

  it("counts what is chosen per recorder", async () => {
    picker({ selected: ["a1"] });

    expect(screen.getByRole("button", { name: /rec-north cameras/i }).textContent).toContain("1/2");
    expect(screen.getByRole("button", { name: /rec-south cameras/i }).textContent).toContain("0/1");
  });
});

describe("search", () => {
  it("finds a camera and drops the groups with no match left", async () => {
    picker();
    await userEvent.type(screen.getByLabelText(/search recorder or camera/i), "lobby");

    expect(screen.getByText("Lobby door")).toBeInTheDocument();
    // An empty "rec-south" header with nothing under it is worse than no header.
    expect(screen.queryByRole("button", { name: /rec-south cameras/i })).toBeNull();
  });

  it("keeps a whole recorder when the recorder itself matches", async () => {
    // "Show me everything on rec-south" is the other half of what the box is for.
    picker();
    await userEvent.type(screen.getByLabelText(/search recorder or camera/i), "rec-south");

    expect(within(group("rec-south")).getByText("Channel 1")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /rec-north cameras/i })).toBeNull();
  });

  it("re-opens a collapsed group that a search matched", async () => {
    // A hit inside a shut section reads as no hit at all.
    picker();
    await userEvent.click(screen.getByRole("button", { name: /rec-north cameras/i }));
    expect(screen.queryByText("Lobby door")).toBeNull();

    await userEvent.type(screen.getByLabelText(/search recorder or camera/i), "lobby");
    expect(screen.getByText("Lobby door")).toBeInTheDocument();
  });

  it("says nothing matched rather than showing an empty box", async () => {
    picker();
    await userEvent.type(screen.getByLabelText(/search recorder or camera/i), "zzz");

    expect(screen.getByText(/no camera matches that/i)).toBeInTheDocument();
  });
});

describe("choosing", () => {
  it("toggles one camera by id", async () => {
    const p = picker();
    await userEvent.click(within(group("rec-north")).getByText("Lobby door"));
    expect(p.onToggle).toHaveBeenCalledWith("a2");
  });

  it("selects a whole recorder in one click", async () => {
    const p = picker({ selected: ["a1"] });
    const north = screen.getByRole("button", { name: /rec-north cameras/i }).parentElement!;

    await userEvent.click(within(north).getByRole("button", { name: "All" }));
    // Both ids, including the one already chosen — the caller de-dupes, and a
    // partial group must not be left half-selected.
    expect(p.onToggleMany).toHaveBeenCalledWith(["a1", "a2"], true);
  });

  it("offers to CLEAR a recorder that is already fully chosen", async () => {
    const p = picker({ selected: ["b1"] });
    const south = screen.getByRole("button", { name: /rec-south cameras/i }).parentElement!;

    await userEvent.click(within(south).getByRole("button", { name: "None" }));
    expect(p.onToggleMany).toHaveBeenCalledWith(["b1"], false);
  });

  it("reports how many are chosen across the whole estate", async () => {
    picker({ selected: ["a1", "b1"] });
    expect(screen.getByText("2 selected")).toBeInTheDocument();
  });
});

describe("nothing to pick", () => {
  it("passes the caller's wording through — an outage is not an empty estate", async () => {
    picker({ cameras: [], empty: "Cameras could not be listed — a recorder is not answering." });
    expect(screen.getByText(/a recorder is not answering/i)).toBeInTheDocument();
  });

  it("says it is still loading rather than that there is nothing", async () => {
    picker({ cameras: [], loading: true });
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });
});
