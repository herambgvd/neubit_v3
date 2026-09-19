/**
 * Units as questions — and the platform does the checking.
 *
 * The one rule: a range CHECK decides what is asked together and what is asked
 * alone. It never decides a unit. A reading nobody has seen lately is never
 * counted as checked, and a kind with a single reading out of range is never
 * swept with the rest.
 */
import { describe, expect, it } from "vitest";

import { check, fit, questionsOf, reading, type Catalogue, type UnitPattern, type UnitPoint } from "./unitAsk";

let n = 0;
const pt = (value: number | null, tag = "T"): UnitPoint => ({
  point_id: `p${++n}`,
  point_tag: tag,
  device_tag: "D",
  value,
  at: value == null ? null : "2026-09-20T09:00:00Z",
});

const pat = (over: Partial<UnitPattern> & { key: string }): UnitPattern => ({
  label: over.key,
  kind: "unit",
  unit: "V",
  eligible: (over.points ?? []).length,
  points: [],
  ...over,
});

const cat = (patterns: UnitPattern[], unmatched: UnitPoint[] = []): Catalogue => ({
  patterns: patterns.map((p) => ({ ...p, eligible: (p.points ?? []).length })),
  totals: { points: 0, eligible: 0, already_confirmed: 0, unmatched: unmatched.length },
  unmatched_points: unmatched,
});

describe("does a reading look like its unit", () => {
  it("checks against the unit's plausible range", () => {
    expect(fit(231.4, "V")).toBe("fits");
    expect(fit(142_800, "V")).toBe("outside");
    expect(fit(50.02, "Hz")).toBe("fits");
    expect(fit(98, "")).toBe("outside"); // a power factor sent as a percentage
    expect(fit(0.97, "")).toBe("fits");
  });

  it("never calls a point that read nothing CHECKED", () => {
    // "has not read anything lately" is not "reads zero", and must not be
    // swept with the readings that were actually looked at.
    expect(fit(null, "V")).toBe("unread");
    expect(fit(Number.NaN, "V")).toBe("unread");
  });

  it("sorts a kind into what fits, what does not, and what could not be checked", () => {
    const c = check([pt(230), pt(99999), pt(null)], "V");
    expect([c.fits.length, c.outside.length, c.unread.length]).toEqual([1, 1, 1]);
  });
});

describe("the walk", () => {
  const volts = pat({ key: "voltage_v", unit: "V", points: [pt(231), pt(229)] });
  const hertz = pat({ key: "frequency_hz", unit: "Hz", points: [pt(50.0), pt(49.9)] });

  it("opens with the kinds whose EVERY reading fits, offered together", () => {
    const [first, ...rest] = questionsOf(cat([volts, hertz]));
    expect(first.type).toBe("accept_all");
    if (first.type !== "accept_all") return;
    expect(first.kinds.map((k) => k.pattern.key)).toEqual(["voltage_v", "frequency_hz"]);
    expect(first.total).toBe(4);
    // And they are not asked about again one by one.
    expect(rest.filter((q) => q.type === "kind")).toEqual([]);
  });

  it("never sweeps a kind with one reading out of range", () => {
    const odd = pat({ key: "current_a", unit: "A", points: [pt(12), pt(88_000)] });
    const qs = questionsOf(cat([volts, hertz, odd]));
    const all = qs[0];
    expect(all.type === "accept_all" && all.kinds.map((k) => k.pattern.key)).not.toContain("current_a");
    expect(qs.find((q) => q.key === "kind:current_a")).toBeDefined();
  });

  it("never sweeps a kind with a point it could not check", () => {
    const quiet = pat({ key: "kw", unit: "kW", points: [pt(40), pt(null)] });
    const all = questionsOf(cat([volts, hertz, quiet]))[0];
    expect(all.type === "accept_all" && all.kinds.map((k) => k.pattern.key)).not.toContain("kw");
  });

  it("asks kind by kind once the operator chooses to go one by one", () => {
    const qs = questionsOf(cat([volts, hertz]), ["accept_all"]);
    expect(qs.map((q) => q.key)).toEqual(["kind:voltage_v", "kind:frequency_hz"]);
  });

  it("asks switches as one question, and never offers them a unit", () => {
    const sw = pat({ key: "state_on_off", kind: "state", unit: null, points: [pt(0), pt(1)] });
    const q = questionsOf(cat([sw])).find((x) => x.type === "state");
    expect(q?.key).toBe("state:state_on_off");
  });

  it("asks a contradiction point by point, with the two readings it could be", () => {
    const amb = pat({
      key: "ambiguous_current_named_in_volts", kind: "ambiguous", unit: null,
      points: [pt(12.4, "CurrL1_V"), pt(11.9, "CurrL2_V")],
    });
    const qs = questionsOf(cat([amb])).filter((q) => q.type === "point");
    expect(qs).toHaveLength(2);
    expect(qs[0].type === "point" && qs[0].choices.map((c) => c.unit)).toEqual(["A", "V"]);
  });

  it("asks about names no convention claims, last, one at a time", () => {
    const qs = questionsOf(cat([volts], [pt(3.2, "Load")]));
    const last = qs[qs.length - 1];
    expect(last.type).toBe("point");
    expect(last.type === "point" && last.pattern).toBeNull();
  });

  it("does not offer a single kind as 'accept all' — that is just the kind", () => {
    expect(questionsOf(cat([volts]))[0].type).toBe("kind");
  });
});

describe("a reading on the screen", () => {
  it("is grouped and trimmed, and a missing one is a dash", () => {
    expect(reading(231.44)).toBe("231.4");
    expect(reading(184220.7)).toBe("184,221");
    expect(reading(0.973)).toBe("0.97");
    expect(reading(null)).toBe("—");
  });
});
