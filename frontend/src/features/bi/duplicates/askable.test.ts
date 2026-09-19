/**
 * Duplicates as a queue of questions.
 *
 * The rule the whole screen rests on: this file DESCRIBES the records and
 * RECOMMENDS nothing. A gateway is sometimes rebuilt because a sensor was
 * replaced, and then the young record is the real one — so "keep the older /
 * longer / bigger one" is a guess about a building, and the operator makes it.
 */
import { describe, expect, it } from "vitest";

import {
  daysLabel,
  daysOf,
  questionsOf,
  readingsLabel,
  toQuestion,
  type GhostGroup,
  type GhostMember,
} from "./askable";

const member = (over: Partial<GhostMember> = {}): GhostMember => ({
  point_id: "p1",
  first_seen_at: "2026-01-02T11:05:00Z",
  last_seen_at: "2026-09-11T16:16:00Z",
  readings: 331_440,
  unit: null,
  fresh: false,
  has_role: false,
  role: null,
  ...over,
});

const group = (members: GhostMember[], over: Partial<GhostGroup> = {}): GhostGroup => ({
  device_tag: "1F Khem Chiller02",
  point_tag: "1FKC2_Total KW",
  category: "hvac",
  mode: "manual",
  survivor_point_id: null,
  members,
  ...over,
});

const OLD = member();
const NEW = member({
  point_id: "p2",
  first_seen_at: "2026-06-03T09:40:00Z",
  last_seen_at: "2026-09-11T17:12:00Z",
  readings: 146_220,
});

describe("what a record carries", () => {
  it("counts the days between its first and its last reading", () => {
    expect(daysOf(OLD)).toBe(252);
    expect(daysOf(NEW)).toBe(100);
  });

  it("says NOT KNOWN rather than zero when a timestamp is missing", () => {
    // Zero days would read as "this record never ran", which is a claim about
    // the sensor. The absence is about the READ.
    expect(daysOf(member({ first_seen_at: null }))).toBeNull();
    expect(daysOf(member({ last_seen_at: undefined }))).toBeNull();
    expect(daysLabel(null)).toBe("not known");
    expect(readingsLabel(null)).toBe("not known");
  });

  it("keeps a reading count exact until it stops being readable", () => {
    // "9,999" is a fact; "10k" is a rounding, and only worth it once the exact
    // figure stops telling an operator anything.
    expect(readingsLabel(9_999)).toBe("9,999");
    expect(readingsLabel(146_220)).toBe("146k");
    expect(readingsLabel(2_400_000)).toBe("2.4M");
  });

  it("calls a record that ran and stopped inside a day what it is", () => {
    const sameDay = member({ first_seen_at: "2026-09-11T08:00:00Z", last_seen_at: "2026-09-11T17:00:00Z" });
    expect(daysOf(sameDay)).toBe(0);
    expect(daysLabel(0)).toBe("under a day");
  });
});

describe("the question", () => {
  it("offers the records newest-first, lettered for the keyboard", () => {
    const q = toQuestion(group([OLD, NEW]));
    expect(q.choices.map((c) => c.letter)).toEqual(["A", "B"]);
    expect(q.choices.map((c) => c.point_id)).toEqual(["p2", "p1"]);
  });

  it("marks what is TRUE of each record, and nothing about what to do", () => {
    const [a, b] = toQuestion(group([OLD, NEW])).choices;
    expect(a.latest).toBe(true);
    expect(a.mostHistory).toBe(false);
    expect(b.mostHistory).toBe(true);
    expect(b.latest).toBe(false);
    // No field on a choice says "pick me".
    expect(Object.keys(a)).not.toContain("recommended");
  });

  it("marks a tie on both records rather than picking one", () => {
    const twin = member({ point_id: "p3" });
    const [a, b] = toQuestion(group([OLD, twin])).choices;
    expect([a.mostHistory, b.mostHistory]).toEqual([true, true]);
  });

  it("says why it is being asked — nothing live, or several live", () => {
    expect(toQuestion(group([OLD, NEW])).because).toBe("none_live");
    expect(toQuestion(group([OLD, member({ point_id: "p9", fresh: true })])).because).toBe(
      "several_live",
    );
  });

  it("names the metric that reads a record, so losing sight of it is deliberate", () => {
    const bound = member({ point_id: "p4", has_role: true, role: "active_power" });
    const [a] = toQuestion(group([bound])).choices;
    expect(a.role).toBe("active_power");
    expect(toQuestion(group([OLD])).choices[0].role).toBeNull();
  });
});

describe("the queue", () => {
  it("asks only about the groups that need a person", () => {
    // An `auto` group is one the data already settled: exactly one record is
    // still delivering. Asking a person to confirm that turns a 45-question
    // queue into a 46-question one.
    const qs = questionsOf([
      group([OLD, NEW]),
      group([OLD, NEW], { mode: "auto", point_tag: "OTHER", survivor_point_id: "p2" }),
    ]);
    expect(qs).toHaveLength(1);
    expect(qs[0].point_tag).toBe("1FKC2_Total KW");
  });

  it("keys a question by the register it is about", () => {
    const [q] = questionsOf([group([OLD, NEW])]);
    expect(q.key).toContain("1F Khem Chiller02");
    expect(q.key).toContain("1FKC2_Total KW");
  });
});

describe("where each copy sits in time", () => {
  it("draws both on ONE axis, so the rebuild is visible", () => {
    const [a, b] = toQuestion(group([OLD, NEW])).choices;
    // B started the axis; A started at the June rebuild, a little over half-way.
    expect(b.span?.left).toBe(0);
    expect(a.span!.left).toBeGreaterThan(55);
    expect(a.span!.left).toBeLessThan(65);
    // Both run to the same end.
    expect(a.span!.left + a.span!.width).toBeCloseTo(100, 0);
    expect(b.span!.left + b.span!.width).toBeCloseTo(100, 0);
  });

  it("keeps a copy that lived for hours visible on a months-long axis", () => {
    const blip = member({ point_id: "p5", first_seen_at: "2026-09-11T08:00:00Z", last_seen_at: "2026-09-11T09:00:00Z" });
    const [, , c] = toQuestion(group([OLD, NEW, blip])).choices;
    expect(c.span!.width).toBeGreaterThanOrEqual(1.5);
    expect(c.span!.left + c.span!.width).toBeLessThanOrEqual(100);
  });

  it("draws nothing for a copy whose start is not known, even beside one that has an axis", () => {
    // The sibling's dates give the group an axis. That must not become a place
    // to draw this copy from a guess about where it started.
    const unknown = member({ point_id: "p6", first_seen_at: null, last_seen_at: "2026-09-12T00:00:00Z" });
    const choices = toQuestion(group([OLD, unknown])).choices;
    expect(choices.find((c) => c.point_id === "p6")!.span).toBeNull();
    expect(choices.find((c) => c.point_id === "p1")!.span).not.toBeNull();
  });
});
