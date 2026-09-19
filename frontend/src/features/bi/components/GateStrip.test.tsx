/**
 * THE GATE STRIP is the one component that states Building Intelligence's
 * pipeline, at every layer, and its single hardest requirement is NEGATIVE: it
 * has to disappear when the estate is healthy. Every screen in this console was
 * built while the estate was broken, so the product shipped permanently in
 * diagnostic mode — which a prospect reads as a broken product rather than an
 * honest one.
 *
 * So these cover, in order of how much damage getting them wrong does:
 *
 *   • a healthy estate gets ONE thin line and nothing to press;
 *   • a broken one expands the EARLIEST shut gate and only that one, while the
 *     other shut gates stay reachable;
 *   • pressing a shut gate opens ITS worklist, in context, with the evidence
 *     rows and the link that settles them — it never leaves the page;
 *   • a gate that is passing is a span, not a button and not an anchor: a
 *     passing gate is never a link to nowhere;
 *   • a gate WAITING on an earlier one says so and is not dressed as a fault;
 *   • a domain strip scopes every worklist to its own category;
 *   • a caller who may not open a worklist is not sent to one and is not
 *     charged for its request either.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";

import GateStrip from "./GateStrip";
import { bi } from "../api";

const auth = { can: (_p: string) => true, hasModule: (_m: string) => true };
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ can: (p: string) => auth.can(p), hasModule: (m: string) => auth.hasModule(m) }),
}));

/** An estate where all six gates are open: 475 rows for 475 registers, every
 *  point placed and united, one site CCEI could score, alerts collecting. */
const healthySummary = {
  generated_at: "2026-09-19T10:00:00Z",
  last_reading_at: "2026-09-19T09:59:00Z",
  fresh_minutes: 15,
  total_devices: 27,
  total_points: 475,
  total_registers: 475,
  total_points_reporting: 475,
  site_alert_hours: 24,
  sites: [{ site_id: "s1", site_name: "HQ", score: 62, points: 475, categories: [] }],
  categories: [
    { category: "energy", devices: 18, points: 260, points_reporting: 260, device_types: [], last_seen_at: null },
    { category: "hvac", devices: 7, points: 36, points_reporting: 36, device_types: [], last_seen_at: null },
  ],
};

const healthyPatterns = {
  patterns: [],
  totals: { points: 475, matched: 475, unmatched: 0, eligible: 0, already_confirmed: 475 },
};

/** Two duplicated registers — one the server can settle on its own, one that is
 *  a question about the building. */
const ghostGroups = [
  {
    device_tag: "1F-DB",
    point_tag: "KWH",
    category: "energy",
    mode: "auto",
    survivor_point_id: "p-new",
    members: [{ point_id: "p-new" }, { point_id: "p-old" }],
  },
  {
    device_tag: "4FKC2",
    point_tag: "IWT",
    category: "hvac",
    mode: "manual",
    survivor_point_id: null,
    members: [{ point_id: "m-a" }, { point_id: "m-b" }],
  },
];

/** One stranded assertion, on the hvac chiller the succession console is built
 *  around. */
const orphanRows = [
  {
    role: "inlet_water_temp",
    point_id: "iwt-dead",
    device_tag: "1F York Chiller01",
    point_tag: "IWT",
    category: "hvac",
    candidates: [{ point_id: "iwt-live", point_tag: "1FYC1_IWT" }],
  },
];

function store(over: Record<string, any> = {}) {
  vi.spyOn(bi, "summary").mockResolvedValue(over.summary ?? healthySummary);
  vi.spyOn(bi, "ghosts").mockResolvedValue(over.ghosts ?? { groups: [], resurrected: [], fresh_minutes: 15 });
  vi.spyOn(bi, "unitPatterns").mockResolvedValue(over.patterns ?? healthyPatterns);
  vi.spyOn(bi, "roleOrphans").mockResolvedValue(
    over.orphans ?? { orphans: [], total: 0, with_candidates: 0, without_candidates: 0 },
  );
  vi.spyOn(bi, "alerts").mockResolvedValue(over.alerts ?? { available: true, items: [] });
}

const estate = <GateStrip subject={{ kind: "estate", label: "the estate" }} />;

beforeEach(() => {
  auth.can = () => true;
  auth.hasModule = () => true;
});

describe("healthy — the strip recedes", () => {
  it("prints one quiet line and offers nothing to press", async () => {
    store();
    renderWithProviders(estate);

    // Every gate's own phrase, in pipeline order, on one line. This is what a
    // prospect reads on a working estate.
    await screen.findByText("475 points · units confirmed · all placed · all bound · rated · alarms live");
    expect(screen.getByText("· six gates, all open")).toBeInTheDocument();

    // Nothing to press, and — the part that matters — no gate panel at all.
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryAllByRole("link")).toHaveLength(0);
    expect(screen.queryByText(/^Gate \d/)).not.toBeInTheDocument();
  });

  it("does not claim the gates are open before the store has answered", () => {
    store();
    renderWithProviders(estate);
    // First frame: the summary is in flight. A receipt printed here would be the
    // one lie this strip exists to prevent.
    expect(screen.getByText("checking the six gates…")).toBeInTheDocument();
    expect(screen.queryByText(/six gates, all open/)).not.toBeInTheDocument();
  });

  it("treats a read that never answered as unknown, not as open", async () => {
    store({ alerts: { items: [] } }); // no `available` field at all
    renderWithProviders(estate);
    const acts = await screen.findByText("ACTS");
    expect(acts.closest("[title]")).toHaveAttribute(
      "title",
      expect.stringContaining("not answered — this is not the same as open"),
    );
    // Silence is not health: the quiet line must not appear.
    expect(screen.queryByText(/six gates, all open/)).not.toBeInTheDocument();
  });
});

describe("shut — one gate expands, and it is the earliest", () => {
  beforeEach(() => {
    store({
      summary: { ...healthySummary, total_registers: 472 },
      ghosts: { groups: ghostGroups, resurrected: [], fresh_minutes: 15 },
      orphans: { orphans: orphanRows, total: 1, with_candidates: 1, without_candidates: 0 },
    });
  });

  it("expands gate 1 and not gate 4, because the pipeline has an order", async () => {
    renderWithProviders(estate);

    const one = await screen.findByRole("button", { name: /1 ARRIVES/ });
    expect(one).toHaveAttribute("aria-expanded", "true");
    const four = screen.getByRole("button", { name: /4 BINDS/ });
    expect(four).toHaveAttribute("aria-expanded", "false");

    // One panel, and it is gate 1's.
    expect(screen.getByText(/^Gate 1 · ARRIVES/)).toBeInTheDocument();
    expect(screen.queryByText(/^Gate 4 · BINDS/)).not.toBeInTheDocument();
  });

  it("opens gate 1's worklist in context — the pairs themselves, and the link that settles them", async () => {
    renderWithProviders(estate);
    await screen.findByText(/^Gate 1 · ARRIVES/);

    expect(
      screen.getByText(
        /3 of the 475 rows counted here are later generations of a register already counted — 472 distinct registers\..*2 duplicated pairs are waiting to be settled/,
      ),
    ).toBeInTheDocument();
    // The evidence, not a count of it.
    expect(screen.getByText("1F-DB · KWH")).toBeInTheDocument();
    expect(screen.getByText("2 generations · no choice needed")).toBeInTheDocument();
    expect(screen.getByText("4FKC2 · IWT")).toBeInTheDocument();
    expect(screen.getByText("2 generations · needs your choice")).toBeInTheDocument();

    expect(screen.getByRole("link", { name: /Settle the duplicated registers/ })).toHaveAttribute(
      "href",
      "/bi/duplicates",
    );
  });

  it("moves the panel to another shut gate when it is pressed, and never opens two", async () => {
    renderWithProviders(estate);
    const four = await screen.findByRole("button", { name: /4 BINDS/ });

    await userEvent.click(four);

    expect(screen.getByText(/^Gate 4 · BINDS/)).toBeInTheDocument();
    expect(screen.queryByText(/^Gate 1 · ARRIVES/)).not.toBeInTheDocument();
    expect(screen.getByText("inlet_water_temp · 1F York Chiller01")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Re-point the stranded roles/ })).toHaveAttribute(
      "href",
      "/bi/succession",
    );
  });

  it("leaves a passing gate as a span — never a button, never a link to nowhere", async () => {
    renderWithProviders(estate);
    await screen.findByRole("button", { name: /1 ARRIVES/ });

    // Gates 2 and 3 pass on this fixture. Neither is pressable and neither is an
    // anchor; the only link on screen is the shut gate's action.
    expect(screen.queryByRole("button", { name: /2 MEANS/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /3 BELONGS/ })).not.toBeInTheDocument();
    expect(screen.getByText("MEANS")).toBeInTheDocument();
    expect(screen.getAllByRole("link")).toHaveLength(1);
  });

  it("says a downstream gate is WAITING rather than dressing it as a fault", async () => {
    // No site CCEI can score, so gate 5 has no positive evidence of its own —
    // and gate 1 is shut, so the honest answer is "waiting", not "shut".
    store({
      summary: {
        ...healthySummary,
        total_registers: 472,
        sites: [{ site_id: "s1", site_name: "HQ", score: null, points: 475, categories: [] }],
      },
      ghosts: { groups: ghostGroups, resurrected: [], fresh_minutes: 15 },
    });
    renderWithProviders(estate);
    const five = await screen.findByText("RATES");
    // Not a button: nothing to do here, and offering one would send an operator
    // to fix a gate that is behaving.
    expect(five.closest("button")).toBeNull();
    expect(five.closest("[title]")).toHaveAttribute(
      "title",
      expect.stringContaining("waiting on an earlier gate"),
    );
  });
});

describe("gate 3 · BELONGS — the gate with no worklist here", () => {
  it("names its blockage and points at the console that owns placement", async () => {
    store({
      summary: {
        ...healthySummary,
        sites: [
          { site_id: "s1", site_name: "HQ", score: 62, points: 400, categories: [] },
          { site_id: null, site_name: null, score: null, points: 75, categories: [{ category: "hvac", points: 75 }] },
        ],
      },
    });
    renderWithProviders(estate);

    await screen.findByText(/^Gate 3 · BELONGS/);
    expect(
      screen.getByText(/75 of 475 points belong to no site.*has no placement worklist and will not grow one/),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Pin the devices on the Sites floor plan/ })).toHaveAttribute(
      "href",
      "/sites",
    );
  });

  it("states the blockage without a door when the caller cannot reach Sites", async () => {
    auth.can = (p: string) => p !== "sites.read";
    store({
      summary: {
        ...healthySummary,
        sites: [
          { site_id: "s1", site_name: "HQ", score: 62, points: 400, categories: [] },
          { site_id: null, site_name: null, score: null, points: 75, categories: [] },
        ],
      },
    });
    renderWithProviders(estate);

    await screen.findByText(/^Gate 3 · BELONGS/);
    expect(screen.getByText(/75 of 475 points belong to no site/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Sites floor plan/ })).not.toBeInTheDocument();
    expect(screen.getByText("Nothing you can reach from here opens this gate.")).toBeInTheDocument();
  });
});

describe("scope — the same strip, one domain down", () => {
  it("counts only its own category's duplicates and its own stranded roles", async () => {
    store({
      ghosts: { groups: [ghostGroups[1]], resurrected: [], fresh_minutes: 15 },
      orphans: { orphans: orphanRows, total: 1, with_candidates: 1, without_candidates: 0 },
    });
    renderWithProviders(
      <GateStrip subject={{ kind: "domain", category: "hvac", label: "HVAC & Assets" }} />,
    );

    // The worklist read is asked for THIS category, not the estate's.
    await waitFor(() => expect(bi.ghosts).toHaveBeenCalledWith({ category: "hvac" }));
    expect(bi.unitPatterns).toHaveBeenCalledWith({ category: "hvac" });

    await screen.findByText(/^Gate 1 · ARRIVES/);
    expect(screen.getByText("Scoped to HVAC & Assets. The estate-wide count is on Building.")).toBeInTheDocument();
  });

  it("drops another domain's stranded roles from gate 4", async () => {
    store({
      orphans: { orphans: orphanRows, total: 1, with_candidates: 1, without_candidates: 0 },
    });
    renderWithProviders(
      <GateStrip subject={{ kind: "domain", category: "energy", label: "Energy & Metering" }} />,
    );

    // The chiller's stranded role is hvac's problem. Energy's gate 4 is open,
    // and with every other gate open too the strip recedes to its quiet line.
    await screen.findByText(/six gates, all open/);
  });
});

describe("a caller who may not open a worklist", () => {
  it("is not sent to one and is not charged for its request", async () => {
    auth.can = (p: string) => p !== "bi.read";
    store({
      summary: { ...healthySummary, total_registers: 472 },
      ghosts: { groups: ghostGroups, resurrected: [], fresh_minutes: 15 },
    });
    renderWithProviders(estate);

    await screen.findByText(/^Gate 1 · ARRIVES/);
    // The inflation is still stated — it is true whoever is reading.
    expect(screen.getByText(/3 of the 475 rows counted here are later generations/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Settle the duplicated registers/ })).not.toBeInTheDocument();
    expect(bi.ghosts).not.toHaveBeenCalled();
    expect(bi.roleOrphans).not.toHaveBeenCalled();
  });

  it("offers no write control anywhere in the strip", async () => {
    auth.can = (p: string) => p !== "bi.manage";
    store({
      summary: { ...healthySummary, total_registers: 472 },
      ghosts: { groups: ghostGroups, resurrected: [], fresh_minutes: 15 },
    });
    renderWithProviders(estate);
    await screen.findByText(/^Gate 1 · ARRIVES/);

    // Every control on the strip is a gate segment. Settling anything happens on
    // the console the link opens, behind that console's own `bi.manage` gate.
    for (const b of screen.getAllByRole("button")) {
      expect(b.textContent).toMatch(/ARRIVES|MEANS|BELONGS|BINDS|RATES|ACTS/);
    }
  });

  it("cannot grow one — neither module names a write at all", () => {
    // The assertion above is about what RENDERED for one caller; this is about
    // what the two modules can do at all, and it is the one that stops a later
    // edit from putting a "collapse the auto groups" button on a strip that
    // appears above every screen in the console. Comments are stripped, because
    // the prose here and there names the very calls it forbids.
    const code = (f: string) =>
      readFileSync(path.resolve(__dirname, f), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");

    for (const f of ["./GateStrip.tsx", "../gates.ts"]) {
      const body = code(f);
      expect(body, f).not.toMatch(/useMutation/);
      expect(body, f).not.toMatch(
        /bi\.(collapseGhosts|restoreGhosts|repointRoles|forgetRoles|confirmUnits|confirmUnitPattern)/,
      );
    }
  });
});

/**
 * ONE BUILDING — the other scope of the same L2 console (`/bi/hvac?site=<uuid>`).
 *
 * The expensive failure here is not a missing panel, it is a PLAUSIBLE one: the
 * estate's duplicate count, unit backlog or unplaced remainder rendered under a
 * building's name. Every one of those worklists takes a `category` and carries
 * no site, so the honest answers at this scope are:
 *
 *   gate 3 · BELONGS   PASSES, by construction — `?site=` selects on the pin.
 *   gate 5 · RATES     this building's own CCEI, in the registry's own words.
 *   gates 1, 2, 4      DEFER, and say why, with a door to the domain-wide answer.
 *
 * and, crucially, the three worklist reads are never made at all.
 */
const scopedSummary = {
  ...healthySummary,
  total_points: 176,
  total_registers: 176,
  categories: [{ category: "hvac", devices: 12, points: 176, points_reporting: 176, device_types: [], last_seen_at: null }],
  sites: [
    {
      site_id: "aeon-1",
      site_name: "Aeon Tower",
      score: 61,
      points: 83,
      categories: [{ category: "hvac", devices: 7, points: 83 }],
    },
    {
      site_id: null,
      site_name: null,
      score: null,
      points: 93,
      categories: [{ category: "hvac", devices: 5, points: 93 }],
    },
  ],
};

const atAeon = (
  <GateStrip subject={{ kind: "site", category: "hvac", siteId: "aeon-1", label: "HVAC & Assets at Aeon Tower" }} />
);

describe("scope — the same strip, inside one building", () => {
  it("never asks a worklist that carries no site", async () => {
    store({ summary: scopedSummary });
    renderWithProviders(atAeon);

    await screen.findByText("BELONGS");
    // Not "asked with a site" — NOT ASKED. An answer fetched here could only be
    // the domain's, and rendering it under this building's name is the one thing
    // a two-scope strip must not do.
    expect(bi.ghosts).not.toHaveBeenCalled();
    expect(bi.unitPatterns).not.toHaveBeenCalled();
    expect(bi.roleOrphans).not.toHaveBeenCalled();
  });

  it("passes gate 3 where the estate's strip is shut on it", async () => {
    store({ summary: scopedSummary });
    renderWithProviders(atAeon);

    const belongs = await screen.findByText("BELONGS");
    expect(belongs.closest("[title]")).toHaveAttribute("title", expect.stringContaining("open"));
    // The estate's 93 unplaced points are not this building's problem and must
    // not appear anywhere on its strip.
    expect(screen.queryByText(/93/)).not.toBeInTheDocument();
    expect(screen.queryByText(/belong to no site/)).not.toBeInTheDocument();
  });

  it("states the estate's unplaced remainder when the subject IS the estate's domain", async () => {
    // The mirror image of the assertion above, on the same fixture: the counts
    // move with the scope, they are not just hidden at one of them.
    store({ summary: scopedSummary });
    renderWithProviders(<GateStrip subject={{ kind: "domain", category: "hvac", label: "HVAC & Assets" }} />);

    await screen.findByText(/^Gate 3 · BELONGS/);
    expect(screen.getByText(/93 of 176 points belong to no site/)).toBeInTheDocument();
  });

  it("defers the gates whose worklists are scoped by domain, with a door to where they are answered", async () => {
    store({ summary: scopedSummary });
    renderWithProviders(atAeon);

    // Deferred is not shut: nothing auto-opens, and the strip stays a row of
    // segments over the equipment rather than a diagnosis of it.
    await screen.findByText("ARRIVES");
    expect(screen.queryByText(/^Gate \d/)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /1 ARRIVES/ }));
    expect(
      screen.getByText(/83 HVAC & Assets at Aeon Tower points are pinned at this building/),
    ).toBeInTheDocument();
    expect(screen.getByText(/duplicate worklist is scoped by category and carries no site/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Answer it across the whole estate/ })).toHaveAttribute(
      "href",
      "/bi/hvac",
    );
    expect(
      screen.getByText("Scoped to HVAC & Assets at Aeon Tower — one building. Nothing here is the estate's figure."),
    ).toBeInTheDocument();
  });

  it("rates the building on its OWN score, and prints the registry's refusal when it has none", async () => {
    store({
      summary: {
        ...scopedSummary,
        sites: [
          {
            ...scopedSummary.sites[0],
            score: null,
            score_reason: "CCEI needs a gross floor area and this building has none recorded.",
          },
          scopedSummary.sites[1],
        ],
      },
    });
    renderWithProviders(atAeon);

    await screen.findByText(/^Gate 5 · RATES/);
    expect(
      screen.getByText("CCEI needs a gross floor area and this building has none recorded."),
    ).toBeInTheDocument();
  });

  it("says the summary carries no such building rather than printing a zero", async () => {
    store({ summary: { ...scopedSummary, sites: [scopedSummary.sites[1]] } });
    renderWithProviders(atAeon);

    await screen.findByText("ARRIVES");
    await userEvent.click(screen.getByRole("button", { name: /1 ARRIVES/ }));
    expect(screen.getByText(/carries no row for this building/)).toBeInTheDocument();
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });
});
