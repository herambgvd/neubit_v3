/**
 * PORTFOLIO's point count is the one number on this page that is not what it
 * looks like. `points` holds one row per point_id and a rebuilt gateway
 * connection re-creates its points under new ids, so the estate's row count is
 * larger than its register count — 766 against 475 on the live deployment.
 *
 * These cover the annotation that says so, and every way it must stay out of
 * the way:
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
 *   • a clean estate says nothing extra.
 */
import { screen, waitFor } from "@testing-library/react";
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

/** The text of one element, whitespace-normalised — the annotation's numbers sit
 *  in their own mono spans, so a plain string matcher would never see the line
 *  they belong to. */
const line = (want: string) => (_c: string, el: Element | null) =>
  el?.tagName === "P" && (el.textContent || "").replace(/\s+/g, " ").trim() === want;

function estate(over: Record<string, unknown> = {}) {
  vi.spyOn(bi, "summary").mockResolvedValue({ ...summary, ...over });
  vi.spyOn(bi, "activity").mockResolvedValue([]);
  vi.spyOn(bi, "alerts").mockResolvedValue({
    available: true,
    items: [],
    by_severity: [],
    total: 0,
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

describe("the point count", () => {
  it("prints the registers the estate really has beside the rows it counted", async () => {
    estate();
    worklist();

    renderWithProviders(<Portfolio />);

    // The headline is still the row count — every other figure on the page was
    // computed over those rows.
    expect(await screen.findByText("10")).toBeInTheDocument();
    // …and it no longer prints alone.
    expect(
      await screen.findByText(line("7 registers · 3 rows are repeats of them")),
    ).toBeInTheDocument();
  });

  it("reads both figures off the summary rather than subtracting the worklist", async () => {
    // The worklist is handed a population the summary does not agree with: six
    // excess rows across its groups against the summary's three. A page still
    // doing the subtraction would print `4 registers · 6 rows`; the summary says
    // 7 and 3, and the summary is the one that counted under the same horizon.
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

    expect(
      await screen.findByText(line("7 registers · 3 rows are repeats of them")),
    ).toBeInTheDocument();
    expect(screen.queryByText(line("4 registers · 6 rows are repeats of them"))).toBeNull();
  });

  it("says nothing about registers when the store did not report them", async () => {
    // Absent is not zero and not clean: a store that never said how many
    // registers there are has not said the estate has none repeated.
    estate({ total_registers: undefined });
    worklist();

    renderWithProviders(<Portfolio />);

    expect(await screen.findByText("10")).toBeInTheDocument();
    await waitFor(() => expect(bi.ghosts).toHaveBeenCalled());
    expect(screen.queryByText(/rows are repeats/)).toBeNull();
    // The pair count is the worklist's own and is still offered.
    expect(screen.getByRole("link", { name: /Settle 2 duplicated pairs/ })).toBeInTheDocument();
  });

  it("hands the operator to the screen that settles them", async () => {
    estate();
    worklist();

    renderWithProviders(<Portfolio />);

    const link = await screen.findByRole("link", { name: /Settle 2 duplicated pairs/ });
    expect(link).toHaveAttribute("href", "/bi/duplicates");
  });

  it("offers no trip to a viewer who cannot open the duplicates console", async () => {
    estate();
    const ghosts = worklist();
    auth.can = (p: string) => p !== "bi.read";

    renderWithProviders(<Portfolio />);

    expect(await screen.findByText("10")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Settle/ })).not.toBeInTheDocument();
    // Not merely hidden: a caller who may not read it is never charged for it.
    expect(ghosts).not.toHaveBeenCalled();
  });

  it("offers no trip when the analytics module is not entitled", async () => {
    estate();
    const ghosts = worklist();
    auth.hasModule = (m: string) => m !== "analytics";

    renderWithProviders(<Portfolio />);

    expect(await screen.findByText("10")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Settle/ })).not.toBeInTheDocument();
    expect(ghosts).not.toHaveBeenCalled();
  });

  it("keeps the register line when the worklist cannot be read, and offers no link", async () => {
    estate();
    const ghosts = vi.spyOn(bi, "ghosts").mockRejectedValue(new Error("boom"));

    renderWithProviders(<Portfolio />);

    await waitFor(() => expect(ghosts).toHaveBeenCalled());
    // The count and its freshness line are untouched, and nothing is blamed on a
    // number that is still true about rows.
    expect(await screen.findByText("10")).toBeInTheDocument();
    expect(screen.getByText("8 reporting in last 15 min")).toBeInTheDocument();
    // The register figures came out of the summary, which loaded, so a worklist
    // this line never read cannot take it away.
    expect(
      screen.getByText(line("7 registers · 3 rows are repeats of them")),
    ).toBeInTheDocument();
    // The pair count did come from the worklist, so nothing is linked and no
    // count is invented for it.
    expect(screen.queryByRole("link", { name: /Settle/ })).not.toBeInTheDocument();
  });

  it("says nothing extra about an estate with no duplicated pair", async () => {
    // A clean estate has as many registers as it has rows, so there is nothing
    // to annotate and no pair to settle.
    estate({ total_registers: 10 });
    worklist({ groups: [], total: 0, auto: 0, manual: 0 });

    renderWithProviders(<Portfolio />);

    expect(await screen.findByText("10")).toBeInTheDocument();
    await waitFor(() => expect(bi.ghosts).toHaveBeenCalled());
    expect(screen.queryByRole("link", { name: /Settle/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/registers ·/)).not.toBeInTheDocument();
  });
});
