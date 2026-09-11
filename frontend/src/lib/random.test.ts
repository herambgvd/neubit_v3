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
