/**
 * Structural guards. These assert properties of the tree itself, so a future edit
 * cannot quietly undo the two decisions this console depends on: it is fully
 * TypeScript, and it never persists a credential in the browser.
 *
 * The file lists are derived by walking `src/`, never hand-maintained.
 */
import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(__dirname, "..");
/** Application sources only — test files and this directory's helpers are exempt. */
const sourceFiles = (files: string[]) =>
  files.filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) && !f.startsWith(path.join(SRC, "test")));
const ROOT = path.resolve(SRC, "..");

/** Drop comments and JSDoc so prose about a rule cannot look like a violation. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (e) => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) return walk(full);
      return [full];
    })
  );
  return files.flat();
}

describe("the console is fully TypeScript", () => {
  it("has no .js or .jsx source file left under src/", async () => {
    const stragglers = (await walk(SRC))
      .filter((f) => /\.jsx?$/.test(f))
      .map((f) => path.relative(ROOT, f));

    // allowJs is off, so a .js file here would not compile — this says so louder.
    expect(stragglers).toEqual([]);
  });

  it("keeps strict on and allowJs off", () => {
    const tsconfig = readFileSync(path.join(ROOT, "tsconfig.json"), "utf8");
    // Comments make this not-quite-JSON, so assert on the text.
    expect(tsconfig).toMatch(/"strict":\s*true/);
    expect(tsconfig).toMatch(/"allowJs":\s*false/);
  });
});

describe("no credential is written to browser storage", () => {
  it("stores nothing token-shaped in localStorage or sessionStorage", async () => {
    const files = sourceFiles(await walk(SRC));

    const offenders: string[] = [];
    for (const file of files) {
      const text = code(readFileSync(file, "utf8"));
      // Storage is used deliberately for two UI preferences (theme, sidebar).
      // Anything else touching storage next to a token/auth word is the bug.
      const writes = text.match(/(local|session)Storage\.setItem\([^)]*\)/g) || [];
      for (const write of writes) {
        if (/token|access|refresh|auth|secret|password|bearer/i.test(write)) {
          offenders.push(`${path.relative(ROOT, file)}: ${write}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("keeps the access token in a module variable, not storage", () => {
    const api = code(readFileSync(path.join(SRC, "lib/api.ts"), "utf8"));

    expect(api).toMatch(/let accessToken: string \| null = null/);
    expect(api).not.toMatch(/localStorage/);
    expect(api).not.toMatch(/sessionStorage/);
    expect(api).not.toMatch(/document\.cookie/);
  });

  it("only ever uses storage for the two UI preferences", async () => {
    const users = sourceFiles(await walk(SRC))
      .filter((f) => /(local|session)Storage/.test(code(readFileSync(f, "utf8"))))
      .map((f) => path.relative(SRC, f))
      .sort();

    // Two preferences across three files: the no-flash script in the root layout
    // and theme.tsx remember light/dark, and the panel layout remembers the
    // collapsed sidebar. A fourth entry needs a deliberate look, not a silent pass.
    expect(users).toEqual([
      "app/(panel)/layout.tsx",
      "app/layout.tsx",
      "components/theme.tsx",
    ]);
  });
});

describe("every route file is a TypeScript component", () => {
  it("names pages page.tsx and layouts layout.tsx", async () => {
    const routeFiles = (await walk(path.join(SRC, "app")))
      .map((f) => path.basename(f))
      .filter((name) => /^(page|layout|template|error|loading|not-found)\./.test(name));

    expect(routeFiles.length).toBeGreaterThan(10);
    for (const name of routeFiles) {
      expect(name).toMatch(/\.tsx$/);
    }
  });
});
