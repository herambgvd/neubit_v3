/**
 * A small reader for the Pydantic response models in `backend/`.
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
