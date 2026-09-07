/**
 * The scatter draws the exact pairs the coefficient was computed from, so its
 * only job is not to lie about the domain. The interesting inputs are the
 * degenerate ones: no aligned buckets at all, one bucket (every extent is a
 * point), and an axis that never moved (hi === lo, a zero denominator).
 *
 * Assertions are on the axis extremes the component PRINTS and on whether the
 * circle geometry is finite — never on where a dot landed.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import Scatter, { type ScatterSample } from "./Scatter";

const at = (i: number, a: number, b: number): ScatterSample => ({
  t: new Date(1_700_000_000_000 + i * 3_600_000).toISOString(),
  a,
  b,
});

function plot(samples: ScatterSample[]) {
  const { container } = render(<Scatter samples={samples} xLabel="KWH" yLabel="OWT" />);
  const dots = [...container.querySelectorAll("circle")];
  const axis = [...container.querySelectorAll("text")].map((t) => t.textContent ?? "");
  const coords = dots.flatMap((c) => [c.getAttribute("cx") ?? "", c.getAttribute("cy") ?? ""]);
  return { dots, axis, coords };
}

describe("no aligned buckets", () => {
  it("says there is nothing to plot instead of drawing an empty frame", () => {
    render(<Scatter samples={[]} />);
    expect(screen.getByText(/no aligned buckets to plot/i)).toBeInTheDocument();
  });
});

describe("a single aligned bucket", () => {
  it("plots it with finite coordinates despite every extent being one point", () => {
    const { dots, coords } = plot([at(0, 5, 9)]);
    expect(dots).toHaveLength(1);
    expect(coords.every((v) => Number.isFinite(Number(v)))).toBe(true);
  });

  it("gives the axis a ±1 range so the single point is not on a zero-width scale", () => {
    const { axis } = plot([at(0, 5, 9)]);
    expect(axis).toContain("4");
    expect(axis).toContain("6");
    expect(axis).toContain("8");
    expect(axis).toContain("10");
  });
});

describe("a series that never moved on one axis", () => {
  it("keeps that axis finite rather than dividing by a zero range", () => {
    // A frozen X against a moving Y: the caller decides whether to render the
    // coefficient, but the picture must not become NaN geometry.
    const { coords } = plot([at(0, 5, 1), at(1, 5, 2), at(2, 5, 3)]);
    expect(coords.every((v) => Number.isFinite(Number(v)))).toBe(true);
  });
});

describe("the axis extremes it prints", () => {
  it("pads the real min and max rather than clipping a point off the edge", () => {
    const { axis } = plot([at(0, 0, 0), at(1, 100, 50)]);
    const numbers = axis.map(Number).filter((n) => Number.isFinite(n));
    expect(Math.min(...numbers)).toBeLessThan(0);
    expect(Math.max(...numbers)).toBeGreaterThan(100);
  });

  it("names the two point tags it is comparing, since no unit can be shown", () => {
    const { axis } = plot([at(0, 1, 2), at(1, 3, 4)]);
    expect(axis).toContain("KWH");
    expect(axis).toContain("OWT");
  });
});

describe("every sample", () => {
  it("is drawn — none is dropped or merged into another", () => {
    const { dots } = plot([at(0, 1, 1), at(1, 2, 2), at(2, 3, 3), at(3, 4, 4)]);
    expect(dots).toHaveLength(4);
  });

  it("carries its own timestamp and values in a title, so a dot is identifiable", () => {
    const { dots } = plot([at(0, 1.5, 2.5)]);
    expect(dots[0].querySelector("title")?.textContent).toMatch(/1\.5 \/ 2\.5/);
  });
});
