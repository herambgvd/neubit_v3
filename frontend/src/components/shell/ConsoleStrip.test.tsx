/**
 * BUILDING INTELLIGENCE'S STRIP IS THE DRILL, NOT A MENU — plus ONE door into
 * Setup, where every piece of BI configuration lives.
 *
 * The layer segment carries the layers and a single SETUP cell. The gate
 * worklists (duplicates, placement, stranded roles) are not cells of it: they
 * are Setup's tasks, and on a Setup route the strip swaps to Setup's own
 * segment — the checklist, then the tasks in gate order — with the way back to
 * Building.
 */
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import ConsoleStrip, { hasConsoleStrip } from "./ConsoleStrip";

const route = { path: "/bi/portfolio", query: "" };
vi.mock("next/navigation", () => ({
  usePathname: () => route.path,
  useSearchParams: () => new URLSearchParams(route.query),
}));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ can: () => true }) }));

function at(path: string, query = "") {
  route.path = path;
  route.query = query;
  return render(<ConsoleStrip />);
}

const hrefs = () =>
  Object.fromEntries(
    screen.getAllByRole("link").map((a) => [(a.textContent || "").trim(), a.getAttribute("href")]),
  );

const lit = (root: HTMLElement = document.body) =>
  within(root)
    .getAllByRole("link")
    .filter((a) => a.className.includes("bg-[rgba(96,165,250,.16)]"))
    .map((a) => (a.textContent || "").trim());

describe("the BI segment", () => {
  it("carries the layers, then one door into Setup", () => {
    at("/bi/portfolio");
    const labels = screen
      .getAllByRole("link")
      .map((a) => (a.textContent || "").trim());
    // WORK is gate 6's worklist and sits after the layers: it is what today's
    // readings are asking for, not another view of the estate.
    expect(labels).toEqual(["BUILDING", "ENERGY", "HVAC", "WATER", "WORK", "INSIGHTS", "RATINGS", "SETUP"]);
    expect(hrefs().SETUP).toBe("/bi/setup");
  });

  it("does not offer a gate worklist as a cell", () => {
    at("/bi/energy");
    expect(screen.queryByRole("link", { name: /DUPLICATES/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /STRANDED/ })).not.toBeInTheDocument();
  });

  it("lights the layer you are on", () => {
    at("/bi/hvac");
    expect(lit()).toEqual(["HVAC"]);
  });
});

describe("on a Setup route", () => {
  it("shows Setup's own segment, in gate order, and the way back to Building", () => {
    at("/bi/setup");
    const setup = screen.getByLabelText("Setup");
    expect(within(setup).getAllByRole("link").map((a) => (a.textContent || "").trim())).toEqual([
      "CHECKLIST",
      "BUILDINGS",
      "EQUIPMENT",
      "ROLES",
      "FACTS",
    ]);
    expect(lit(setup)).toEqual(["CHECKLIST"]);
    expect(screen.getByRole("link", { name: /Building/ })).toHaveAttribute("href", "/bi/portfolio");
    // Not the layer segment beside it.
    expect(screen.queryByRole("link", { name: /ENERGY/ })).not.toBeInTheDocument();
  });

  it("lights the task you are on", () => {
    at("/bi/setup/equipment");
    expect(lit(screen.getByLabelText("Setup"))).toEqual(["EQUIPMENT"]);
  });

  it("lights ROLES on the stranded-role worklist, which belongs to it", () => {
    at("/bi/setup/stranded");
    expect(lit(screen.getByLabelText("Setup"))).toEqual(["ROLES"]);
  });

  it("names each task's gate on hover", () => {
    at("/bi/setup/placement");
    expect(screen.getByRole("link", { name: /BUILDINGS/ })).toHaveAttribute("title", "Gate 3 · Buildings & devices");
  });

  it("renders on every Setup route", () => {
    for (const p of [
      "/bi/setup",
      "/bi/setup/placement",
      "/bi/setup/equipment",
      "/bi/setup/roles",
      "/bi/setup/stranded",
      "/bi/setup/facts",
    ]) {
      expect(hasConsoleStrip(p), p).toBe(true);
    }
  });
});

/**
 * THE SECOND AXIS. A domain route is TWO destinations — the whole estate without
 * `?site=`, one building with it — and the strip is the chrome both of them wear.
 * So it has two jobs here, and getting either wrong silently moves an operator
 * between scopes while looking like a filter change:
 *
 *   • a domain cell must CARRY the building scope, not drop it;
 *   • the strip must SAY when a building scope is in force, and be the control
 *     that leaves it.
 *
 * Building, Insights and Ratings have no site scope to keep, so they must not
 * grow a `?site=` they would not honour.
 */
describe("the building scope, in the chrome", () => {
  it("carries the scope through every domain cell and through no other", () => {
    at("/bi/energy", "site=aeon-1");
    const h = hrefs();
    expect(h.ENERGY).toBe("/bi/energy?site=aeon-1");
    expect(h.HVAC).toBe("/bi/hvac?site=aeon-1");
    expect(h.WATER).toBe("/bi/water?site=aeon-1");
    // Nothing else is scoped by a building, so nothing else pretends to be.
    expect(h.BUILDING).toBe("/bi/portfolio");
    expect(h.INSIGHTS).toBe("/bi/insights");
    expect(h.RATINGS).toBe("/bi/ratings");
  });

  it("says a building scope is in force, and is the way out of it", () => {
    at("/bi/hvac", "site=aeon-1");
    const out = screen.getByRole("link", { name: /ONE BUILDING/ });
    // Out of the scope is the SAME domain, unscoped — the estate-wide view of
    // what is already on screen, not a different console.
    expect(out).toHaveAttribute("href", "/bi/hvac");
  });

  it("offers the building's plant (L3) only inside a building scope", () => {
    at("/bi/energy", "site=aeon-1");
    expect(hrefs().PLANT).toBe("/bi/plant?site=aeon-1");
  });

  it("carries the building from its plant back into its domains", () => {
    at("/bi/plant", "site=aeon-1");
    const h = hrefs();
    expect(lit()).toEqual(["PLANT"]);
    expect(h.HVAC).toBe("/bi/hvac?site=aeon-1");
    // A plant has no estate-wide form: leaving the building goes to Building.
    expect(screen.getByRole("link", { name: /ONE BUILDING/ })).toHaveAttribute("href", "/bi/portfolio");
    expect(hasConsoleStrip("/bi/plant")).toBe(true);
  });

  it("says nothing about a scope that is not in force", () => {
    at("/bi/hvac");
    expect(screen.queryByRole("link", { name: /ONE BUILDING/ })).not.toBeInTheDocument();
    expect(hrefs().HVAC).toBe("/bi/hvac");
    expect(hrefs().PLANT).toBeUndefined();
  });
});
