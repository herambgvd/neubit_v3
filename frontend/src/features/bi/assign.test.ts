import { describe, expect, it, vi } from "vitest";

import { api } from "@/lib/api";
import { sites } from "@/lib/api/sites";

import { bi } from "./api";
import { assignable, assignBody, outcomeView } from "./assign";

describe("assignBody", () => {
  it("names exactly the devices given, and the site given", () => {
    expect(assignBody([{ device_id: "a" }, { device_id: "b" }], "s1")).toEqual({
      site_id: "s1",
      device_type: "sensor",
      service: "iot",
      devices: [{ device_id: "a" }, { device_id: "b" }],
    });
  });

  it("is nothing at all without a site — there is no default one", () => {
    expect(assignBody([{ device_id: "a" }], "")).toBeNull();
    expect(assignBody([{ device_id: "a" }], null)).toBeNull();
  });

  it("is nothing at all without a device", () => {
    expect(assignBody([], "s1")).toBeNull();
    expect(assignBody([{ device_id: null }], "s1")).toBeNull();
  });

  it("puts the floor on every item when one is named, and no position ever", () => {
    expect(assignBody([{ device_id: "a" }], "s1", "f1")?.devices).toEqual([{ device_id: "a", floor_id: "f1" }]);
    expect(assignBody([{ device_id: "a" }], "s1", "")?.devices).toEqual([{ device_id: "a" }]);
  });

  it("never names one device twice — the server refuses that as two statements", () => {
    expect(assignBody([{ device_id: "a" }, { device_id: "a" }], "s1")?.devices).toEqual([{ device_id: "a" }]);
  });
});

describe("assignable", () => {
  it("needs an id, because a placement is keyed by it", () => {
    expect(assignable({ device_id: "a" })).toBe(true);
    expect(assignable({ device_id: null })).toBe(false);
  });
});

describe("outcomeView", () => {
  const item = { device_id: "a", placement_id: "p", site_id: "s2", floor_id: null, created: false, pin_cleared: false };
  const floorName = (id: string) => (id === "f1" ? "Level 1" : null);

  it("says a pin was dropped, and marks it for attention", () => {
    const v = outcomeView({ ...item, pin_cleared: true }, { device_tag: "AHU", site_id: "s1", site_name: "Old" }, floorName);
    expect(v).toMatchObject({ tag: "AHU", verb: "moved from Old", pinCleared: true, tone: "warn" });
  });

  it("tells a new placement from a move and from a re-statement", () => {
    expect(outcomeView({ ...item, created: true }, undefined, floorName).verb).toBe("assigned");
    expect(outcomeView(item, { device_tag: "x", site_id: "s2", site_name: "Here" }, floorName).verb).toBe("re-stated");
  });

  it("names the floor it landed on, or says there is none", () => {
    expect(outcomeView({ ...item, floor_id: "f1" }, undefined, floorName).floor).toBe("Level 1");
    expect(outcomeView(item, undefined, floorName).floor).toBeNull();
  });
});

describe("on the wire", () => {
  it("asks the reading store for the unplaced devices by name", async () => {
    const get = vi.spyOn(api, "get").mockResolvedValue({ data: { total: 0, items: [] } } as never);
    await bi.devices({ placement: "unplaced", limit: 6 });
    expect(get.mock.calls[0][0]).toMatch(/^\/bi\/devices\?.*placement=unplaced/);
  });

  it("posts the assignment to core's device-first route, body untouched", async () => {
    const post = vi.spyOn(api, "post").mockResolvedValue({ data: { items: [] } } as never);
    const body = assignBody([{ device_id: "a" }], "s1")!;
    await sites.devicePlacements.assign(body);
    expect(post).toHaveBeenCalledWith("/device-placements/assign", body);
  });
});
