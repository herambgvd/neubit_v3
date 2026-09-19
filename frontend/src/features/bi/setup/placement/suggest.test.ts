/**
 * Which building a device is in — suggested from evidence, never from the mere
 * fact that the estate has one building.
 */
import { describe, expect, it } from "vitest";

import type { BiDeviceRow } from "@/lib/types";

import { changesOf, suggest } from "./suggest";

const NOW = "2026-09-20T10:00:00Z";
const dev = (id: string, tag: string, over: Partial<BiDeviceRow> = {}): BiDeviceRow => ({
  device_id: id,
  device_tag: tag,
  category: "hvac",
  device_type: null,
  points: 6,
  numeric_points: 6,
  text_points: 0,
  points_reporting: 6,
  first_seen_at: null,
  last_seen_at: NOW,
  site_id: null,
  site_name: null,
  gateway_id: null,
  ...over,
});
const inAeon = (id: string, tag: string, over: Partial<BiDeviceRow> = {}) =>
  dev(id, tag, { site_id: "aeon", site_name: "Aeon Tower", ...over });

describe("the evidence", () => {
  it("suggests the building a same-named device is already in", () => {
    // A gateway rebuild gives a device a new id: the same chiller appears
    // unplaced while its older self is placed.
    const [r] = suggest([dev("new", "1F York Chiller01")], [inAeon("old", "1F York Chiller01")]);
    expect(r.suggestion).toEqual({ siteId: "aeon", siteName: "Aeon Tower", why: "same_name" });
    expect(r.reason).toBe("same name already there");
  });

  it("matches the name however it is cased or padded", () => {
    const [r] = suggest([dev("new", " b2_main incomer ")], [inAeon("old", "B2_Main Incomer")]);
    expect(r.suggestion?.why).toBe("same_name");
  });

  it("suggests the building every other device on its gateway is in", () => {
    const [r] = suggest(
      [dev("x", "4F_Incomer1_EM", { gateway_id: "gw1" })],
      [inAeon("a", "A", { gateway_id: "gw1" }), inAeon("b", "B", { gateway_id: "gw1" })],
    );
    expect(r.suggestion).toEqual({ siteId: "aeon", siteName: "Aeon Tower", why: "same_gateway" });
    expect(r.reason).toBe("same gateway as 2 devices there");
  });

  it("suggests NOTHING when the only evidence is that there is one building", () => {
    // The rule assign.ts states: no default building, not even with one.
    const [r] = suggest([dev("x", "Mystery")], [inAeon("a", "A", { gateway_id: "gw1" })]);
    expect(r.suggestion).toBeNull();
    expect(r.reason).toBe("no evidence — choose a building");
  });

  it("suggests nothing when the evidence disagrees with itself", () => {
    const twoNames = suggest(
      [dev("x", "Pump")],
      [inAeon("a", "Pump"), dev("b", "Pump", { site_id: "b2", site_name: "Block 2" })],
    )[0];
    expect(twoNames.suggestion).toBeNull();
    expect(twoNames.reason).toBe("a device with this name is in 2 buildings");

    const twoGw = suggest(
      [dev("x", "M", { gateway_id: "gw" })],
      [inAeon("a", "A", { gateway_id: "gw" }), dev("b", "B", { gateway_id: "gw", site_id: "b2", site_name: "Block 2" })],
    )[0];
    expect(twoGw.suggestion).toBeNull();
    expect(twoGw.reason).toBe("its gateway serves 2 buildings");
  });

  it("prefers the name over the gateway — it is the stronger evidence", () => {
    const [r] = suggest(
      [dev("x", "Chiller", { gateway_id: "gw" })],
      [inAeon("a", "Chiller"), dev("b", "B", { gateway_id: "gw", site_id: "b2", site_name: "Block 2" })],
    );
    expect(r.suggestion?.siteId).toBe("aeon");
    expect(r.suggestion?.why).toBe("same_name");
  });
});

describe("a quiet device", () => {
  it("is never pre-filled, even with evidence, and says since when", () => {
    const [r] = suggest(
      [dev("old", "1F Khem Chiller01", { last_seen_at: "2026-09-11T10:46:47Z" })],
      [inAeon("a", "1F Khem Chiller01", { last_seen_at: NOW })],
    );
    expect(r.suggestion).toBeNull();
    expect(r.quietSince).toBe("2026-09-11T10:46:47Z");
    expect(r.reason).toMatch(/^quiet since 11 Sept/);
  });

  it("is measured against the estate's newest reading, not the wall clock", () => {
    // Between ingest runs every device looks old; that is not "quiet".
    const [r] = suggest(
      [dev("x", "A", { last_seen_at: "2026-01-01T09:00:00Z" })],
      [inAeon("a", "A", { last_seen_at: "2026-01-01T10:00:00Z" })],
    );
    expect(r.quietSince).toBeNull();
    expect(r.suggestion?.why).toBe("same_name");
  });
});

describe("the order", () => {
  it("puts what can be accepted first and what needs thought last", () => {
    const rows = suggest(
      [
        dev("q", "Quiet", { last_seen_at: "2026-09-01T00:00:00Z" }),
        dev("n", "Nothing"),
        dev("g", "Gw", { gateway_id: "gw" }),
        dev("s", "Same"),
      ],
      [inAeon("a", "Same", { gateway_id: "gw" })],
    );
    expect(rows.map((r) => r.device.device_id)).toEqual(["s", "g", "n", "q"]);
  });
});

describe("what a save writes", () => {
  it("one assignment per building, and only for devices that change", () => {
    const c = changesOf(
      { d1: "aeon", d2: "aeon", d3: "", d4: "b2", d5: "aeon" },
      { d1: null, d2: null, d3: null, d4: null, d5: "aeon" },
    );
    expect(Object.fromEntries(c)).toEqual({ aeon: ["d1", "d2"], b2: ["d4"] });
  });
});
