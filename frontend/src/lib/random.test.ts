/**
 * THE BIAS IS THE POINT.
 *
 * Swapping Math.random() for crypto bytes is easy to do and easy to get subtly
 * wrong: `byte % n` is uniform only when n divides 256. For a 10-item pool that
 * means the first six are drawn 26/256 of the time and the last four 25/256 — a
 * 4% skew nobody notices and no test catches unless it looks for it.
 *
 * These are statistical, so they are written to fail on a REAL defect and not on
 * an unlucky run: the bounds are wide enough that a correct implementation passes
 * essentially always, and a modulo-biased one fails essentially always.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { randomFraction, randomFrom, randomId, randomInt } from "./random";

describe("randomInt", () => {
  it("stays inside the range", () => {
    for (let i = 0; i < 500; i++) {
      const v = randomInt(7);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(7);
    }
  });

  it("is unbiased across a modulus that does not divide 256", () => {
    // 200, not 10, and that choice is the test.
    //
    // With a modulus of 10 a naive `byte % n` skews the first six values by about
    // 4% — smaller than the noise at any sample size this suite would tolerate, so
    // a test written that way PASSES against the bug it claims to catch. (It did.)
    //
    // 256 = 1x200 + 56, so the same naive implementation returns 0-55 TWICE as
    // often as 56-199: the low block should hold 28% of draws and would hold ~44%.
    // That gap is far outside noise, so this fails on the defect and never on an
    // unlucky run.
    const n = 20_000;
    let low = 0;
    for (let i = 0; i < n; i++) if (randomInt(200) < 56) low++;
    const share = low / n;
    expect(share).toBeGreaterThan(0.24);
    expect(share).toBeLessThan(0.32);
  });

  it("is degenerate but valid for a single-item range", () => {
    expect(randomInt(1)).toBe(0);
  });

  // A one-byte draw only covers max <= 256. Above that the old rejection limit
  // computed to 0, nothing was ever accepted, and the call spun forever — which
  // is how a marketing page (randomInt(1000)) and the playback wall
  // (randomInt(45_000)) both wedged the browser tab with no error in the console.
  it("returns for a range wider than one byte", () => {
    for (const max of [257, 1000, 45_000, 70_000, 16_777_217]) {
      for (let i = 0; i < 200; i += 1) {
        const v = randomInt(max);
        expect(Number.isInteger(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThan(max);
      }
    }
  });

  it("still spreads evenly when the range needs two bytes", () => {
    const max = 1000;
    const n = 20_000;
    let low = 0;
    for (let i = 0; i < n; i += 1) if (randomInt(max) < max / 2) low += 1;
    const share = low / n;
    expect(share).toBeGreaterThan(0.47);
    expect(share).toBeLessThan(0.53);
  });

  // The guard that makes the class of bug above impossible to reintroduce
  // silently. Starve the generator so no draw can ever clear the rejection
  // limit; the old unbounded loop hung the renderer here with no exception, so
  // a test could only catch it by timing out. Now it reports itself.
  it("throws instead of spinning when no draw can be accepted", () => {
    const real = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
    const stub = (a: ArrayBufferView) => {
      new Uint8Array(a.buffer, a.byteOffset, a.byteLength).fill(0xff);
      return a;
    };
    globalThis.crypto.getRandomValues = stub as typeof real;
    try {
      // 0xff…ff is at or above the rejection limit for any max that does not
      // divide the range, so every draw is rejected.
      expect(() => randomInt(1000)).toThrow(/rejection limit/);
    } finally {
      globalThis.crypto.getRandomValues = real;
    }
  });

  it("refuses a range too wide to draw exactly", () => {
    expect(() => randomInt(2 ** 48 + 2)).toThrow(RangeError);
  });

  it("refuses a range that cannot produce a value", () => {
    expect(() => randomInt(0)).toThrow(RangeError);
    expect(() => randomInt(-3)).toThrow(RangeError);
    expect(() => randomInt(2.5)).toThrow(RangeError);
  });
});

describe("randomFraction", () => {
  it("returns the same shape Math.random() does", () => {
    for (let i = 0; i < 500; i++) {
      const v = randomFraction();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("covers both halves of the range", () => {
    // A sign-extension slip would pin everything to one half — which still looks
    // random, and still passes a bounds check.
    const vals = Array.from({ length: 400 }, () => randomFraction());
    expect(vals.some((v) => v < 0.5)).toBe(true);
    expect(vals.some((v) => v >= 0.5)).toBe(true);
  });
});

describe("randomId", () => {
  it("is the requested length", () => {
    expect(randomId(12)).toHaveLength(12);
  });

  it("does not repeat itself", () => {
    // The whole reason these ids moved off Math.random(): two drafts created in
    // the same millisecond must not collide.
    const seen = new Set(Array.from({ length: 2000 }, () => randomId()));
    expect(seen.size).toBe(2000);
  });
});

describe("randomFrom", () => {
  it("only ever returns a member of the list", () => {
    const pool = ["a", "b", "c"];
    for (let i = 0; i < 200; i++) expect(pool).toContain(randomFrom(pool));
  });

  it("reaches every member", () => {
    const pool = ["a", "b", "c"];
    const seen = new Set(Array.from({ length: 300 }, () => randomFrom(pool)));
    expect(seen.size).toBe(3);
  });
});

// EVERY `randomInt` CALL SITE IN THE CONSOLE, DRAWN FOR REAL.
//
// The tests above pin the function. These pin the CALLERS: they read the literal
// argument out of every `randomInt(...)` in src/ and draw from it, so a call site
// added later with a range the function cannot serve fails here rather than in a
// browser tab nobody can get a stack out of. That is not hypothetical — the two
// that existed when this was written, 1000 and 45_000, both hung the tab.
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
