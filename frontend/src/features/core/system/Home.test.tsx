/**
 * THE LAUNCHER'S LENS.
 *
 * The backdrop drew an aperture and left it perfectly still — the one thing a lens
 * is never doing. It moves now, and two properties are worth holding: the motion
 * is CLASS-DRIVEN (so `prefers-reduced-motion` can stop all of it in one CSS rule
 * rather than each animation having its own escape), and the aperture itself is
 * still DRAWN when it stops, because that setting asks for less motion, not less
 * page.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders as render } from "@/test/render";
import { stubApi } from "@/test/apiStub";
import Home from "./Home";

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ can: () => true, hasModule: () => true, user: null }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/home",
  useSearchParams: () => new URLSearchParams(""),
}));

// The launcher counts cameras and alarms on its tiles; this suite is about the
// backdrop behind them.
stubApi({
  "GET /vms/cameras": { items: [], total: 0 },
  "GET /vms/federation/cameras": { items: [], total: 0 },
  "GET /vms/events": { items: [], total: 0 },
  "GET /workflow/instances": { items: [], total: 0 },
});

const theme = readFileSync(
  path.join(process.cwd(), "src/styles/theme.css"),
  "utf8",
);

describe("the aperture", () => {
  it("carries the three motions as classes, not inline animations", () => {
    const { container } = render(<Home />);

    // The iris, its blades and the sweep — each a hook the stylesheet owns.
    expect(container.querySelector(".nb-iris")).toBeTruthy();
    expect(container.querySelector(".nb-iris-blades")).toBeTruthy();
    expect(container.querySelector(".nb-lens-sweep")).toBeTruthy();

    // Nothing animates itself in the markup, or the rule below could not reach it.
    expect(container.innerHTML).not.toMatch(/animation:/);
  });

  it("spins the BROKEN ring, because an unbroken one rotating is invisible", () => {
    const { container } = render(<Home />);
    const blades = container.querySelector(".nb-iris-blades")!;
    // Six strokes at 60°, which is what makes the turn read as an iris.
    expect(blades.querySelectorAll("path")).toHaveLength(6);
    expect(blades.querySelectorAll("circle")).toHaveLength(0);
  });
});

describe("prefers-reduced-motion", () => {
  it("stops every one of them", () => {
    const reduced = theme.slice(theme.indexOf("@media (prefers-reduced-motion: reduce)"));
    for (const hook of [".nb-iris", ".nb-iris-blades", ".nb-lens-sweep"]) {
      expect(reduced).toContain(hook);
    }
    expect(reduced).toMatch(/\.nb-lens-sweep\s*\{\s*opacity: 0/);
  });

  it("keeps the aperture drawn — the setting asks for less motion, not less page", () => {
    const reduced = theme.slice(theme.indexOf("@media (prefers-reduced-motion: reduce)"));
    // The iris and its blades lose their animation and keep their ink.
    expect(reduced).not.toMatch(/\.nb-iris\s*,?\s*\{[^}]*display:\s*none/);
    expect(reduced).not.toMatch(/\.nb-iris-blades[^}]*opacity: 0/);
  });
});

describe("what it costs to leave open", () => {
  it("animates only transform and opacity", () => {
    // A wall leaves this page up for a shift. Anything that lands on layout or
    // paint would be a cost per frame, all day.
    const lens = theme.slice(
      theme.indexOf("@keyframes nb-iris-breathe"),
      theme.indexOf("@media (prefers-reduced-motion: reduce)"),
    );
    const props = [...lens.matchAll(/^\s*(?:\d+%|to|from|0%, 100%)[^{]*\{([^}]*)\}/gm)]
      .flatMap((m) => m[1].split(";"))
      .map((d) => d.split(":")[0].trim())
      .filter(Boolean);
    expect(props.length).toBeGreaterThan(0);
    expect(props.every((p) => p === "transform" || p === "opacity")).toBe(true);
  });
});
