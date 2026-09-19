/**
 * BUILDING INTELLIGENCE'S STRIP IS THE DRILL, NOT A MENU.
 *
 * The console is one pipeline over three layers, and the two screens that used
 * to sit in this segment beside them — DUPLICATES and STRANDED ROLES — are not
 * layers. Each is the WORKLIST OF A SHUT GATE, reached by pressing that gate on
 * whatever layer you are standing on, already scoped to it. A segment cell for
 * one is the same mistake as a launcher tile for one: it makes the worklist a
 * destination beside the estate view, which is what made the pipeline invisible.
 *
 * So: no cell for either, a chip that names the gate when one is deep-linked,
 * and — the part that must not regress — both routes still resolve.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import ConsoleStrip from "./ConsoleStrip";

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

describe("the BI segment", () => {
  it("carries the layers and nothing else", () => {
    at("/bi/portfolio");
    const labels = screen
      .getAllByRole("link")
      .map((a) => (a.textContent || "").trim());
    expect(labels).toEqual(["BUILDING", "ENERGY", "HVAC", "WATER", "INSIGHTS", "RATINGS"]);
  });

  it("does not offer either gate worklist as a cell", () => {
    at("/bi/energy");
    expect(screen.queryByRole("link", { name: /DUPLICATES/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /STRANDED/ })).not.toBeInTheDocument();
  });

  it("lights the layer you are on", () => {
    at("/bi/hvac");
    // The active cell is the only one carrying the lit background.
    const lit = screen.getAllByRole("link").filter((a) => a.className.includes("bg-[rgba(96,165,250,.16)]"));
    expect(lit.map((a) => (a.textContent || "").trim())).toEqual(["HVAC"]);
  });
});

describe("a gate worklist, deep-linked", () => {
  it("names the gate it belongs to instead of a segment with nothing lit", () => {
    at("/bi/duplicates");
    expect(screen.getByText(/Gate 1 · ARRIVES — Duplicate registers/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /ENERGY/ })).not.toBeInTheDocument();
    // And the way back to the layer the gate is on.
    expect(screen.getByRole("link", { name: /Building/ })).toHaveAttribute("href", "/bi/portfolio");
  });

  it("does the same for gate 4", () => {
    at("/bi/succession");
    expect(screen.getByText(/Gate 4 · BINDS — Stranded roles/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Building/ })).toHaveAttribute("href", "/bi/portfolio");
  });
});

describe("the routes behind the demoted doors", () => {
  it("both still resolve", async () => {
    // Nothing was deleted. A bookmark, the gate strip's own action link and
    // Building's gate 1 all name these paths.
    const dup = await import("@/app/(app)/bi/duplicates/page");
    const succ = await import("@/app/(app)/bi/succession/page");
    expect(typeof dup.default).toBe("function");
    expect(typeof succ.default).toBe("function");
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

  it("says nothing about a scope that is not in force", () => {
    at("/bi/hvac");
    expect(screen.queryByRole("link", { name: /ONE BUILDING/ })).not.toBeInTheDocument();
    expect(hrefs().HVAC).toBe("/bi/hvac");
  });
});
