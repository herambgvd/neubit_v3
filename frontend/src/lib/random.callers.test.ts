// EVERY `randomInt` CALL SITE IN THE CONSOLE, DRAWN FOR REAL.
//
// `randomInt` once hung for any max above 256: the rejection limit computed to
// 0, no draw was ever accepted, and the loop spun the renderer at 100% with no
// exception and nothing in the console. Two call sites were over that line — the
// landing page's event feed (1000) and the playback wall's chunk jitter
// (45_000) — and both froze the tab for anyone who opened the page.
//
// The unit tests above pin the function. This one pins the CALLERS: it reads
// the literal argument out of every `randomInt(...)` in src/ and draws from it,
// so a call site added later with a range the function cannot serve fails here
// rather than in a browser tab nobody can get a stack out of.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { randomInt } from "./random";

const SRC = join(__dirname, "..");

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) yield full;
  }
}

/** `randomInt(1000)` and `randomInt(CHUNK_JITTER_MS)` alike — the constant is
 *  resolved from its `const NAME = <number>` declaration in the same file. */
function callSites(): { file: string; max: number }[] {
  const found: { file: string; max: number }[] = [];
  for (const file of walk(SRC)) {
    if (file.endsWith(join("lib", "random.ts"))) continue;
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/randomInt\(\s*([A-Za-z0-9_]+)\s*\)/g)) {
      const arg = m[1];
      if (/^\d[\d_]*$/.test(arg)) {
        found.push({ file, max: Number(arg.replaceAll("_", "")) });
        continue;
      }
      const decl = new RegExp(`const\\s+${arg}\\s*=\\s*([\\d_]+)`).exec(text);
      if (decl) found.push({ file, max: Number(decl[1].replaceAll("_", "")) });
    }
  }
  return found;
}

describe("randomInt call sites", () => {
  it("finds the ones this console actually has", () => {
    // If this drops to zero the scan has stopped matching and the test below is
    // passing vacuously.
    expect(callSites().length).toBeGreaterThanOrEqual(2);
  });

  it("can draw every range the console asks for", () => {
    for (const { file, max } of callSites()) {
      for (let i = 0; i < 50; i += 1) {
        const v = randomInt(max);
        expect(v, `${file} draws randomInt(${max})`).toBeGreaterThanOrEqual(0);
        expect(v, `${file} draws randomInt(${max})`).toBeLessThan(max);
      }
    }
  });
});
