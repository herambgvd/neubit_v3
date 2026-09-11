/**
 * A small reader for the Pydantic response models in `backend/`.
 *
 * THIS IS A COPY of `admin-frontend/src/test/pydantic.ts` and must be kept in
 * step with it. It is copied rather than imported because the two consoles are
 * separate npm packages with separate Docker build contexts — a cross-app
 * import would break `next build`. The only addition below is
 * `parseDictKeys`, marked as such: this console has more hand-built dict
 * payloads than the super-admin one and needs a depth-aware reader for them.
 *
 * The contract test compares `src/lib/types.ts` against the models themselves —
 * not against a generated snapshot, which would only be as fresh as the last
 * person to regenerate it. Both files live in this repo, so a field renamed on
 * the backend fails the frontend suite on the same commit.
 *
 * This parses the source text rather than importing anything: the models are
 * Python, and their dependencies (pydantic, sqlalchemy…) are not installable
 * here. The models are plain `name: type = default` declarations, which is what
 * this understands. Anything it cannot parse is reported, never skipped.
 */
import { readFileSync } from "node:fs";

export interface ModelField {
  name: string;
  /** The annotation as written, e.g. `str | None`. */
  type: string;
  /** True when the field has no default, i.e. the server always sends it. */
  required: boolean;
  /** True when the annotation admits None. */
  nullable: boolean;
}

export interface PythonModel {
  name: string;
  bases: string[];
  fields: ModelField[];
}

/** Strip a trailing `# comment`, ignoring `#` inside quotes. */
function stripComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (c === quote && line[i - 1] !== "\\") quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === "#") {
      return line.slice(0, i);
    }
  }
  return line;
}

/** Split `name: type = default` at the top-level `=` (not one inside brackets). */
function splitDefault(rest: string): { type: string; hasDefault: boolean } {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i]!;
    if (quote) {
      if (c === quote && rest[i - 1] !== "\\") quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "=" && depth === 0 && rest[i + 1] !== "=" && rest[i - 1] !== "!") {
      return { type: rest.slice(0, i).trim(), hasDefault: true };
    }
  }
  return { type: rest.trim(), hasDefault: false };
}

// `[ \t]`, not `\s`, either side of the colon: `\s*` and `.+` both match a space,
// so a line with a long run after the colon has many parses and the engine walks
// them. The narrower class leaves nothing to backtrack over.
const FIELD = /^ {4}([A-Za-z_][A-Za-z0-9_]*)[ \t]*:[ \t]*(\S.*)$/;
const CLASS = /^class[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]*(?:\(([^)]*)\))?[ \t]*:/;

/** Every model class in one Python file, keyed by class name. */
export function parseModels(file: string): Map<string, PythonModel> {
  const models = new Map<string, PythonModel>();
  const lines = readFileSync(file, "utf8").split("\n");

  let current: PythonModel | null = null;
  let inDocstring: string | null = null;

  for (const raw of lines) {
    const line = stripComment(raw);

    // Skip docstring bodies wholesale — they can contain anything.
    if (inDocstring) {
      if (line.includes(inDocstring)) inDocstring = null;
      continue;
    }
    const opener = line.match(/("""|''')/);
    if (opener) {
      const marker = opener[1]!;
      const rest = line.slice(line.indexOf(marker) + 3);
      if (!rest.includes(marker)) inDocstring = marker;
      continue;
    }

    const cls = line.match(CLASS);
    if (cls) {
      current = {
        name: cls[1]!,
        bases: (cls[2] || "")
          .split(",")
          .map((b) => b.trim())
          .filter(Boolean),
        fields: [],
      };
      models.set(current.name, current);
      continue;
    }
    if (!current) continue;
    // A non-indented, non-blank line ends the class body.
    if (line.trim() && !/^\s/.test(line)) {
      current = null;
      continue;
    }

    const field = line.match(FIELD);
    if (!field) continue;
    const name = field[1]!;
    if (name === "model_config") continue;

    const { type, hasDefault } = splitDefault(field[2]!);
    // A bare `x: ClassVar[...]`-style or method line would not match FIELD.
    current.fields.push({
      name,
      type,
      required: !hasDefault,
      nullable: /\|\s*None\b/.test(type) || /^Optional\[/.test(type),
    });
  }

  return models;
}

/** A model's own fields plus every base's, nearest definition winning. */
export function resolveFields(
  models: Map<string, PythonModel>,
  name: string
): ModelField[] {
  const model = models.get(name);
  if (!model) throw new Error(`model ${name} not found in the parsed file`);

  const byName = new Map<string, ModelField>();
  for (const base of model.bases) {
    if (!models.has(base)) continue; // BaseModel and friends
    for (const f of resolveFields(models, base)) byName.set(f.name, f);
  }
  for (const f of model.fields) byName.set(f.name, f);
  return [...byName.values()];
}

/**
 * Keys of a `return { "a": ..., "b": ... }` dict literal, for the two
 * infrastructure payloads that are dicts rather than models (ops-agent builds
 * them by hand). Returns the keys of the FIRST return-dict after `marker`.
 */
export function parseReturnedDictKeys(file: string, marker: string): string[] {
  const text = readFileSync(file, "utf8");
  const from = text.indexOf(marker);
  if (from < 0) throw new Error(`marker ${marker} not found in ${file}`);
  const start = text.indexOf("return {", from);
  if (start < 0) throw new Error(`no return-dict after ${marker} in ${file}`);

  let depth = 0;
  let end = start;
  for (let i = text.indexOf("{", start); i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const body = text.slice(start, end);
  return [...body.matchAll(/"([a-z_][a-z0-9_]*)"\s*:/g)].map((m) => m[1]!);
}

/** Keys assigned as `out["key"] = ...` after `marker` — the optional host stats. */
export function parseAssignedDictKeys(file: string, marker: string, varName: string): string[] {
  const text = readFileSync(file, "utf8");
  const from = text.indexOf(marker);
  if (from < 0) throw new Error(`marker ${marker} not found in ${file}`);
  const body = text.slice(from);
  const re = new RegExp(`${varName}\\["([a-z_][a-z0-9_]*)"\\]\\s*=`, "g");
  return [...body.matchAll(re)].map((m) => m[1]!);
}

/* --- operator-console addition (not in admin-frontend's copy) -------------- */

/**
 * TOP-LEVEL keys of the first `{ … }` dict literal at or after `open` (itself
 * searched for after `marker`). Unlike `parseReturnedDictKeys` this ignores
 * nested dicts, which the snapshot/rollup payloads here are full of: a nested
 * `{"total": …, "used": …}` must not be mistaken for a key of the outer object.
 */
/**
 * Drop Python line comments, keeping the text's length and line structure.
 *
 * The scanner below tracks quotes and bracket depth, and a comment is prose: an
 * apostrophe in "the recorder's grants" opens a string it never closes, and a
 * "(see below)" moves the depth. Blanking comments to spaces keeps every offset
 * the same, so the returned slices still line up with the file.
 */
function stripPyComments(text: string): string {
  let out = "";
  let quote: string | null = null;
  let comment = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "\n") {
      comment = false;
      out += c;
      continue;
    }
    if (comment) {
      out += " ";
      continue;
    }
    if (quote) {
      if (c === quote && text[i - 1] !== "\\") quote = null;
      out += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      out += c;
      continue;
    }
    if (c === "#") {
      comment = true;
      out += " ";
      continue;
    }
    out += c;
  }
  return out;
}

export function parseDictKeys(file: string, marker: string, open = "{"): string[] {
  const text = stripPyComments(readFileSync(file, "utf8"));
  const from = text.indexOf(marker);
  if (from < 0) throw new Error(`marker ${marker} not found in ${file}`);
  const at = text.indexOf(open, from);
  if (at < 0) throw new Error(`no ${open} after ${marker} in ${file}`);
  const start = text.indexOf("{", at);
  if (start < 0) throw new Error(`no dict after ${marker} in ${file}`);

  const keys: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  // A `while`, not a `for`: this scanner JUMPS — past a closing quote, and past the
  // whole string it just read. A `for` header that promises `i++` while the body
  // reassigns `i` describes a loop that is not the one running.
  let i = start;
  while (i < text.length) {
    const c = text[i]!;
    if (quote) {
      if (c === quote && text[i - 1] !== "\\") quote = null;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'") {
      if (depth === 1) {
        // A string at depth 1 is a candidate key — keep it if a `:` follows.
        const close = text.indexOf(c, i + 1);
        if (close > 0) {
          const after = text.slice(close + 1).match(/^[ \t\n]*(.)/);
          if (after && after[1] === ":") keys.push(text.slice(i + 1, close));
          i = close + 1;
          continue;
        }
      }
      quote = c;
    } else if (c === "{" || c === "[" || c === "(") depth++;
    else if (c === "}" || c === "]" || c === ")") {
      depth--;
      if (depth === 0) break;
    }
    i += 1;
  }
  if (keys.length === 0) throw new Error(`no keys in the dict after ${marker} in ${file}`);
  return keys;
}

/**
 * Wire names for fields that carry a Pydantic alias — `from_: datetime =
 * Field(alias="from")` is sent and accepted as `from`. Returns field → wire
 * name for one file; fields with no alias are absent. (Also an addition; the
 * super-admin console's models use no aliases.)
 */
export function parseFieldAliases(file: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /^ {4}([A-Za-z_][A-Za-z0-9_]*)\s*:[^\n]*?\b(?:serialization_|validation_)?alias\s*=\s*"([^"]+)"/gm;
  for (const m of readFileSync(file, "utf8").matchAll(re)) out.set(m[1]!, m[2]!);
  return out;
}
