/**
 * A hand-rolled SVG chart has no library to catch its arithmetic, and every
 * degenerate input here is REAL in this estate:
 *
 *   • a window with no samples in it,
 *   • one bucket (t1 === t0, so the time denominator is zero),
 *   • a perfectly flat series (hi === lo, so the value denominator is zero),
 *   • buckets with a null min/max but a real avg,
 *   • a series living at 1e-21, which is this estate's idea of zero — that one
 *     hung the whole console solid until the tick loop's epsilon was made
 *     relative to its own step.
 *
 * Nothing below asserts a pixel. It asserts the computed model: whether a chart
 * was drawn at all, whether the geometry contains NaN, and what the axis SAYS.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import TrendChart, { type Bucket } from "./TrendChart";

function bucket(over: Partial<Bucket> & { t: string }): Bucket {
  return {
    count: 1,
    min: null,
    max: null,
    avg: null,
    first: null,
    last: null,
    txt_last: null,
    ...over,
  };
}

/** Level buckets one minute apart, band = value unless overridden. */
function series(values: (number | null)[], span = 60_000): Bucket[] {
  return values.map((v, i) =>
    bucket({ t: new Date(1_700_000_000_000 + i * span).toISOString(), min: v, max: v, avg: v }),
  );
}

function draw(buckets: Bucket[]) {
  const { container } = render(<TrendChart buckets={buckets} label="KWH" />);
  const paths = [...container.querySelectorAll("path")].map((p) => p.getAttribute("d") ?? "");
  const ticks = [...container.querySelectorAll("span")]
    .map((s) => s.textContent ?? "")
    .filter(Boolean);
  return { container, paths, ticks };
}

describe("a window with nothing in it", () => {
  it("says there were no samples instead of drawing an empty axis", () => {
    render(<TrendChart buckets={[]} />);
    expect(screen.getByText(/no samples in this window/i)).toBeInTheDocument();
  });

  it("says the same when every bucket exists but carries a null average", () => {
    render(<TrendChart buckets={series([null, null, null])} />);
    expect(screen.getByText(/no samples in this window/i)).toBeInTheDocument();
  });

  it("draws the buckets that DO have a value and ignores the ones that do not", () => {
    const { paths } = draw(series([null, 10, null, 20]));
    expect(paths.join(" ")).not.toContain("NaN");
    expect(screen.queryByText(/no samples/i)).not.toBeInTheDocument();
  });
});

describe("a single bucket", () => {
  it("produces finite geometry despite a zero-width time span", () => {
    const { paths } = draw(series([42]));
    expect(paths.join(" ")).not.toContain("NaN");
    expect(paths.some((d) => d.startsWith("M"))).toBe(true);
  });

  it("gives it a value range to sit in rather than collapsing onto the axis", () => {
    const { ticks } = draw(series([42]));
    // hi === lo would divide by zero; the ±5% pad is what prevents it.
    const numeric = ticks.filter((t) => !/:/.test(t));
    expect(numeric.length).toBeGreaterThan(1);
    expect(new Set(numeric).size).toBe(numeric.length);
  });
});

describe("a perfectly flat series", () => {
  it("labels the axis with distinct numbers, never the same number three times", () => {
    const { ticks, paths } = draw(series([5, 5, 5, 5]));
    const numeric = ticks.filter((t) => !/:/.test(t));
    expect(numeric.length).toBeGreaterThan(1);
    expect(new Set(numeric).size).toBe(numeric.length);
    expect(paths.join(" ")).not.toContain("NaN");
  });

  it("still draws a line for a series pinned at exactly zero", () => {
    const { paths, ticks } = draw(series([0, 0, 0]));
    expect(paths.join(" ")).not.toContain("NaN");
    expect(ticks.some((t) => t === "0")).toBe(true);
  });
});

describe("a series living far below one", () => {
  it("renders 1e-21 without hanging on a tick loop measured in an absolute epsilon", () => {
    // Before the fix this needed ~2e13 iterations and died on array length.
    const { paths, ticks } = draw(series([1e-21, 1.02e-21, 0.98e-21]));
    expect(paths.join(" ")).not.toContain("NaN");
    expect(ticks.length).toBeLessThan(70);
  });

  it("labels such an axis in exponential notation, not as a column of zeros", () => {
    const { ticks } = draw(series([1e-21, 1.02e-21, 0.98e-21]));
    const numeric = ticks.filter((t) => !/:/.test(t));
    expect(numeric.every((t) => /e-/.test(t))).toBe(true);
    expect(new Set(numeric).size).toBe(numeric.length);
  });
});

describe("a bucket whose band is missing", () => {
  it("falls back to the average rather than producing NaN band geometry", () => {
    const buckets = [
      bucket({ t: "2026-01-01T00:00:00Z", avg: 10, min: null, max: null }),
      bucket({ t: "2026-01-01T01:00:00Z", avg: 20, min: null, max: null }),
    ];
    const { paths } = draw(buckets);
    expect(paths.join(" ")).not.toContain("NaN");
    // Two paths: the min→max band and the average line.
    expect(paths).toHaveLength(2);
  });

  it("widens the band to the bucket's own min and max when it has them", () => {
    const wide = [
      bucket({ t: "2026-01-01T00:00:00Z", avg: 10, min: 0, max: 100 }),
      bucket({ t: "2026-01-01T01:00:00Z", avg: 10, min: 0, max: 100 }),
    ];
    const { ticks } = draw(wide);
    const numeric = ticks.filter((t) => !/:/.test(t)).map(Number);
    // The axis has to span the min→max, not just the flat average.
    expect(Math.min(...numeric)).toBeLessThanOrEqual(0);
    expect(Math.max(...numeric)).toBeGreaterThanOrEqual(100);
  });
});

describe("a negative and a mixed-sign series", () => {
  it("keeps the axis around the real range without dropping the sign", () => {
    const { ticks, paths } = draw(series([-40, -10, 20]));
    expect(paths.join(" ")).not.toContain("NaN");
    const numeric = ticks.filter((t) => !/:/.test(t)).map(Number);
    expect(Math.min(...numeric)).toBeLessThan(0);
    expect(Math.max(...numeric)).toBeGreaterThan(0);
  });
});

describe("what the chart is labelled", () => {
  it("names the point the series came from, since no unit can be shown", () => {
    render(<TrendChart buckets={series([1, 2])} label="4FKC2_OWT" />);
    expect(screen.getByLabelText("Trend for 4FKC2_OWT")).toBeInTheDocument();
  });
});
