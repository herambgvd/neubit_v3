// CALCULATED FIELDS — post-query arithmetic over a result, in the browser.
//
// PORTED from the reference's `lib/dashboard/calc-fields.ts` (199 lines): a tiny
// recursive-descent parser for `+ - * / ( )`, unary minus, numeric literals and
// column names, compiled to an AST and evaluated per row. **No `eval`**, which is
// the good decision in that file and the one worth keeping verbatim.
//
// WHY THIS IS SAFE HERE, AND WHY IT STAYS CLIENT-SIDE
// ---------------------------------------------------
// A calculated field never touches SQL. It runs over the `{columns, rows}` the
// executor already returned, so the query that ran is exactly the query the
// builder generated from state — a formula cannot widen a scope, cross a tenant,
// or reach a column the widget did not select. That property is the whole reason
// this can be a free-text expression box when nothing else in this module is one,
// and it is why it must not migrate to the server later as a convenience.
//
// TWO CHANGES, BOTH ABOUT CONTRACT §4
// -----------------------------------
// 1. **NULL PROPAGATES. It is never 0.** Theirs does `const v = Number(row[idx]);
//    return Number.isNaN(v) ? 0 : v` — so a bucket in which a series did not
//    report contributes a zero, and `a - b` over a missing `b` silently returns
//    `a` as though `b` had been measured at nothing. Absence renders as absence
//    on this platform, so a missing operand makes the whole cell null and the
//    charts draw the gap they already draw for a missing measure.
// 2. **Division by zero is null, not an error and not Infinity** — matching what
//    the SQL generator already does with `nullif(…, 0)` for a ratio measure. One
//    rule for "no denominator", wherever the division happens.
//
// One addition: `unknownColumns`, so the editor can say WHICH name it did not
// recognise while you are typing, rather than the field silently not appearing.

import type { ChartData, Cell } from "./charts/types";

/** One author-defined column. Stored in `spec.options.calc_fields`; presentation
 *  only, never seen by the backend. */
export interface CalcField {
  /** The column name it appears under. */
  name: string;
  /** `+ - * / ( )`, numbers, and column names. Nothing else parses. */
  formula: string;
}

export const MAX_CALC_FIELDS = 4;

type Token =
  | { type: "num"; value: number }
  | { type: "ident"; value: string }
  | { type: "+" | "-" | "*" | "/" | "(" | ")" };

type Node =
  | { op: "num"; value: number }
  | { op: "col"; name: string }
  | { op: "neg"; arg: Node }
  | { op: "add" | "sub" | "mul" | "div"; left: Node; right: Node };

// A column name may contain spaces and punctuation (the executor names a column
// after a measure's LABEL — "Reading value"), so a bare identifier is not enough.
// `[name]` is the escape, and it is what the editor's chips insert.
const TOKEN_RE = /\s*(?:(\d+(?:\.\d+)?)|\[([^\]]+)\]|([A-Za-z_][A-Za-z0-9_]*)|(.))/g;

function tokenize(formula: string): Token[] {
  const tokens: Token[] = [];
  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(formula)) !== null) {
    if (m[0].trim() === "") break;
    if (m[1] !== undefined) tokens.push({ type: "num", value: Number(m[1]) });
    else if (m[2] !== undefined) tokens.push({ type: "ident", value: m[2].trim() });
    else if (m[3] !== undefined) tokens.push({ type: "ident", value: m[3] });
    else if (m[4] && "+-*/()".includes(m[4])) tokens.push({ type: m[4] as "+" });
    else if (m[4] !== undefined && m[4].trim() !== "") throw new Error(`Unexpected character “${m[4]}”`);
  }
  return tokens;
}

export function parseFormula(formula: string): Node {
  if (!formula || !formula.trim()) throw new Error("Empty formula");
  const tokens = tokenize(formula);
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  function expr(): Node {
    let left = term();
    for (let t = peek(); t && (t.type === "+" || t.type === "-"); t = peek()) {
      const op = next()!.type === "+" ? "add" : "sub";
      left = { op, left, right: term() };
    }
    return left;
  }
  function term(): Node {
    let left = factor();
    for (let t = peek(); t && (t.type === "*" || t.type === "/"); t = peek()) {
      const op = next()!.type === "*" ? "mul" : "div";
      left = { op, left, right: factor() };
    }
    return left;
  }
  function factor(): Node {
    const t = peek();
    if (t && t.type === "-") {
      next();
      return { op: "neg", arg: factor() };
    }
    if (t && t.type === "+") {
      next();
      return factor();
    }
    return primary();
  }
  function primary(): Node {
    const t = next();
    if (!t) throw new Error("The formula ends unexpectedly");
    if (t.type === "num") return { op: "num", value: t.value };
    if (t.type === "ident") return { op: "col", name: t.value };
    if (t.type === "(") {
      const inner = expr();
      const close = next();
      if (!close || close.type !== ")") throw new Error("Missing a closing bracket");
      return inner;
    }
    throw new Error("Unexpected token");
  }

  const ast = expr();
  if (pos !== tokens.length) throw new Error("Unexpected text after the formula");
  return ast;
}

/** Every column name a formula reads. */
export function referencedColumns(ast: Node, out: Set<string> = new Set()): Set<string> {
  switch (ast.op) {
    case "col":
      out.add(ast.name);
      break;
    case "neg":
      referencedColumns(ast.arg, out);
      break;
    case "add":
    case "sub":
    case "mul":
    case "div":
      referencedColumns(ast.left, out);
      referencedColumns(ast.right, out);
      break;
  }
  return out;
}

/** Evaluate against one row. NULL PROPAGATES — see the module note. */
function evalNode(node: Node, row: Cell[], index: Record<string, number>): number | null {
  switch (node.op) {
    case "num":
      return node.value;
    case "col": {
      const i = index[node.name];
      if (i === undefined) throw new Error(`No column named “${node.name}”`);
      const v = row[i];
      // A missing measure stays MISSING. Coercing it to 0 (as the reference does)
      // makes `a - b` return `a` when b was never measured — a fabricated number
      // wearing the shape of a real one.
      if (v === null || v === undefined || typeof v !== "number" || !Number.isFinite(v)) return null;
      return v;
    }
    case "neg": {
      const a = evalNode(node.arg, row, index);
      return a === null ? null : -a;
    }
    default: {
      const l = evalNode(node.left, row, index);
      const r = evalNode(node.right, row, index);
      if (l === null || r === null) return null;
      if (node.op === "add") return l + r;
      if (node.op === "sub") return l - r;
      if (node.op === "mul") return l * r;
      // No denominator is NULL — the same rule `sqlgen` applies with
      // `nullif(…, 0)` for a ratio measure, so a division means one thing on this
      // platform wherever it happens.
      if (r === 0) return null;
      const q = l / r;
      return Number.isFinite(q) ? q : null;
    }
  }
}

/** Validate a formula against a result's columns. Returns an error string, or
 *  null when it is usable. Naming the unknown column is the whole value here. */
export function validateFormula(formula: string, columns: string[]): string | null {
  try {
    const ast = parseFormula(formula);
    const known = new Set(columns);
    const missing = [...referencedColumns(ast)].filter((c) => !known.has(c));
    if (missing.length) {
      return `This result has no column named ${missing.map((m) => `“${m}”`).join(", ")}.`;
    }
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** Append the calculated columns to a chart result.
 *
 *  A field whose formula does not parse, or which names a column this result does
 *  not have, is SKIPPED — the widget still draws what it measured. It is not
 *  filled with zeros, and it does not take the whole widget down: a broken
 *  formula should cost you the column you were adding, not the chart you had. */
export function applyCalcFields(data: ChartData, fields?: CalcField[] | null): ChartData {
  if (!fields?.length) return data;
  const index: Record<string, number> = {};
  data.columns.forEach((c, i) => {
    index[c] = i;
  });

  const compiled: { name: string; ast: Node }[] = [];
  for (const f of fields.slice(0, MAX_CALC_FIELDS)) {
    if (!f?.name?.trim() || !f?.formula?.trim()) continue;
    if (index[f.name] !== undefined) continue; // never shadow a real column
    try {
      const ast = parseFormula(f.formula);
      if ([...referencedColumns(ast)].some((c) => index[c] === undefined)) continue;
      compiled.push({ name: f.name.trim(), ast });
    } catch {
      /* a formula that does not parse costs its own column, nothing more */
    }
  }
  if (!compiled.length) return data;

  return {
    ...data,
    columns: [...data.columns, ...compiled.map((c) => c.name)],
    rows: data.rows.map((row) => [
      ...row,
      ...compiled.map((c) => {
        try {
          return evalNode(c.ast, row, index);
        } catch {
          return null;
        }
      }),
    ]),
    // A calculated column has NO aggregate. `undefined` would mean "unknown" for
    // the whole array; `null` per column means "this one is not an aggregate",
    // which is what stops a pie chart claiming a derived column sums to a whole.
    aggregates: data.aggregates ? [...data.aggregates, ...compiled.map(() => null)] : undefined,
  };
}
