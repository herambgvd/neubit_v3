/**
 * What a rule has to say before it is worth saving.
 *
 * Both of these refuse a rule the BACKEND would happily accept and that would
 * then quietly never do what the operator meant — a condition with no path
 * matches nothing, an equals with no literal matches the empty string, and a
 * repeated output key silently overwrites its twin on the way into the
 * `{key: expression}` object the API takes. The form is the last place any of
 * that is still visible, so it is the place that has to say so.
 */
import { describe, expect, it } from "vitest";

import { conditionProblem, fieldMapProblem } from "./RuleFormModal";
import type { ConditionDraft, FieldMapRow } from "../types";

const cond = (over: Partial<ConditionDraft> = {}): ConditionDraft => ({
  path: "event.type",
  op: "exists",
  value: "",
  _key: "k",
  ...over,
});

const row = (over: Partial<FieldMapRow> = {}): FieldMapRow => ({
  outKey: "door",
  jmespath: "payload.door",
  _key: "k",
  ...over,
});

describe("conditionProblem", () => {
  it("passes a rule with no conditions at all", () => {
    // Deliberate: a rule with no conditions matches any payload, which is a
    // legitimate catch-all and is explained on screen.
    expect(conditionProblem([])).toBeNull();
  });

  it("names the row, 1-based, for a condition with no path", () => {
    expect(conditionProblem([cond(), cond({ path: "" })])).toBe("Condition #2 needs a path");
  });

  it("demands a literal only for the operators that compare against one", () => {
    for (const op of ["equals", "not_equals", "contains"] as const) {
      expect(conditionProblem([cond({ op, value: "" })])).toBe("Condition #1 needs a value");
      expect(conditionProblem([cond({ op, value: "open" })])).toBeNull();
    }
    // exists/not_exists ignore the literal — requiring one would make the two
    // commonest conditions in the console unsaveable.
    expect(conditionProblem([cond({ op: "exists", value: "" })])).toBeNull();
    expect(conditionProblem([cond({ op: "not_exists", value: "" })])).toBeNull();
  });

  it("reports the first problem only", () => {
    expect(conditionProblem([cond({ path: "" }), cond({ op: "equals", value: "" })])).toBe(
      "Condition #1 needs a path",
    );
  });
});

describe("fieldMapProblem", () => {
  it("ignores a wholly blank row", () => {
    // That row is what the Add button leaves behind; rejecting it would make the
    // button itself an error.
    expect(fieldMapProblem([row({ outKey: "  ", jmespath: "" })])).toBeNull();
    expect(fieldMapProblem([])).toBeNull();
  });

  it("rejects a half-filled row from either side", () => {
    expect(fieldMapProblem([row({ outKey: "" })])).toBe("A field-map row is missing its output key");
    expect(fieldMapProblem([row({ jmespath: "" })])).toBe('Field "door" needs a JMESPath expression');
  });

  it("catches a repeated output key, whitespace and all", () => {
    // The second would silently win on the wire, and the operator would still be
    // looking at both rows on screen.
    expect(fieldMapProblem([row(), row({ outKey: " door ", _key: "k2" })])).toBe(
      'Output key " door " is used more than once',
    );
  });

  it("passes a map whose keys are distinct", () => {
    expect(fieldMapProblem([row(), row({ outKey: "card", jmespath: "payload.card", _key: "k2" })])).toBeNull();
  });
});
