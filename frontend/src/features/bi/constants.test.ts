/**
 * Building Intelligence's whole premise is that it never invents a fact. These
 * are the two functions where an invention would be easiest and least visible:
 *
 *   fmtReading   prints a measurement. A point with nothing in the API's lookback
 *                window must print an em dash, NOT a stale number dressed as
 *                live, and zero must print as zero rather than as "no data".
 *   qualityTone  the device's own `q` flag. Anything but 0 means the device said
 *                the sample is suspect, and the UI is not allowed to hide that.
 *
 * The label maps are presentation only: a category or equipment kind the gateway
 * sends that this file has never heard of must render AS SENT, never be dropped
 * and never be renamed into something we made up.
 */
import { describe, expect, it } from "vitest";

import { CATEGORY_META, categoryMeta, deviceTypeLabel, fmtReading, qualityTone } from "./constants";

describe("fmtReading", () => {
  const cases: [string, unknown, string][] = [
    // Absence, in every shape the API can express it.
    ["no reading at all", null, "—"],
    ["an undefined reading", undefined, "—"],
    ["a numeric point with a null value and no text", { num: null, txt: null }, "—"],
    ["a value that is not a number", { num: "abc" }, "—"],
    ["a non-finite value", { num: Infinity }, "—"],
    ["a NaN value", { num: NaN }, "—"],

    // Presence. Precision falls as magnitude rises, which is the point: 3 decimals
    // on a 40,000 kWh register is noise, and 0 decimals on a 0.004 reading is a lie.
    ["zero, which is a measurement and not an absence", { num: 0 }, "0.000"],
    ["a sub-unit value at three decimals", { num: 0.12345 }, "0.123"],
    ["a single-digit value at two decimals", { num: 4.5678 }, "4.57"],
    ["a two-digit value at one decimal", { num: 42.56 }, "42.6"],
    ["a four-digit value with no decimals", { num: 40123.7 }, "40,124"],
    ["a negative value by magnitude, not by sign", { num: -42.56 }, "-42.6"],

    // Text points print verbatim; no numeric formatting is applied to them.
    ["a text reading", { num: null, txt: "RUNNING" }, "RUNNING"],
    ["a text reading that looks numeric", { num: null, txt: "0012" }, "0012"],
    ["a numeric zero in preference to a text field", { num: 0, txt: "IGNORED" }, "0.000"],
  ];

  it.each(cases)("prints %s as %s", (_label, latest, expected) => {
    expect(fmtReading(latest)).toBe(expected);
  });

  it("appends no unit, because the wire carries none", () => {
    expect(fmtReading({ num: 42, unit: "kWh" })).toBe("42.0");
  });
});

describe("qualityTone", () => {
  it.each([
    ["a good sample (q=0)", 0],
    ["an absent flag", null],
    ["an undefined flag", undefined],
  ])("leaves %s unmarked", (_label, q) => {
    expect(qualityTone(q)).toBe("");
  });

  it.each([[1], [2], [64], [-1]])("marks a suspect sample (q=%s) as a warning", (q) => {
    expect(qualityTone(q)).toBe("text-nb-warn");
  });
});

describe("categoryMeta", () => {
  it("gives every known category a label, an icon and an accent", () => {
    // A loop over an empty map asserts nothing and passes.
    expect(Object.keys(CATEGORY_META).length).toBeGreaterThan(0);
    for (const [key, meta] of Object.entries(CATEGORY_META)) {
      expect(meta.key).toBe(key);
      expect(meta.label).toBeTruthy();
      expect(meta.icon).toBeTruthy();
      expect(meta.accent).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it("renders a category it has never heard of AS SENT rather than dropping it", () => {
    const meta = categoryMeta("lighting");
    expect(meta.key).toBe("lighting");
    expect(meta.label).toBe("lighting");
    expect(meta.href).toBeUndefined();
  });

  it("calls an unclassified device unclassified rather than guessing a category", () => {
    for (const missing of [null, undefined, ""]) {
      expect(categoryMeta(missing).label).toBe("Unclassified");
      expect(categoryMeta(missing).key).toBe("");
    }
  });

  it("links only the categories that have a console to send anyone to", () => {
    expect(categoryMeta("energy").href).toBe("/bi/energy");
    expect(categoryMeta("hvac").href).toBe("/bi/hvac");
    expect(categoryMeta("water").href).toBe("/bi/water");
    // `fire` has one point and it has never produced a reading; a link there
    // would send an operator to an empty console.
    expect(categoryMeta("fire").href).toBeUndefined();
  });
});

describe("deviceTypeLabel", () => {
  it.each([
    ["incomer", "Incomer"],
    ["ups", "UPS"],
    ["distribution-board", "Distribution board"],
    ["flow-meter", "Flow meter"],
  ])("prettifies the known kind %s", (key, expected) => {
    expect(deviceTypeLabel(key)).toBe(expected);
  });

  it("renders an unknown equipment kind exactly as the gateway spelled it", () => {
    expect(deviceTypeLabel("borewell-pump")).toBe("borewell-pump");
  });

  it("says unclassified rather than inventing a kind for a device without one", () => {
    expect(deviceTypeLabel(null)).toBe("Unclassified");
    expect(deviceTypeLabel(undefined)).toBe("Unclassified");
    expect(deviceTypeLabel("")).toBe("Unclassified");
  });
});
