/**
 * Every icon name in the console must exist in a BUNDLED collection.
 *
 * This failure is invisible. Iconify treats a name it cannot resolve as "not
 * ready yet" — forever — so a wrong name renders as empty space with no error,
 * no fallback and nothing in the console. It is only ever noticed by someone
 * looking at the screen, which is how 13 of them accumulated: heroicons v2 names
 * (`square-3-stack-3d`, `viewfinder-circle`, `exclamation-triangle`) addressed
 * with the v1 `heroicons-outline:` / `heroicons-solid:` prefix, where they have
 * never existed.
 *
 * So the check is structural: scan the source for icon literals and resolve each
 * against the same collections `icons.ts` registers.
 *
 * It can only see NAMES WRITTEN AS LITERALS. A few call sites build a name at
 * runtime (`iconForType(device.device_type)`, the map pin builder) — that is why
 * icons.ts bundles whole collections rather than a scanned subset, and it is also
 * why this test is a floor, not a proof.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import heroicons from "@iconify-json/heroicons/icons.json";
import heroiconsOutline from "@iconify-json/heroicons-outline/icons.json";
import heroiconsSolid from "@iconify-json/heroicons-solid/icons.json";
import svgSpinners from "@iconify-json/svg-spinners/icons.json";

import type { IconifyJSON } from "@iconify/types";

const SRC = path.resolve(__dirname, "..");

const COLLECTIONS: Record<string, IconifyJSON> = {
  heroicons: heroicons as IconifyJSON,
  "heroicons-outline": heroiconsOutline as IconifyJSON,
  "heroicons-solid": heroiconsSolid as IconifyJSON,
  "svg-spinners": svgSpinners as IconifyJSON,
};

/** `heroicons-mini` is synthesized in icons.ts from v2's 16px solid glyphs. */
const MINI_SUFFIX = "-16-solid";

function resolves(prefix: string, name: string): boolean {
  if (prefix === "heroicons-mini") return resolves("heroicons", `${name}${MINI_SUFFIX}`);
  const set = COLLECTIONS[prefix];
  // A prefix nothing registers can never resolve, whatever the name is.
  if (!set) return false;
  return Boolean(set.icons[name] || set.aliases?.[name]);
}

const ICON_LITERAL = /["'`](heroicons(?:-outline|-solid|-mini)?|svg-spinners):([a-z0-9-]+)["'`]/g;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * Comments and JSDoc out, so PROSE ABOUT a bad icon name is not read as a use of
 * one. A comment explaining why `heroicons-outline:h1` does not exist failed this
 * guard, which would teach the next person to stop writing that comment.
 */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** name → the first file that uses it, so a failure says where to look. */
function collectIcons(): Map<string, string> {
  const found = new Map<string, string>();
  for (const file of sourceFiles(SRC)) {
    const text = code(readFileSync(file, "utf8"));
    for (const match of text.matchAll(ICON_LITERAL)) {
      const key = `${match[1]}:${match[2]}`;
      if (!found.has(key)) found.set(key, path.relative(SRC, file));
    }
  }
  return found;
}

describe("every icon the console names is in the bundle", () => {
  const icons = collectIcons();

  it("finds the icon literals at all — a scan that matches nothing proves nothing", () => {
    expect(icons.size).toBeGreaterThan(150);
  });

  it("resolves every one of them offline", () => {
    const broken = [...icons]
      .filter(([key]) => !resolves(key.split(":")[0], key.split(":").slice(1).join(":")))
      .map(([key, file]) => `${key}  ←  ${file}`);

    expect(broken, "these render as blank space, silently").toEqual([]);
  });
});
