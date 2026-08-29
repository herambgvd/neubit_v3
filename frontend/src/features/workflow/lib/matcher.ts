// Client-side mirror of the backend trigger matcher
// (backend/workflow/app/workflow/correlation.py :: matches_conditions). Pure
// functions, no side effects — used by the conditions preview + trigger test
// modal to evaluate an AND-list of conditions against a sample event envelope
// WITHOUT hitting the API.
//
// v3 condition shape is { path, op, value } (a v2 condition uses { field,
// operator, value } — both are accepted so the same helpers can back either).
//
// Operators (keep in sync with backend):
//   eq, ne, gt, gte, lt, lte, in, not_in, contains, starts_with,
//   ends_with, regex, exists

export const MATCHER_OPS = [
  "eq", "ne", "gt", "gte", "lt", "lte", "in", "not_in",
  "contains", "starts_with", "ends_with", "regex", "exists",
];

export const OP_LABEL = {
  eq: "equals",
  ne: "not equals",
  gt: "greater than",
  gte: "greater or equal",
  lt: "less than",
  lte: "less or equal",
  in: "in list",
  not_in: "not in list",
  contains: "contains",
  starts_with: "starts with",
  ends_with: "ends with",
  regex: "matches regex",
  exists: "exists",
};

const condPath = (c) => c.path ?? c.field ?? "";
const condOp = (c) => c.op ?? c.operator ?? "eq";

// Dot-path lookup into the envelope. Supports numeric array indices.
export function walk(envelope, path) {
  if (!path) return undefined;
  let cur = envelope;
  for (const part of String(path).split(".")) {
    if (cur && typeof cur === "object" && !Array.isArray(cur)) {
      cur = cur[part];
    } else if (Array.isArray(cur)) {
      const idx = Number(part);
      cur = Number.isFinite(idx) ? cur[idx] : undefined;
    } else {
      return undefined;
    }
    if (cur === undefined || cur === null) return cur;
  }
  return cur;
}

export function evalOp(actual, op, expected) {
  try {
    switch (op) {
      case "eq":
        return actual === expected || actual == expected; // eslint-disable-line eqeqeq
      case "ne":
        return actual !== expected && actual != expected; // eslint-disable-line eqeqeq
      case "gt":
        return actual != null && actual > expected;
      case "gte":
        return actual != null && actual >= expected;
      case "lt":
        return actual != null && actual < expected;
      case "lte":
        return actual != null && actual <= expected;
      case "in":
        return Array.isArray(expected) && expected.includes(actual);
      case "not_in":
        return Array.isArray(expected) && !expected.includes(actual);
      case "contains":
        if (typeof actual === "string")
          return typeof expected === "string" && actual.includes(expected);
        if (Array.isArray(actual)) return actual.includes(expected);
        return false;
      case "starts_with":
        return (
          typeof actual === "string" &&
          typeof expected === "string" &&
          actual.startsWith(expected)
        );
      case "ends_with":
        return (
          typeof actual === "string" &&
          typeof expected === "string" &&
          actual.endsWith(expected)
        );
      case "regex":
        if (typeof actual !== "string") return false;
        try {
          return new RegExp(String(expected)).test(actual);
        } catch {
          return false;
        }
      case "exists":
        return (actual !== undefined && actual !== null) === Boolean(expected);
      default:
        return false;
    }
  } catch {
    return false;
  }
}

// Evaluate an AND-list of conditions against an envelope.
// Returns { rows: [{ condition, actual, matched }], allMatch }.
export function evaluateConditions(envelope, conditions) {
  const rows = (conditions || []).map((c) => {
    const actual = walk(envelope, condPath(c));
    const matched = evalOp(actual, condOp(c), c.value);
    return { condition: c, actual, matched };
  });
  const allMatch = rows.length === 0 ? true : rows.every((r) => r.matched);
  return { rows, allMatch };
}

// Coerce user-typed condition text into the shape the backend expects.
//   in / not_in : comma-separated → array (each item JSON-parsed when possible)
//   exists      : boolean
//   else        : JSON.parse when possible, else the raw string.
export function coerceValue(op, raw) {
  if (op === "exists") {
    if (typeof raw === "boolean") return raw;
    return raw === true || raw === "true" || raw === 1 || raw === "1";
  }
  if (op === "in" || op === "not_in") {
    if (Array.isArray(raw)) return raw;
    return String(raw ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((s) => {
        try {
          return JSON.parse(s);
        } catch {
          return s;
        }
      });
  }
  if (raw === "" || raw === null || raw === undefined) return raw ?? "";
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

// Stringify a stored condition value back into editor text.
export function stringifyValue(op, value) {
  if (op === "exists") {
    return value === true || value === "true" ? "true" : "false";
  }
  if (op === "in" || op === "not_in") {
    if (Array.isArray(value)) {
      return value
        .map((v) => (typeof v === "string" ? v : JSON.stringify(v)))
        .join(", ");
    }
  }
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
