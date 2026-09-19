/**
 * L1 BUILDING — the home of Building Intelligence, and the top of one pipeline.
 *
 * Two things are covered here and they are different jobs.
 *
 * THE LAYER. The page reads gates → questions → domains → detail, because that
 * is the order a reader needs: can these numbers be trusted, what do they say,
 * where do they come from. Every question carries a measured number or the
 * sentence that says what is blocking it AND where it is unblocked — never a
 * zero, never a guess. And the correlations lane, which another agent is
 * building the backend for, is a slot in the SOURCE and renders nothing: a card
 * promising a destination this console cannot honour is the one thing every
 * screen here refuses to ship.
 *
 * THE POINT COUNT, WHICH MOVED. `points` holds one row per point_id and a
 * rebuilt gateway connection re-creates its points under new ids, so the estate's
 * row count is larger than its register count — 766 against 475 on the live
 * deployment. That annotation used to live in this file's own markup, beside the
 * Points KPI, while the units panel counted its own backlog and the succession
 * console counted its own orphans: three screens stating three gates' facts in
 * three wordings. It is now GATE 1 of the shared strip. The properties it had to
 * hold did not change, so they are still tested — through the strip, on this
 * page, where the regression would actually be seen:
 *
 *   • both figures print — the rows that were counted and the registers they
 *     really describe — and BOTH come from the summary. Neither is subtracted
 *     from a second row set, so a worklist that counts a different population
 *     cannot move them;
 *   • the register line survives a worklist that failed, because it never
 *     depended on it;
 *   • the link, and only the link, is gated exactly like /bi/duplicates itself
 *     (`bi.read` + the `analytics` module), and a viewer without it is not even
 *     charged the request;
 *   • a clean estate says nothing extra — it gets the quiet line and no panel.
 */
import { screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";

import Portfolio from "./Portfolio";
import { bi } from "./api";

const auth = { can: (_p: string) => true, hasModule: (_m: string) => true };
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ can: (p: string) => auth.can(p), hasModule: (m: string) => auth.hasModule(m) }),
}));

const summary = {
  generated_at: "2026-09-19T10:00:00Z",
  last_reading_at: "2026-09-19T09:59:00Z",
  fresh_minutes: 15,
  total_devices: 4,
  total_points: 10,
  // Counted over the same rows in the same statement as `total_points` — three
  // of those ten rows are later generations of a register already counted.
  total_registers: 7,
  total_points_reporting: 8,
  site_alert_hours: 24,
  sites: [],
  categories: [],
};

// Three rows too many across two registers: a pair rebuilt twice, and a pair
// rebuilt once. 10 rows − 3 repeats = 7 registers.
const groups = [
  {
    device_tag: "1F-DB",
    point_tag: "KWH",
    category: "energy",
    mode: "auto",
    survivor_point_id: "p-new",
    members: [{ point_id: "p-new" }, { point_id: "p-old" }, { point_id: "p-older" }],
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

function estate(over: Record<string, unknown> = {}) {
  vi.spyOn(bi, "summary").mockResolvedValue({ ...summary, ...over });
  vi.spyOn(bi, "activity").mockResolvedValue([]);
  vi.spyOn(bi, "alerts").mockResolvedValue({
    available: true,
    items: [],
    by_severity: [],
    total: 0,
  });
  // The other two gate reads the strip makes. Clean unless a test says
  // otherwise, so a test about gate 1 is not quietly also about gate 2.
  vi.spyOn(bi, "unitPatterns").mockResolvedValue({
    patterns: [],
    totals: { points: 10, matched: 10, unmatched: 0, eligible: 0, already_confirmed: 10 },
  });
  vi.spyOn(bi, "roleOrphans").mockResolvedValue({
    orphans: [],
    total: 0,
    with_candidates: 0,
    without_candidates: 0,
  });
}

const worklist = (over: Record<string, unknown> = {}) =>
  vi.spyOn(bi, "ghosts").mockResolvedValue({
    groups,
    total: groups.length,
    auto: 1,
    manual: 1,
    fresh_minutes: 15,
    resurrected: [],
    ...over,
  });

beforeEach(() => {
  auth.can = () => true;
  auth.hasModule = () => true;
});

describe("the layer", () => {
  it("leads with the questions this building has to answer, not with a leaderboard", async () => {
    estate();
    worklist();

    renderWithProviders(<Portfolio />);

    expect(await screen.findByText("What this building has to answer")).toBeInTheDocument();
    for (const q of [
      "What is it consuming?",
      "How efficiently?",
      "What is failing now?",
      "What has gone quiet?",
      "What is it made of?",
    ]) {
      expect(screen.getByText(q)).toBeInTheDocument();
    }
    // The domains are a lane of this one estate, below the questions.
    expect(screen.getByText("Domains")).toBeInTheDocument();
  });

  it("prints a blocked answer as its blockage plus the action that changes it", async () => {
    estate();
    worklist();

    renderWithProviders(<Portfolio />);

    // No site has a confirmed kWh register, so consumption cannot be measured.
    expect(
      await screen.findByText("no kWh register confirmed — confirm units in Ratings"),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Confirm a kWh register/ })).toHaveAttribute(
      "href",
      "/bi/ratings",
    );
  });

  it("counts the quiet points against the rows they were counted from", async () => {
    estate();
    worklist();

    renderWithProviders(<Portfolio />);

    const quiet = (await screen.findByText("What has gone quiet?")).closest("div")!;
    // 10 rows, 8 of them reporting. The figure and the population it was taken
    // from are on the same slot, so neither can be read as the other.
    expect(within(quiet).getByText("2")).toBeInTheDocument();
    expect(within(quiet).getByText("points silent longer than 15 min, of 10")).toBeInTheDocument();
    expect(screen.getByText("devices · 10 points across 0 domains")).toBeInTheDocument();
  });

  it("ships no placeholder for the correlations lane", async () => {
    // The slot is a comment in the source, between the questions and the
    // domains. A card saying "correlations, coming soon" would be a control with
    // no consumer and a destination that does not exist.
    estate();
    worklist();

    renderWithProviders(<Portfolio />);

    await screen.findByText("Domains");
    expect(screen.queryByText(/correlation/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/coming soon/i)).not.toBeInTheDocument();
  });
});

describe("the point count, now gate 1 of the strip", () => {
  it("prints the registers the estate really has beside the rows it counted", async () => {
    estate();
    worklist();

    renderWithProviders(<Portfolio />);

    expect(
      await screen.findByText(
        /3 of the 10 rows counted here are later generations of a register already counted — 7 distinct registers/,
      ),
    ).toBeInTheDocument();
  });

  it("reads both figures off the summary rather than subtracting the worklist", async () => {
    // The worklist is handed a population the summary does not agree with: six
    // excess rows across its groups against the summary's three. A page still
    // doing the subtraction would print `4 registers`; the summary says 7 and 3,
    // and the summary is the one that counted under the same horizon.
    estate();
    worklist({
      groups: [
        {
          ...groups[0],
          members: [
            { point_id: "p-new" },
            { point_id: "p-old" },
            { point_id: "p-older" },
            { point_id: "p-oldest" },
          ],
        },
        { ...groups[1], members: [{ point_id: "m-a" }, { point_id: "m-b" }, { point_id: "m-c" }] },
      ],
    });

    renderWithProviders(<Portfolio />);

    expect(await screen.findByText(/3 of the 10 rows.*7 distinct registers/)).toBeInTheDocument();
    expect(screen.queryByText(/6 of the 10 rows/)).toBeNull();
  });

  it("says nothing about registers when the store did not report them", async () => {
    // Absent is not zero and not clean: a store that never said how many
    // registers there are has not said the estate has none repeated.
    estate({ total_registers: undefined });
    worklist();

    renderWithProviders(<Portfolio />);

    await waitFor(() => expect(bi.ghosts).toHaveBeenCalled());
    expect(await screen.findByText(/2 duplicated pairs are waiting/)).toBeInTheDocument();
    expect(screen.queryByText(/distinct registers/)).toBeNull();
  });

  it("hands the operator to the screen that settles them", async () => {
    estate();
    worklist();

    renderWithProviders(<Portfolio />);

    const link = await screen.findByRole("link", { name: /Settle the duplicated registers/ });
    expect(link).toHaveAttribute("href", "/bi/duplicates");
  });

  it("offers no trip to a viewer who cannot open the duplicates console", async () => {
    estate();
    const ghosts = worklist();
    auth.can = (p: string) => p !== "bi.read";

    renderWithProviders(<Portfolio />);

    expect(await screen.findByText(/7 distinct registers/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Settle/ })).not.toBeInTheDocument();
    // Not merely hidden: a caller who may not read it is never charged for it.
    expect(ghosts).not.toHaveBeenCalled();
  });

  it("offers no trip when the analytics module is not entitled", async () => {
    estate();
    const ghosts = worklist();
    auth.hasModule = (m: string) => m !== "analytics";

    renderWithProviders(<Portfolio />);

    expect(await screen.findByText(/7 distinct registers/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Settle/ })).not.toBeInTheDocument();
    expect(ghosts).not.toHaveBeenCalled();
  });

  it("keeps the register line when the worklist cannot be read, and offers no link", async () => {
    estate();
    const ghosts = vi.spyOn(bi, "ghosts").mockRejectedValue(new Error("boom"));

    renderWithProviders(<Portfolio />);

    await waitFor(() => expect(ghosts).toHaveBeenCalled());
    // The register figures came out of the summary, which loaded, so a worklist
    // this line never read cannot take it away.
    expect(await screen.findByText(/7 distinct registers/)).toBeInTheDocument();
    // The pair count did come from the worklist, so nothing is claimed about it.
    expect(screen.queryByText(/duplicated pairs are waiting/)).toBeNull();
    // The LINK is still offered, and this is a change from the old annotation:
    // it used to carry the pair count in its own label ("Settle 2 duplicated
    // pairs"), so a failed worklist had to withdraw it. It carries no count now,
    // the inflation it answers for came from the summary, and a count that is
    // wrong must ship with the thing that changes it.
    expect(screen.getByRole("link", { name: /Settle the duplicated registers/ })).toHaveAttribute(
      "href",
      "/bi/duplicates",
    );
  });

  it("says nothing extra about an estate with no duplicated pair", async () => {
    // A clean estate has as many registers as it has rows, so there is nothing
    // to annotate, no pair to settle — and with every other gate open the strip
    // recedes to one line, which is the whole point of it.
    estate({ total_registers: 10, sites: [{ site_id: "s1", site_name: "HQ", score: 61, points: 10, categories: [] }] });
    worklist({ groups: [], total: 0, auto: 0, manual: 0 });

    renderWithProviders(<Portfolio />);

    await waitFor(() => expect(bi.ghosts).toHaveBeenCalled());
    expect(await screen.findByText(/six gates, all open/)).toBeInTheDocument();
    expect(screen.queryByText(/^Gate \d/)).toBeNull();
    expect(screen.queryByRole("link", { name: /Settle/ })).not.toBeInTheDocument();
  });
});
