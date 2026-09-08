/**
 * The stylesheet is built from Sass MODULES, not `@import`.
 *
 * Sass's `@import` is deprecated and is removed in Dart Sass 3.0. Until this was
 * migrated, every dev rebuild printed a paragraph of deprecation warning per
 * partial — twenty-six of them, with a webpack loader trace attached to each —
 * which is how a real warning goes unread.
 *
 * The migration is not just a keyword swap, and that is why this test exists:
 * `@use` cannot sit inside a rule and a module's CSS lands at the top level, so
 * every partial has to carry its OWN `@layer`. A partial that loses its layer
 * still compiles and still ships its rules — into the unlayered bucket, which
 * beats every layer in the cascade. That is a silent visual regression, so both
 * halves are checked here.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const SCSS = path.resolve(__dirname);

function scssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return scssFiles(full);
    return full.endsWith(".scss") ? [full] : [];
  });
}

const FILES = scssFiles(SCSS);
const rel = (f: string) => path.relative(SCSS, f);

/** Strip comments so a `@import` inside prose is not read as code. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("the Sass entry is built from modules", () => {
  it("scans the real stylesheet tree", () => {
    // A glob that silently matches nothing would make every assertion below pass.
    expect(FILES.length).toBeGreaterThan(20);
    expect(FILES.map(rel)).toContain("app.scss");
  });

  it("imports no Sass partial anywhere", () => {
    const offenders = FILES.flatMap((f) => {
      const imports = [...code(readFileSync(f, "utf8")).matchAll(/@import\s+["']([^"']+)["']/g)];
      // A plain CSS import is NOT deprecated: Sass passes `.css` through
      // untouched, which is how Tailwind's entry reaches PostCSS.
      return imports.filter((m) => !m[1].endsWith(".css")).map((m) => `${rel(f)} → ${m[1]}`);
    });
    expect(offenders).toEqual([]);
  });

  it("gives every partial its own cascade layer", () => {
    // Partials, not the entry: app.scss is a module list and declares no rules.
    const partials = FILES.filter((f) => path.basename(f).startsWith("_"));
    const unlayered = partials
      .filter((f) => {
        const body = code(readFileSync(f, "utf8"));
        // A file holding only variables or only a CSS passthrough emits no rules.
        const hasRules = /\{/.test(body.replace(/@use[^;]*;/g, ""));
        const declaresVariablesOnly = body.trim().split("\n").every((l) => !l.trim() || l.trim().startsWith("$"));
        return hasRules && !declaresVariablesOnly && !/@layer\s+\w+\s*\{/.test(body);
      })
      .map(rel);
    expect(unlayered).toEqual([]);
  });

  it("loads the Tailwind entry first, so its @import stays first in the output", () => {
    // CSS requires @import before any rule. With the partials loaded as modules,
    // the only thing that keeps it there is being the first module app.scss uses.
    const uses = [...code(readFileSync(path.join(SCSS, "app.scss"), "utf8")).matchAll(/@use\s+["']([^"']+)["']/g)].map(
      (m) => m[1],
    );
    expect(uses[0]).toBe("tailwind-entry");
    // And the heading reset must stay last: it shares the components layer with
    // the partials, so it only wins by being emitted after them.
    expect(uses[uses.length - 1]).toBe("headings");
  });
});
