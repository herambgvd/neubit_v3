import { describe, expect, it } from "vitest";

import type { DevicePlacementPublic } from "@/lib/types";

import { isPinned, normalizePlacement } from "./FloorPlanEditor";

// Core migration 0031 lets a placement name a floor and carry no position: "this
// meter is on Level 4", said without a drawing. The editor loads a floor's
// placements by floor, so those rows now reach it — and it used to default a
// missing position to (0, 0), drawing a pin in the plan's corner that nobody placed.

function placement(over: Partial<DevicePlacementPublic>): DevicePlacementPublic {
  return {
    placement_id: "pl-1",
    device_id: "meter-1",
    device_type: "sensor",
    service: "iot",
    site_id: "site-1",
    floor_id: "floor-1",
    zone_id: null,
    floor_position: { x: 120, y: 80, rotation: 30 },
    metadata: null,
    status: "unknown",
    status_updated_at: null,
    created_by: null,
    created_at: "2026-09-19T00:00:00Z",
    updated_at: "2026-09-19T00:00:00Z",
    ...over,
  };
}

describe("a placement on the floor with no pin", () => {
  it("is not drawn — the canvas set leaves it out", () => {
    const rows = [
      placement({ device_id: "pinned" }),
      placement({ device_id: "floor-only", floor_position: null }),
    ];
    const drawn = rows.filter(isPinned).map((p) => p.device_id);
    expect(drawn).toEqual(["pinned"]);
  });

  it("never acquires a coordinate nobody placed", () => {
    const drawn = [placement({ floor_position: null })].filter(isPinned).map(normalizePlacement);
    expect(drawn).toEqual([]);
  });
});

describe("a pinned placement", () => {
  it("is drawn exactly where it was pinned", () => {
    const [p] = [placement({})].filter(isPinned).map(normalizePlacement);
    expect({ x: p.x, y: p.y, rotation: p.rotation }).toEqual({ x: 120, y: 80, rotation: 30 });
  });
});
