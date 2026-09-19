/**
 * UNPLACED DEVICES — gate 3's worklist. A device's building is an operator's
 * assertion, so every property below is that rule made checkable:
 *
 *   • the list is the reading store's `placement=unplaced`, and nothing else;
 *   • the request names EXACTLY the ticked devices and the building picked —
 *     never a building nobody picked, even when there is only one;
 *   • the whole list being asserted is on screen before the button that sends it;
 *   • a floor is optional and a pin is never asked for;
 *   • every device's outcome renders, `pin_cleared` included;
 *   • a viewer without `devices.create` gets the list and no write control;
 *   • a success makes the gate strip's reads stale.
 */
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { sites } from "@/lib/api/sites";
import { renderWithProviders } from "@/test/render";

import Placement from "./Placement";
import { bi } from "./api";

const perms = { can: (_p: string) => true };
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ can: (p: string) => perms.can(p), hasModule: () => true }),
}));

const query: Record<string, string> = {};
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(query) }));

const row = (id: string | null, tag: string, over: Record<string, unknown> = {}) => ({
  device_id: id,
  device_tag: tag,
  category: "energy",
  device_type: "meter",
  points: 12,
  numeric_points: 12,
  text_points: 0,
  points_reporting: 12,
  first_seen_at: null,
  last_seen_at: null,
  site_id: null,
  site_name: null,
  ...over,
});

const unplaced = {
  total: 4,
  items: [row("d1", "1F-DB"), row("d2", "2F-DB"), row("d3", "3F-DB"), row(null, "Orphan-Meter")],
};
const placed = {
  total: 1,
  items: [row("d9", "Chiller-1", { category: "hvac", site_id: "old", site_name: "Old Block" })],
};

function wire() {
  vi.spyOn(bi, "devices").mockImplementation(async ({ placement }: any = {}) =>
    placement === "placed" ? placed : unplaced,
  );
  // ONE site. The shortcut this screen refuses is exactly "there is only one".
  vi.spyOn(sites, "list").mockResolvedValue({
    items: [{ site_id: "aeon", name: "Aeon Tower" }],
    total: 1,
    skip: 0,
    limit: 500,
  } as any);
  vi.spyOn(sites.floors, "list").mockResolvedValue({
    items: [{ floor_id: "f4", site_id: "aeon", name: "Level 4" }],
    total: 1,
    skip: 0,
    limit: 100,
  } as any);
  return vi.spyOn(sites.devicePlacements, "assign").mockResolvedValue({
    site_id: "aeon",
    site_name: "Aeon Tower",
    assigned: 2,
    items: [
      { device_id: "d1", placement_id: "p1", site_id: "aeon", floor_id: null, created: true, pin_cleared: false },
      { device_id: "d3", placement_id: "p3", site_id: "aeon", floor_id: null, created: true, pin_cleared: false },
    ],
  });
}

async function pickBuilding() {
  await userEvent.click(screen.getByRole("button", { name: "Building" }));
  await userEvent.click(await screen.findByRole("option", { name: "Aeon Tower" }));
}

beforeEach(() => {
  perms.can = () => true;
  for (const k of Object.keys(query)) delete query[k];
});

describe("the list", () => {
  it("is the reading store's unplaced devices", async () => {
    wire();
    renderWithProviders(<Placement />);
    expect(await screen.findByText("1F-DB")).toBeInTheDocument();
    expect(bi.devices).toHaveBeenCalledWith({ placement: "unplaced", category: undefined, limit: 500 });
    // The segment counts are the servers' totals, never a local tally.
    expect(screen.getByRole("button", { name: "NO BUILDING 4" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "IN A BUILDING 1" })).toBeInTheDocument();
  });

  it("is scoped to the category a domain strip sent", async () => {
    query.category = "energy";
    wire();
    renderWithProviders(<Placement />);
    await screen.findByText("1F-DB");
    expect(bi.devices).toHaveBeenCalledWith({ placement: "unplaced", category: "energy", limit: 500 });
  });

  it("lists a device with no id but will not let it be ticked", async () => {
    wire();
    renderWithProviders(<Placement />);
    expect(await screen.findByRole("checkbox", { name: "Orphan-Meter" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "1F-DB" })).toBeEnabled();
  });

  it("ticks nothing on anyone's behalf", async () => {
    wire();
    renderWithProviders(<Placement />);
    await screen.findByText("1F-DB");
    for (const box of screen.getAllByRole("checkbox")) expect(box).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Tick devices to assign" })).toBeDisabled();
  });

  it("lets a tick be taken back", async () => {
    wire();
    renderWithProviders(<Placement />);
    const box = await screen.findByRole("checkbox", { name: "1F-DB" });
    await userEvent.click(box);
    expect(screen.getByRole("button", { name: "Assign 1 to a building…" })).toBeEnabled();
    await userEvent.click(box);
    expect(box).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Tick devices to assign" })).toBeDisabled();
  });
});

describe("assigning", () => {
  it("sends exactly the ticked devices and the named building, after listing them", async () => {
    const assign = wire();
    renderWithProviders(<Placement />);
    await userEvent.click(await screen.findByRole("checkbox", { name: "1F-DB" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "3F-DB" }));
    await userEvent.click(screen.getByRole("button", { name: "Assign 2 to a building…" }));

    // The assertion, in full, before the button that sends it.
    const list = screen.getByRole("list", { name: "Devices to assign" });
    expect(within(list).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      expect.stringContaining("1F-DB"),
      expect.stringContaining("3F-DB"),
    ]);

    await pickBuilding();
    await userEvent.click(screen.getByRole("button", { name: "Assign 2 devices to Aeon Tower" }));

    await waitFor(() => expect(assign).toHaveBeenCalledTimes(1));
    expect(assign).toHaveBeenCalledWith({
      site_id: "aeon",
      device_type: "sensor",
      service: "iot",
      devices: [{ device_id: "d1" }, { device_id: "d3" }],
    });
  });

  it("sends nothing until a building is chosen — not even with only one to choose", async () => {
    const assign = wire();
    renderWithProviders(<Placement />);
    await userEvent.click(await screen.findByRole("checkbox", { name: "2F-DB" }));
    await userEvent.click(screen.getByRole("button", { name: "Assign 1 to a building…" }));
    await waitFor(() => expect(sites.list).toHaveBeenCalled());

    const send = screen.getByRole("button", { name: "Choose a building" });
    expect(send).toBeDisabled();
    await userEvent.click(send);
    expect(assign).not.toHaveBeenCalled();
    // And no building was picked for them.
    expect(screen.getByText("1 device → …")).toBeInTheDocument();
  });

  it("takes a floor when one is chosen, and never asks for a pin", async () => {
    const assign = wire();
    renderWithProviders(<Placement />);
    await userEvent.click(await screen.findByRole("checkbox", { name: "2F-DB" }));
    await userEvent.click(screen.getByRole("button", { name: "Assign 1 to a building…" }));
    await pickBuilding();
    await userEvent.click(await screen.findByRole("button", { name: "Floor (optional)" }));
    await userEvent.click(await screen.findByRole("option", { name: "Level 4" }));
    await userEvent.click(screen.getByRole("button", { name: "Assign 1 device to Aeon Tower" }));

    await waitFor(() => expect(assign).toHaveBeenCalledTimes(1));
    expect(assign.mock.calls[0][0].devices).toEqual([{ device_id: "d2", floor_id: "f4" }]);
    expect(JSON.stringify(assign.mock.calls[0][0])).not.toMatch(/floor_position/);
  });

  it("shows each device's outcome, and says when a move dropped a pin", async () => {
    const assign = wire();
    assign.mockResolvedValue({
      site_id: "aeon",
      site_name: "Aeon Tower",
      assigned: 1,
      items: [{ device_id: "d9", placement_id: "p9", site_id: "aeon", floor_id: null, created: false, pin_cleared: true }],
    });
    renderWithProviders(<Placement />);
    await userEvent.click(await screen.findByRole("button", { name: "IN A BUILDING 1" }));
    await userEvent.click(await screen.findByRole("checkbox", { name: "Chiller-1" }));
    await userEvent.click(screen.getByRole("button", { name: "Assign 1 to a building…" }));
    expect(screen.getByText("moves from Old Block")).toBeInTheDocument();
    await pickBuilding();
    await userEvent.click(screen.getByRole("button", { name: "Assign 1 device to Aeon Tower" }));

    const outcome = await screen.findByRole("list", { name: "Outcome per device" });
    expect(within(outcome).getByText("Chiller-1")).toBeInTheDocument();
    expect(within(outcome).getByText("moved from Old Block")).toBeInTheDocument();
    expect(within(outcome).getByText("pin removed — re-pin on the floor plan")).toBeInTheDocument();
    expect(screen.getByText(/1 floor-plan pin removed/)).toBeInTheDocument();
  });

  it("renders a device that kept its pin as assigned, with no pin line", async () => {
    wire();
    renderWithProviders(<Placement />);
    await userEvent.click(await screen.findByRole("checkbox", { name: "1F-DB" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "3F-DB" }));
    await userEvent.click(screen.getByRole("button", { name: "Assign 2 to a building…" }));
    await pickBuilding();
    await userEvent.click(screen.getByRole("button", { name: "Assign 2 devices to Aeon Tower" }));

    const outcome = await screen.findByRole("list", { name: "Outcome per device" });
    expect(within(outcome).getAllByText("assigned")).toHaveLength(2);
    expect(screen.queryByText(/pin removed/)).not.toBeInTheDocument();
  });

  it("makes the gate strip's reads stale when it lands", async () => {
    wire();
    const { client } = renderWithProviders(<Placement />);
    const invalidate = vi.spyOn(client, "invalidateQueries");
    await userEvent.click(await screen.findByRole("checkbox", { name: "1F-DB" }));
    await userEvent.click(screen.getByRole("button", { name: "Assign 1 to a building…" }));
    await pickBuilding();
    await userEvent.click(screen.getByRole("button", { name: "Assign 1 device to Aeon Tower" }));

    await screen.findByRole("list", { name: "Outcome per device" });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["bi-summary"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["bi-devices"] });
  });

  it("names the refusal and assigns nothing when the server refuses", async () => {
    const assign = wire();
    assign.mockRejectedValue({ response: { status: 409, data: { error: { message: "floor is not on that site" } } } });
    renderWithProviders(<Placement />);
    await userEvent.click(await screen.findByRole("checkbox", { name: "1F-DB" }));
    await userEvent.click(screen.getByRole("button", { name: "Assign 1 to a building…" }));
    await pickBuilding();
    await userEvent.click(screen.getByRole("button", { name: "Assign 1 device to Aeon Tower" }));
    expect(await screen.findByText(/floor is not on that site/)).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Outcome per device" })).not.toBeInTheDocument();
  });
});

describe("while the store has not answered", () => {
  it("prints a dash for a count, never a zero", async () => {
    vi.spyOn(bi, "devices").mockReturnValue(new Promise(() => {}));
    renderWithProviders(<Placement />);
    expect(await screen.findByRole("button", { name: "NO BUILDING —" })).toBeInTheDocument();
    expect(screen.queryByText(/\b0\b/)).not.toBeInTheDocument();
  });
});

describe("moving a device that already has a building", () => {
  it("can be put on a floor as part of the move", async () => {
    wire();
    renderWithProviders(<Placement />);
    await userEvent.click(await screen.findByRole("button", { name: "IN A BUILDING 1" }));
    await userEvent.click(await screen.findByRole("checkbox", { name: "Chiller-1" }));
    await userEvent.click(screen.getByRole("button", { name: "Assign 1 to a building…" }));
    await pickBuilding();
    await waitFor(() => expect(screen.getByRole("button", { name: "Assign 1 device to Aeon Tower" })).toBeEnabled());
    expect(screen.getByRole("button", { name: "Floor (optional)" })).toBeInTheDocument();
  });
});

describe("a viewer without devices.create", () => {
  it("reads the list and is offered no write control", async () => {
    perms.can = (p) => p !== "devices.create";
    wire();
    renderWithProviders(<Placement />);
    expect(await screen.findByText("1F-DB")).toBeInTheDocument();
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /Assign|Tick devices/ })).not.toBeInTheDocument();
    expect(screen.getByText(/Read only/)).toBeInTheDocument();
  });
});
