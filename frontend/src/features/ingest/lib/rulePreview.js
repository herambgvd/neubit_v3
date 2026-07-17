// Client-side mirror of the backend rule engine, so a rule can be dry-run BEFORE
// it is saved (the /event-rules/{id}/test endpoint needs a persisted rule id, and
// "save it first, then find out it never matches" is a bad way to write a rule).
//
// Mirrors, deliberately 1:1:
//   backend/ingest/app/ingest/matcher.py    — isEmpty + the five operators
//   backend/ingest/app/ingest/transform.py  — cap.-only nested target assignment
//
// The BACKEND IS AUTHORITATIVE. This is a preview: it resolves simple
// dotted/indexed paths, not the full JMESPath grammar the server runs (filters,
// wildcards, functions). A saved rule should be re-tested through the API, which
// is what this modal does the moment the rule exists.

/** Resolve "a.b[0].c" against an object. Undefined when any link is missing. */
export function resolvePath(obj, path) {
  if (!path) return undefined;
  const re = /([^.[\]]+)|\[(\d+)\]/g;
  let cur = obj;
  let m;
  while ((m = re.exec(path)) !== null) {
    if (cur === null || cur === undefined) return undefined;
    cur = m[1] !== undefined ? cur[m[1]] : cur[Number(m[2])];
  }
  return cur;
}

/** matcher.py `_is_empty`: None/undefined, or a zero-length str/array/object. */
export function isEmpty(v) {
  if (v === null || v === undefined) return true;
  if (typeof v === "string" || Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v).length === 0;
  return false;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/** matcher.py `_evaluate_condition` → { ok, op, path, actual, expected }. */
export function evaluateCondition(payload, condition) {
  const actual = resolvePath(payload, condition.path);
  const expected = condition.value;
  let ok = false;

  switch (condition.op) {
    case "exists":
      ok = !isEmpty(actual);
      break;
    case "not_exists":
      ok = isEmpty(actual);
      break;
    case "equals":
      ok = deepEqual(actual, expected);
      break;
    case "not_equals":
      ok = !deepEqual(actual, expected);
      break;
    case "contains":
      if (typeof actual === "string" && typeof expected === "string") {
        ok = actual.includes(expected);
      } else if (Array.isArray(actual)) {
        ok = actual.some((x) => deepEqual(x, expected));
      } else {
        ok = false;
      }
      break;
    default:
      ok = false; // unknown operator never matches
  }
  return { ok, op: condition.op, path: condition.path, actual, expected };
}

/** matcher.py `evaluate_rule`: no conditions = catch-all; otherwise ALL must hold. */
export function evaluateRule(payload, conditions) {
  const results = (conditions || []).map((c) => evaluateCondition(payload, c));
  return { matched: results.every((r) => r.ok), results };
}

/** transform.py `_assign_target`: cap.* nests, everything else stays flat. */
export function assignPreviewValue(out, target, value) {
  if (!target.startsWith("cap.")) {
    out[target] = value;
    return;
  }
  const tokens = [];
  const re = /([^.[\]]+)|\[(\d+)\]/g;
  let m;
  while ((m = re.exec(target)) !== null) {
    tokens.push(m[1] !== undefined ? m[1] : Number(m[2]));
  }
  if (!tokens.length) return;

  let cur = out;
  tokens.forEach((token, i) => {
    const isLast = i === tokens.length - 1;
    if (isLast) {
      cur[token] = value;
      return;
    }
    const wantArray = typeof tokens[i + 1] === "number";
    const existing = cur[token];
    const rightShape = wantArray ? Array.isArray(existing) : existing && typeof existing === "object" && !Array.isArray(existing);
    if (!rightShape) cur[token] = wantArray ? [] : {};
    cur = cur[token];
  });
}

/**
 * Evaluate an unsaved rule draft against a sample payload.
 * Returns the same shape the /test endpoint does, so the UI renders one way.
 */
export function clientSidePreview(payload, { conditions, fieldMap, eventType }) {
  const { matched, results } = evaluateRule(payload, conditions);

  let extracted = null;
  if (matched && fieldMap && Object.keys(fieldMap).length) {
    extracted = {};
    for (const [target, expr] of Object.entries(fieldMap)) {
      assignPreviewValue(extracted, target, resolvePath(payload, expr));
    }
  }
  return {
    matched,
    condition_results: results,
    extracted,
    event_type: matched ? eventType || null : null,
    // Flags the renderer so it can say the numbers came from the browser.
    _preview: true,
  };
}
