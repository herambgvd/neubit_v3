/**
 * BUILDINGS & DEVICES — cards grouped by the evidence for where each device
 * is, a building pre-filled where there is evidence, and nothing placed until
 * a person saves.
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

const NOW = "2026-09-20T10:00:00Z";
const row = (id: string | null, tag: string, over: Record<string, unknown> = {}) => ({
  device_id: id, device_tag: tag, category: "energy", device_type: null, points: 6,
  numeric_points: 6, text_points: 0, points_reporting: 6, first_seen_at: null,
  last_seen_at: NOW, site_id: null, site_name: null, gateway_id: null, ...over,
});

const unplaced = {
  total: 4,
  items: [
    row("d1", "1F York Chiller01"),                                 // same name → Aeon
    row("d2", "4F_Incomer1_EM", { gateway_id: "gw" }),              // same gateway → Aeon
    row("d3", "Mystery"),                                           // nothing
    row("d4", "1F Khem Chiller01", { last_seen_at: "2026-09-11T10:46:47Z" }), // quiet
  ],
};
const placed = {
  total: 1,
  items: [row("p1", "1F York Chiller01", { site_id: "aeon", site_name: "Aeon Tower", gateway_id: "gw" })],
};

function wire() {
  vi.spyOn(bi, "devices").mockImplementation(async ({ placement }: any = {}) =>
    placement === "placed" ? placed : unplaced,
  );
  vi.spyOn(bi, "ratingSites").mockResolvedValue({
    items: [
      { site_id: "aeon", site_name: "Aeon Tower", is_active: true },
      { site_id: "b2", site_name: "Block 2", is_active: true },
    ],
  } as any);
  return vi.spyOn(sites.devicePlacements, "assign").mockImplementation(async (body: any) => ({
    site_id: body.site_id,
    site_name: null,
    assigned: body.devices.length,
    items: body.devices.map((d: any) => ({
      device_id: d.device_id, placement_id: "x", site_id: body.site_id, floor_id: null,
      created: d.device_id !== "p1", pin_cleared: d.device_id === "p1",
    })),
  }));
}

const select = (tag: string) => screen.getByRole("combobox", { name: `Building for ${tag}` });

beforeEach(() => {
  perms.can = () => true;
  for (const k of Object.keys(query)) delete query[k];
});

const section = (name: string) => screen.getByRole("region", { name });

describe("the cards", () => {
  it("groups the devices by the evidence, and says it once per group", async () => {
    wire();
    renderWithProviders(<Placement />);

    await screen.findByText("Same name already in a building");
    expect(within(section("Same name already in a building")).getByText("1F York Chiller01")).toBeInTheDocument();
    expect(within(section("On the same gateway as placed devices")).getByText("4F_Incomer1_EM")).toBeInTheDocument();
    expect(within(section("No evidence — choose a building")).getByText("Mystery")).toBeInTheDocument();
    expect(within(section("Quiet — probably an old copy")).getByText("1F Khem Chiller01")).toBeInTheDocument();
  });

  it("pre-fills a building where there is evidence", async () => {
    wire();
    renderWithProviders(<Placement />);

    await screen.findByText("Same name already in a building");
    expect(select("1F York Chiller01")).toHaveValue("aeon");
    expect(select("4F_Incomer1_EM")).toHaveValue("aeon");
  });

  it("pre-fills nothing without evidence — two buildings to choose from, and no guess", async () => {
    wire();
    renderWithProviders(<Placement />);

    await screen.findByText("Same name already in a building");
    expect(select("Mystery")).toHaveValue("");
  });

  it("never pre-fills a quiet device, and says since when", async () => {
    wire();
    renderWithProviders(<Placement />);

    expect(await screen.findByText("since 11 Sept")).toBeInTheDocument();
    expect(select("1F Khem Chiller01")).toHaveValue("");
  });

  it("marks a card a person has changed", async () => {
    wire();
    const user = userEvent.setup();
    renderWithProviders(<Placement />);

    await screen.findByText("Same name already in a building");
    await user.selectOptions(select("Mystery"), "b2");
    expect(select("Mystery").closest("div[title]")?.className).toMatch(/border-nb-blue/);
  });

  it("counts what it suggested", async () => {
    wire();
    renderWithProviders(<Placement />);
    expect(await screen.findByText(/a building is suggested for 2/)).toBeInTheDocument();
  });
});

describe("saving", () => {
  it("writes nothing until pressed, then exactly the suggestions, one call per building", async () => {
    const assign = wire();
    const user = userEvent.setup();
    renderWithProviders(<Placement />);

    await user.click(await screen.findByRole("button", { name: "Accept 2 suggestions" }));
    await waitFor(() => expect(assign).toHaveBeenCalledTimes(1));
    expect(assign.mock.calls[0][0]).toEqual({
      site_id: "aeon", device_type: "sensor", service: "iot",
      devices: [{ device_id: "d1" }, { device_id: "d2" }],
    });
    expect(await screen.findByText("Placed 2")).toBeInTheDocument();
  });

  it("takes a person's change over the suggestion, and groups by building", async () => {
    const assign = wire();
    const user = userEvent.setup();
    renderWithProviders(<Placement />);

    await screen.findByText("Same name already in a building");
    await user.selectOptions(select("Mystery"), "b2");
    await user.click(screen.getByRole("button", { name: "Save 3 changes" }));

    await waitFor(() => expect(assign).toHaveBeenCalledTimes(2));
    const bySite = Object.fromEntries(assign.mock.calls.map(([b]: any) => [b.site_id, b.devices.map((d: any) => d.device_id)]));
    expect(bySite).toEqual({ aeon: ["d1", "d2"], b2: ["d3"] });
  });

  it("moves a placed device the same way, and says when the move dropped a pin", async () => {
    const assign = wire();
    const user = userEvent.setup();
    renderWithProviders(<Placement />);

    await user.click(await screen.findByRole("button", { name: /1 already in a building/ }));
    await user.selectOptions(screen.getAllByRole("combobox", { name: "Building for 1F York Chiller01" })[1], "b2");
    await user.selectOptions(select("4F_Incomer1_EM"), "");
    await user.selectOptions(screen.getAllByRole("combobox", { name: "Building for 1F York Chiller01" })[0], "");
    await user.click(screen.getByRole("button", { name: "Save 1 change" }));

    await waitFor(() => expect(assign).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Placed 1 · 1 moved from another building · 1 lost their floor-plan pin")).toBeInTheDocument();
  });

  it("names the refusal when the server refuses", async () => {
    const assign = wire();
    assign.mockRejectedValue(Object.assign(new Error("site is archived"), {}));
    const user = userEvent.setup();
    renderWithProviders(<Placement />);

    await user.click(await screen.findByRole("button", { name: "Accept 2 suggestions" }));
    expect(await screen.findByText(/site is archived/)).toBeInTheDocument();
  });
});

describe("scope and permission", () => {
  it("asks for the category a domain strip sent", async () => {
    query.category = "energy";
    wire();
    renderWithProviders(<Placement />);
    await screen.findByText("Same name already in a building");
    expect(bi.devices).toHaveBeenCalledWith(expect.objectContaining({ placement: "unplaced", category: "energy" }));
  });

  it("a viewer without devices.create reads the table and can change nothing", async () => {
    perms.can = (p) => p !== "devices.create";
    wire();
    renderWithProviders(<Placement />);

    expect(await screen.findByText("Same name already in a building")).toBeInTheDocument();
    expect(select("Mystery")).toBeDisabled();
    expect(screen.queryByRole("button", { name: /Accept|Save/ })).not.toBeInTheDocument();
    expect(screen.getByText(/Placing needs/)).toHaveTextContent("devices.create");
  });

  it("lists a device with no id but will not let it be placed", async () => {
    wire();
    vi.mocked(bi.devices).mockImplementation(async ({ placement }: any = {}) =>
      placement === "placed" ? placed : { total: 1, items: [row(null, "Orphan-Meter")] },
    );
    renderWithProviders(<Placement />);

    expect(await screen.findByText("has no device id — cannot be placed")).toBeInTheDocument();
    expect(select("Orphan-Meter")).toBeDisabled();
  });
});

describe("the layout", () => {
  it("scrolls the table's rows, not the page, so the save stays in reach", async () => {
    wire();
    renderWithProviders(<Placement />);
    await screen.findByText("Same name already in a building");

    const rows = screen.getByTestId("placement-rows");
    expect(rows.className).toMatch(/overflow-y-auto/);
    expect(rows.className).toMatch(/min-h-0/);
    // The save button is outside the scrolling body.
    expect(within(rows).queryByRole("button", { name: /Accept|Save/ })).toBeNull();
  });
});
