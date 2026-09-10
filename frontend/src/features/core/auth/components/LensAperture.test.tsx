/**
 * THE SIGN-IN LENS.
 *
 * The hero was a headline, a paragraph of positioning and three stat chips — one
 * of them claiming "−62% false alarms", a number nobody on a sign-in screen can
 * check. A login page exists so somebody can get to work; what it should say about
 * the product is that the product is a camera system, and a lens says that
 * without a word.
 */
import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

let reduced = false;
vi.mock("framer-motion", async () => {
  const actual = await vi.importActual<typeof import("framer-motion")>("framer-motion");
  return { ...actual, useReducedMotion: () => reduced };
});

import LensAperture from "./LensAperture";

describe("the aperture", () => {
  it("turns the BROKEN ring — an unbroken one rotating is invisible", () => {
    const { container } = render(<LensAperture />);
    // Six blades at 60°, which is what makes the rotation read as an iris.
    const blades = [...container.querySelectorAll("path")].filter((p) =>
      /^M-?\d+ -?\d+ L/.test(p.getAttribute("d") || ""),
    );
    expect(blades).toHaveLength(6 + 4); // blades + the four focus marks
  });

  it("keeps something still, or the whole drawing swims", () => {
    const { container } = render(<LensAperture />);
    // The barrel rings and the focus marks are outside every animated group.
    const still = container.querySelectorAll("g:not([style*='transform']) > circle[r='196']");
    expect(still.length).toBeGreaterThan(0);
  });
});

describe("prefers-reduced-motion", () => {
  it("drops the travelling flare entirely", () => {
    reduced = true;
    const { container } = render(<LensAperture />);
    // The flare is the one element that only exists to move; the rest of the lens
    // is still drawn, because the setting asks for less motion, not less page.
    // (Its gradient stays in <defs> — unused defs paint nothing.)
    expect(container.querySelectorAll('path[stroke="url(#nb-lens-flare)"]')).toHaveLength(0);
    expect(container.querySelector("circle[r='158']")).toBeTruthy();
    expect(container.querySelector("circle[r='196']")).toBeTruthy();
    reduced = false;
  });

  it("still draws the lens when it is not moving", () => {
    reduced = true;
    const { container } = render(<LensAperture />);
    expect(container.querySelectorAll("circle").length).toBeGreaterThan(3);
    reduced = false;
  });
});
