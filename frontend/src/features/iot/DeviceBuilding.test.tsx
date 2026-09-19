/**
 * The IoT devices tab's building line: an operator starting from a DEVICE can
 * see which building it is in and assign it, through the same confirmation gate
 * 3's worklist uses — and only when the device resolves to exactly one.
 */
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { bi } from "@/features/bi/api";
import { sites } from "@/lib/api/sites";
import { renderWithProviders } from "@/test/render";

import DeviceBuilding from "./DeviceBuilding";

const perms = { can: (_p: string) => true, module: true };
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ can: (p: string) => perms.can(p), hasModule: () => perms.module }),
}));

const dev = (device_id: string, device_tag: string, over: Record<string, unknown> = {}) => ({
  device_id,
  device_tag,
  category: "hvac",
  device_type: "ahu",
  points: 3,
  site_id: null,
  site_name: null,
  ...over,
});

beforeEach(() => {
  perms.can = () => true;
  perms.module = true;
  vi.spyOn(sites, "list").mockResolvedValue({ items: [{ site_id: "aeon", name: "Aeon Tower" }], total: 1 } as any);
  vi.spyOn(sites.floors, "list").mockResolvedValue({ items: [], total: 0 } as any);
});

const line = <DeviceBuilding gatewayId="gw1" tag="AHU-1" pointIds={["p1", "p2"]} />;

describe("the building line on a gateway device", () => {
  it("says it has no building and assigns it through the shared confirmation", async () => {
    vi.spyOn(bi, "devices").mockResolvedValue({ total: 2, items: [dev("d1", "AHU-1"), dev("d2", "AHU-10")] });
    const assign = vi.spyOn(sites.devicePlacements, "assign").mockResolvedValue({
      site_id: "aeon",
      site_name: "Aeon Tower",
      assigned: 1,
      items: [{ device_id: "d1", placement_id: "p", site_id: "aeon", floor_id: null, created: true, pin_cleared: false }],
    });
    renderWithProviders(line);

    expect(await screen.findByText("No building")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Assign to a building…" }));
    await userEvent.click(screen.getByRole("button", { name: "Building" }));
    await userEvent.click(await screen.findByRole("option", { name: "Aeon Tower" }));
    await userEvent.click(screen.getByRole("button", { name: "Assign 1 device to Aeon Tower" }));

    await waitFor(() => expect(assign).toHaveBeenCalledTimes(1));
    expect(assign.mock.calls[0][0].devices).toEqual([{ device_id: "d1" }]);
  });

  it("names the building a placed device is in", async () => {
    vi.spyOn(bi, "devices").mockResolvedValue({
      total: 1,
      items: [dev("d1", "AHU-1", { site_id: "aeon", site_name: "Aeon Tower" })],
    });
    renderWithProviders(line);
    expect(await screen.findByText("Aeon Tower")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Move…" })).toBeInTheDocument();
  });

  it("settles a shared tag by the gateway's own points, and refuses when they do not", async () => {
    vi.spyOn(bi, "devices").mockResolvedValue({ total: 2, items: [dev("d1", "AHU-1"), dev("d2", "AHU-1")] });
    const points = vi.spyOn(bi, "points").mockResolvedValue({
      total: 3,
      items: [
        { point_id: "p1", device_id: "d2" },
        { point_id: "zz", device_id: "d1" },
      ],
    });
    renderWithProviders(line);
    expect(await screen.findByText("No building")).toBeInTheDocument();
    expect(points).toHaveBeenCalledWith({ device_tag: "AHU-1", limit: 500 });

    points.mockResolvedValue({ total: 0, items: [] });
    renderWithProviders(<DeviceBuilding gatewayId="gw2" tag="AHU-1" pointIds={["p9"]} />);
    expect(await screen.findByText(/tag is ambiguous/)).toBeInTheDocument();
  });

  it("offers no write control without devices.create", async () => {
    perms.can = (p) => p !== "devices.create";
    vi.spyOn(bi, "devices").mockResolvedValue({ total: 1, items: [dev("d1", "AHU-1")] });
    renderWithProviders(line);
    expect(await screen.findByText("No building")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("asks the reading store nothing without bi.read", () => {
    perms.can = (p) => p !== "bi.read";
    const devices = vi.spyOn(bi, "devices");
    const { container } = renderWithProviders(line);
    expect(container).toBeEmptyDOMElement();
    expect(devices).not.toHaveBeenCalled();
  });
});
