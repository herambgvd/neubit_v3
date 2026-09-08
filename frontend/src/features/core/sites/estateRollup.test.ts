/**
 * The estate map's arithmetic.
 *
 * Three feeds from two services are joined on the device id here, and every
 * mistake in that join puts a number on a building that is not true of it. The
 * cases below are the ones that would do that quietly: a device nobody placed, an
 * event from a camera nobody placed, a camera whose status has not arrived yet,
 * and a non-camera placement counted as a camera.
 */
import { describe, expect, it } from "vitest";

import type { DevicePlacementIndexRow } from "@/lib/types";

import { isOffline, opsSeverity, rollupBySite, SEVERITY_RANK } from "./estateRollup";

const place = (over: Partial<DevicePlacementIndexRow>): DevicePlacementIndexRow => ({
  device_id: "cam-1",
  device_type: "camera",
  site_id: "site-1",
  floor_id: "floor-1",
  ...over,
});

describe("rollupBySite", () => {
  it("counts devices and cameras per site", () => {
    const out = rollupBySite({
      placements: [
        place({ device_id: "cam-1" }),
        place({ device_id: "cam-2" }),
        place({ device_id: "door-1", device_type: "door" }),
        place({ device_id: "cam-9", site_id: "site-2" }),
      ],
      cameras: [],
      events: [],
    });
    expect(out.get("site-1")).toMatchObject({ devices: 3, cameras: 2 });
    expect(out.get("site-2")).toMatchObject({ devices: 1, cameras: 1 });
  });

  it("counts a camera offline only when its status says so", () => {
    const out = rollupBySite({
      placements: [place({ device_id: "up" }), place({ device_id: "down" }), place({ device_id: "unknown" })],
      cameras: [
        { id: "up", status: "online" },
        { id: "down", status: "offline" },
        // No row at all for "unknown" — the estate list has not described it yet.
      ],
      events: [],
    });
    // Not 2: an undescribed camera would light the whole map red on first paint.
    expect(out.get("site-1")?.offline).toBe(1);
  });

  it("attributes an alarm to the site its camera is placed at", () => {
    const out = rollupBySite({
      placements: [place({ device_id: "cam-1" }), place({ device_id: "cam-9", site_id: "site-2" })],
      cameras: [],
      events: [
        { camera_id: "cam-1", acknowledged: false },
        { camera_id: "cam-9", acknowledged: false },
        { camera_id: "cam-9", acknowledged: false },
      ],
    });
    expect(out.get("site-1")?.alarms).toBe(1);
    expect(out.get("site-2")?.alarms).toBe(2);
  });

  it("ignores acknowledged events", () => {
    const out = rollupBySite({
      placements: [place({})],
      cameras: [],
      events: [
        { camera_id: "cam-1", acknowledged: true },
        { camera_id: "cam-1", acknowledged: false },
      ],
    });
    expect(out.get("site-1")?.alarms).toBe(1);
  });

  it("drops an event from a camera nobody placed rather than guessing a site", () => {
    // Attributing it would put a red badge on a building that has nothing to do
    // with it — worse than not showing it at all.
    const out = rollupBySite({
      placements: [place({})],
      cameras: [],
      events: [{ camera_id: "a-camera-on-no-floor-plan", acknowledged: false }],
    });
    expect(out.get("site-1")?.alarms).toBe(0);
    expect([...out.keys()]).toEqual(["site-1"]);
  });

  it("does not count a door's status as a camera's", () => {
    const out = rollupBySite({
      placements: [place({ device_id: "door-1", device_type: "door" })],
      cameras: [{ id: "door-1", status: "offline" }],
      events: [],
    });
    expect(out.get("site-1")).toMatchObject({ devices: 1, cameras: 0, offline: 0 });
  });

  it("leaves a site with nothing placed out of the map entirely", () => {
    const out = rollupBySite({ placements: [], cameras: [], events: [] });
    expect(out.size).toBe(0);
  });
});

describe("isOffline", () => {
  it("treats an unknown status as not-offline, and anything but up as offline", () => {
    expect(isOffline({ id: "a" })).toBe(false);
    expect(isOffline({ id: "a", status: "" })).toBe(false);
    expect(isOffline({ id: "a", status: "online" })).toBe(false);
    expect(isOffline({ id: "a", status: "ONLINE" })).toBe(false);
    expect(isOffline({ id: "a", status: "offline" })).toBe(true);
    expect(isOffline({ id: "a", status: "error" })).toBe(true);
  });
});

describe("opsSeverity", () => {
  it("ranks alarms above dark cameras above quiet", () => {
    expect(opsSeverity({ devices: 1, cameras: 1, offline: 1, alarms: 1 })).toBe("alarm");
    expect(opsSeverity({ devices: 1, cameras: 1, offline: 1, alarms: 0 })).toBe("offline");
    expect(opsSeverity({ devices: 1, cameras: 1, offline: 0, alarms: 0 })).toBe("normal");
    expect(opsSeverity(undefined)).toBe("normal");
    // The cluster layer aggregates with `max`, so the order has to hold as numbers.
    expect(SEVERITY_RANK.alarm).toBeGreaterThan(SEVERITY_RANK.offline);
    expect(SEVERITY_RANK.offline).toBeGreaterThan(SEVERITY_RANK.normal);
  });
});
