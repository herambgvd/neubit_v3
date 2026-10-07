/**
 * Where the estate map's counts lead (SCRUM-311). A count that opens the wrong
 * list — or a list that cannot find the cameras it was counted from — is worse
 * than a count that opens nothing, so the joins are pinned here.
 */
import { describe, expect, it } from "vitest";

import type { DevicePlacementIndexRow } from "@/lib/types";

import {
  NOT_ONLINE,
  placementKeys,
  siteAlarmsHref,
  siteCameraKeys,
  siteCamerasHref,
  siteNameFrom,
  siteSettingsHref,
} from "./siteLinks";

const row = (over: Partial<DevicePlacementIndexRow>): DevicePlacementIndexRow => ({
  device_id: "cam-1",
  device_type: "camera",
  site_id: "s1",
  floor_id: "f1",
  ...over,
});

describe("the links", () => {
  it("opens a site's cameras, and its not-online ones", () => {
    expect(siteCamerasHref("s 1")).toBe("/devices/cameras?site=s+1");
    expect(siteCamerasHref("s1", true)).toBe(`/devices/cameras?site=s1&status=${NOT_ONLINE}`);
  });

  it("opens a site's unacknowledged events — what the Alarms count is", () => {
    expect(siteAlarmsHref("s1")).toBe("/events?site=s1&ack=false");
  });

  it("opens the site itself, where its location is set", () => {
    expect(siteSettingsHref("s1")).toBe("/sites?site=s1");
  });
});

describe("placementKeys", () => {
  it("answers to the composite and the node-side id of a federated camera", () => {
    expect(placementKeys("fed:node-1:cam-9")).toEqual(["fed:node-1:cam-9", "cam-9"]);
  });

  it("leaves any other id alone", () => {
    expect(placementKeys("door-4")).toEqual(["door-4"]);
  });
});

describe("siteCameraKeys", () => {
  it("is every id of every camera at the site, and nothing else", () => {
    const keys = siteCameraKeys(
      [
        row({ device_id: "fed:n:a" }),
        row({ device_id: "door-1", device_type: "door" }),
        row({ device_id: "fed:n:b", site_id: "s2" }),
      ],
      "s1",
    );
    expect([...keys].sort()).toEqual(["a", "fed:n:a"]);
  });
});

describe("siteNameFrom", () => {
  it("reads the name the index carries, or says it does not know", () => {
    const rows = [row({ site_name: "Gvd gurugram" })];
    expect(siteNameFrom(rows, "s1")).toBe("Gvd gurugram");
    expect(siteNameFrom(rows, "s9")).toBeNull();
  });
});
