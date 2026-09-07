/**
 * The client-side rule preview is the one place in ingest where a WRONG ANSWER
 * is invisible: it evaluates an unsaved rule against a pasted payload and tells
 * the operator "this matches". If it disagrees with the backend matcher the
 * operator saves a rule that silently never fires in production.
 *
 * So these pin the CONTRACT it mirrors (backend/ingest/app/ingest/matcher.py +
 * transform.py), operator by operator, against the payload shapes a vendor
 * actually sends: a missing field, an explicit null, a nested path, an array
 * index, and a type mismatch between what the payload holds and what the rule
 * expects.
 */
import { describe, expect, it } from "vitest";

import {
  assignPreviewValue,
  clientSidePreview,
  evaluateCondition,
  evaluateRule,
  isEmpty,
  resolvePath,
} from "./rulePreview";
import type { MatchCondition, MatchOp } from "../types";

/** A vendor payload with every awkward shape in it at once. */
const PAYLOAD = {
  device: { name: "Cam-04", mac: "AA:BB", floor: null },
  alarm: { type: "motion", channel: 1, tags: ["intrusion", "night"] },
  events: [{ code: "E1" }, { code: "E2" }],
  empties: { str: "", arr: [], obj: {} },
  zero: 0,
  off: false,
};

describe("resolvePath", () => {
  const cases: [string, string, unknown][] = [
    ["a top-level key", "zero", 0],
    ["a nested key", "device.name", "Cam-04"],
    ["an explicit null", "device.floor", null],
    ["an array index", "events[0].code", "E1"],
    ["a later array index", "events[1].code", "E2"],
    ["an array element itself", "alarm.tags[1]", "night"],
    ["a key that is not there", "device.serial", undefined],
    ["a path that walks through a null", "device.floor.deep", undefined],
    ["a path that walks through a scalar", "zero.deep", undefined],
    ["an index past the end", "events[9].code", undefined],
    ["a false value (not confused with absence)", "off", false],
  ];

  it.each(cases)("resolves %s", (_label, path, expected) => {
    expect(resolvePath(PAYLOAD, path)).toEqual(expected);
  });

  it("treats an absent path as unresolvable rather than as the payload itself", () => {
    expect(resolvePath(PAYLOAD, "")).toBeUndefined();
    expect(resolvePath(PAYLOAD, null)).toBeUndefined();
    expect(resolvePath(PAYLOAD, undefined)).toBeUndefined();
  });
});

describe("isEmpty (matcher.py _is_empty)", () => {
  const cases: [string, unknown, boolean][] = [
    ["undefined", undefined, true],
    ["null", null, true],
    ["the empty string", "", true],
    ["an empty array", [], true],
    ["an empty object", {}, true],
    ["a non-empty string", "x", false],
    ["a non-empty array", [0], false],
    ["a non-empty object", { a: 1 }, false],
    // The two that a naive `!value` gets wrong, and that matter most: a meter
    // reading 0 and a boolean false are PRESENT values, not missing ones.
    ["the number zero", 0, false],
    ["false", false, false],
  ];

  it.each(cases)("says %s is empty=%s", (_label, value, expected) => {
    expect(isEmpty(value)).toBe(expected);
  });
});

/** `evaluateCondition` reduced to its verdict, for table use. */
const verdict = (path: string, op: MatchOp | string, value?: unknown) =>
  evaluateCondition(PAYLOAD, { path, op, value } as MatchCondition).ok;

describe("the five match operators", () => {
  const cases: [string, string, MatchOp | string, unknown, boolean][] = [
    // exists / not_exists are the isEmpty rule, not a key-presence rule.
    ["exists is true for a present value", "device.name", "exists", undefined, true],
    ["exists is true for zero", "zero", "exists", undefined, true],
    ["exists is false for a missing key", "device.serial", "exists", undefined, false],
    ["exists is false for an explicit null", "device.floor", "exists", undefined, false],
    ["exists is false for an empty string", "empties.str", "exists", undefined, false],
    ["exists is false for an empty array", "empties.arr", "exists", undefined, false],
    ["exists is false for an empty object", "empties.obj", "exists", undefined, false],
    ["not_exists mirrors exists on a missing key", "device.serial", "not_exists", undefined, true],
    ["not_exists mirrors exists on a null", "device.floor", "not_exists", undefined, true],
    ["not_exists is false for a present value", "device.name", "not_exists", undefined, false],

    // equals is a VALUE comparison, so a type mismatch never matches.
    ["equals matches an identical string", "device.name", "equals", "Cam-04", true],
    ["equals matches an identical number", "alarm.channel", "equals", 1, true],
    ["equals does not cross number and string", "alarm.channel", "equals", "1", false],
    ["equals does not treat zero as false", "zero", "equals", false, false],
    ["equals compares arrays deeply", "alarm.tags", "equals", ["intrusion", "night"], true],
    ["equals compares objects deeply", "events[0]", "equals", { code: "E1" }, true],
    ["equals is false when the field is missing", "device.serial", "equals", "x", false],

    // not_equals on an absent field is TRUE — a missing field does not equal
    // anything, which is what the backend does and what surprises operators.
    ["not_equals is true for a different value", "device.name", "not_equals", "Cam-05", true],
    ["not_equals is true for a missing field", "device.serial", "not_equals", "x", true],
    ["not_equals is false for an identical value", "device.name", "not_equals", "Cam-04", false],

    // contains works on strings and arrays and NOTHING else.
    ["contains finds a substring", "device.name", "contains", "Cam", true],
    ["contains rejects an absent substring", "device.name", "contains", "Door", false],
    ["contains finds an array member", "alarm.tags", "contains", "night", true],
    ["contains finds an object array member deeply", "events", "contains", { code: "E2" }, true],
    ["contains is false on a number", "alarm.channel", "contains", 1, false],
    ["contains is false when the string is compared to a number", "device.name", "contains", 4, false],
    ["contains is false when the field is missing", "device.serial", "contains", "x", false],

    // Anything the backend does not implement must never match.
    ["an unknown operator never matches", "device.name", "regex", "Cam.*", false],
  ];

  it.each(cases)("%s", (_label, path, op, value, expected) => {
    expect(verdict(path, op, value)).toBe(expected);
  });

  it("reports what it compared, so the preview can show the operator why", () => {
    const r = evaluateCondition(PAYLOAD, { path: "alarm.channel", op: "equals", value: 2 });
    expect(r).toEqual({ ok: false, op: "equals", path: "alarm.channel", actual: 1, expected: 2 });
  });
});

describe("evaluateRule", () => {
  it("treats a rule with no conditions as a catch-all", () => {
    expect(evaluateRule(PAYLOAD, []).matched).toBe(true);
    expect(evaluateRule(PAYLOAD, null).matched).toBe(true);
    expect(evaluateRule(PAYLOAD, undefined).matched).toBe(true);
  });

  it("requires EVERY condition, not any of them", () => {
    const conds: MatchCondition[] = [
      { path: "alarm.type", op: "equals", value: "motion" },
      { path: "device.serial", op: "exists" },
    ];
    const { matched, results } = evaluateRule(PAYLOAD, conds);
    expect(matched).toBe(false);
    // Both are still evaluated, so the operator sees WHICH one failed.
    expect(results.map((r) => r.ok)).toEqual([true, false]);
  });

  it("matches when all conditions hold", () => {
    expect(
      evaluateRule(PAYLOAD, [
        { path: "alarm.type", op: "equals", value: "motion" },
        { path: "device.mac", op: "exists" },
      ]).matched,
    ).toBe(true);
  });
});

describe("assignPreviewValue (transform.py _assign_target)", () => {
  it("keeps a non-cap target flat, dots and all", () => {
    const out: Record<string, unknown> = {};
    assignPreviewValue(out, "device.name", "Cam-04");
    expect(out).toEqual({ "device.name": "Cam-04" });
  });

  it("nests only under the cap. prefix", () => {
    const out: Record<string, unknown> = {};
    assignPreviewValue(out, "cap.motion.state", "on");
    expect(out).toEqual({ cap: { motion: { state: "on" } } });
  });

  it("creates an array when the next token is an index", () => {
    const out: Record<string, unknown> = {};
    assignPreviewValue(out, "cap.zones[0].id", "z1");
    expect(out).toEqual({ cap: { zones: [{ id: "z1" }] } });
  });

  it("merges a second target into the container the first one made", () => {
    const out: Record<string, unknown> = {};
    assignPreviewValue(out, "cap.motion.state", "on");
    assignPreviewValue(out, "cap.motion.level", 3);
    expect(out).toEqual({ cap: { motion: { state: "on", level: 3 } } });
  });

  it("replaces a container of the wrong shape rather than indexing into it", () => {
    const out: Record<string, unknown> = { cap: { zones: "not-an-array" } };
    assignPreviewValue(out, "cap.zones[0]", "z1");
    expect(out).toEqual({ cap: { zones: ["z1"] } });
  });
});

describe("clientSidePreview", () => {
  it("extracts nothing and names no event type when the rule does not match", () => {
    const res = clientSidePreview(PAYLOAD, {
      conditions: [{ path: "alarm.type", op: "equals", value: "tamper" }],
      fieldMap: { title: "device.name" },
      eventType: "alarm.tamper",
    });
    expect(res.matched).toBe(false);
    expect(res.extracted).toBeNull();
    expect(res.event_type).toBeNull();
  });

  it("extracts the field map and names the event type when it matches", () => {
    const res = clientSidePreview(PAYLOAD, {
      conditions: [{ path: "alarm.type", op: "equals", value: "motion" }],
      fieldMap: { title: "device.name", missing: "device.serial", "cap.ch": "alarm.channel" },
      eventType: "alarm.motion",
    });
    expect(res.matched).toBe(true);
    expect(res.event_type).toBe("alarm.motion");
    // A field the payload does not carry resolves to undefined and is REPORTED
    // as such, rather than being dropped — the operator has to see the hole.
    expect(res.extracted).toEqual({ title: "Cam-04", missing: undefined, cap: { ch: 1 } });
    expect(res.extracted && "missing" in res.extracted).toBe(true);
  });

  it("leaves extraction null when a matching rule maps no fields", () => {
    const res = clientSidePreview(PAYLOAD, { conditions: [], fieldMap: {}, eventType: "x" });
    expect(res.matched).toBe(true);
    expect(res.extracted).toBeNull();
  });

  it("flags itself as a browser-computed preview, never as the API's verdict", () => {
    expect(clientSidePreview(PAYLOAD, { conditions: [], fieldMap: {} })._preview).toBe(true);
  });
});
