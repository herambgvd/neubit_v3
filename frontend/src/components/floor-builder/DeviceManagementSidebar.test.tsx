import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { DevicePlacementIndexRow } from "@/lib/types";

// SCRUM-309: a device has ONE location. One placed on another floor or site is
// not "Available" on this floor — it is listed with where it is, and a drop asks
// before moving it.

const INVENTORY = [
  { device_id: "cam-177", name: "192.168.1.177", device_type: "camera", service: "vms", search_ip: "192.168.1.177" },
  { device_id: "cam-175", name: "192.168.1.175", device_type: "camera", service: "vms", search_ip: "192.168.1.175" },
  { device_id: "cam-212", name: "192.168.1.212", device_type: "camera", service: "vms", search_ip: "192.168.1.212" },
  { device_id: "cam-57", name: "192.168.1.57", device_type: "camera", service: "vms", search_ip: "192.168.1.57" },
];

const INDEX: DevicePlacementIndexRow[] = [
  // On another site's floor — elsewhere.
  { device_id: "cam-177", device_type: "camera", site_id: "gurugram", floor_id: "g-ground",
    site_name: "Gvd gurugram", floor_name: "Ground Floor" },
  // Assigned to THIS site with no floor — placing it refines the fact, so it is available.
  { device_id: "cam-175", device_type: "camera", site_id: "delhi", floor_id: null,
    site_name: "Gvd Delhi", floor_name: null },
  // Another floor of this site — elsewhere.
  { device_id: "cam-212", device_type: "camera", site_id: "delhi", floor_id: "d-first",
    site_name: "Gvd Delhi", floor_name: "First Floor" },
];

vi.mock("@/components/floor-builder/useDeviceInventory", () => ({
  useDeviceInventory: () => ({
    inventory: INVENTORY,
    inventoryById: new Map(INVENTORY.map((d) => [d.device_id, d])),
    loading: false,
  }),
}));

vi.mock("@/lib/api/sites", () => ({
  sites: { devicePlacements: { index: () => Promise.resolve({ items: INDEX, count: INDEX.length }) } },
}));

const { DeviceManagementSidebar, isElsewhere, placementWhere } = await import("./DeviceManagementSidebar");

function renderSidebar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <DeviceManagementSidebar siteId="delhi" floorId="d-ground" placements={[]} />
    </QueryClientProvider>,
  );
}

describe("isElsewhere — mirrors the backend's move rule", () => {
  const row = (over: Partial<DevicePlacementIndexRow>): DevicePlacementIndexRow => ({
    device_id: "d", device_type: "camera", site_id: "s1", floor_id: "f1", ...over,
  });

  it("another site is elsewhere", () => {
    expect(isElsewhere(row({ site_id: "s2" }), "s1", "f1")).toBe(true);
  });
  it("another floor of this site is elsewhere", () => {
    expect(isElsewhere(row({ floor_id: "f2" }), "s1", "f1")).toBe(true);
  });
  it("this floor is not", () => {
    expect(isElsewhere(row({}), "s1", "f1")).toBe(false);
  });
  it("a site-only device of this site is not — placing it refines the fact", () => {
    expect(isElsewhere(row({ floor_id: null }), "s1", "f1")).toBe(false);
  });
});

describe("placementWhere", () => {
  it("names the site and the floor", () => {
    expect(placementWhere(INDEX[0])).toBe("Gvd gurugram › Ground Floor");
  });
  it("names the site alone for a device on no floor", () => {
    expect(placementWhere(INDEX[1])).toBe("Gvd Delhi");
  });
});

describe("the Available tab", () => {
  it("offers only devices placed nowhere else, and lists the rest with where they are", async () => {
    renderSidebar();
    // The index arrives after the first render.
    expect(await screen.findByText("Gvd gurugram › Ground Floor")).toBeTruthy();
    expect(screen.getByText("Gvd Delhi › First Floor")).toBeTruthy();
    expect(screen.getByText(/Placed elsewhere \(2\)/)).toBeTruthy();
    // 175 (site-only on this site) and 57 (placed nowhere) are the available two.
    expect(screen.getByText("Available (2)")).toBeTruthy();
  });

  it("puts where the device is on the drag, so the editor can ask before moving it", async () => {
    renderSidebar();
    const label = await screen.findByText("Gvd gurugram › Ground Floor");
    const row = label.closest("[draggable]") as HTMLElement;
    const data: Record<string, string> = {};
    const dataTransfer = {
      setData: (k: string, v: string) => {
        data[k] = v;
      },
      setDragImage: () => {},
      effectAllowed: "",
    };
    fireEvent.dragStart(row, { dataTransfer });
    const payload = JSON.parse(data["application/x-neubit-device"]);
    expect(payload.device_id).toBe("cam-177");
    expect(payload.elsewhere).toBe("Gvd gurugram › Ground Floor");
  });
});
