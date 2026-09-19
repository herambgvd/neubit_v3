/**
 * THE CORRELATIONS LANE — the cross-domain questions, and the one number on the
 * console that has to be trustworthy.
 *
 * Three things are covered here and they fail in different ways.
 *
 * THE TRI-STATE. `needs_new_hardware` is true / false / null, and `null` means
 * UNDETERMINED. The whole commercial claim of this lane is "these gaps cost you
 * nothing to close", and a client that quietly counted an undetermined gap as
 * "nothing to buy" would be making that claim on the strength of something the
 * backend explicitly refused to decide. So the headline prints three figures,
 * always, and the undetermined one is never folded into the free one.
 *
 * THE ARITHMETIC IS THE SERVER'S. Every printed figure is a `totals` lookup. A
 * lane that re-derived the counts from `correlations` would be free to disagree
 * with the endpoint that computed them, which is the failure `gates.ts` exists
 * to prevent one layer down — so the totals here are deliberately handed numbers
 * the card list does NOT support, and the screen must still print the totals.
 *
 * THE DENSITY. Each gap arrives as four sentences. What renders is the blocking
 * signal, the kind and the door; the summary, the estate's own gating figure and
 * the remedy stay reachable on the element rather than printed under it.
 */
import { screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";

import Correlations, { hardwareVerdict } from "./Correlations";
import { bi } from "../api";

const auth = { can: (_p: string) => true, hasModule: (_m: string) => true };
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ can: (p: string) => auth.can(p), hasModule: (m: string) => auth.hasModule(m) }),
}));

const unitGap = {
  kind: "unit_unconfirmed",
  needs_new_hardware: false,
  summary: "The measurement is arriving; nobody has said what it is in.",
  remedy: "Confirm the unit on the points listed. The platform will not infer one from the tag.",
  where: "Building Intelligence → Units",
  gate: "3 points match and none carries a confirmed unit.",
};

const visionGap = {
  kind: "module_population_unknown",
  // THE THIRD STATE. Not false.
  needs_new_hardware: null,
  summary: "This store cannot see the module at all, so its population is unknown.",
  remedy: "Register the module's projection so its events reach the reporting store.",
  where: "Configurations → Integrations",
  gate: "No vision projection is registered for this tenant.",
};

const blockedByUnit = {
  key: "ambient_chiller",
  name: "Ambient ↔ chiller load",
  question: "Does the chiller's draw track the outside air?",
  unlocks: "Weather-normalised plant efficiency",
  domains: ["hvac"],
  state: "blocked",
  signals: [
    {
      key: "chiller_kw",
      label: "Chiller power",
      domain: "hvac",
      source: "point_live",
      unlocks: "the load axis",
      satisfied: true,
      gap: null,
      evidence: {},
    },
    {
      key: "ambient_temp",
      label: "Ambient temperature",
      domain: "weather",
      source: "point_unit",
      unlocks: "the outside-air axis",
      satisfied: false,
      gap: unitGap,
      evidence: {},
    },
  ],
  blocking_gap: { signal: "ambient_temp", ...unitGap },
};

const blockedByVision = {
  key: "people_fresh_air",
  name: "People count ↔ fresh air",
  question: "Is the fresh-air rate matched to occupancy?",
  unlocks: "Ventilation right-sizing",
  domains: ["hvac"],
  state: "blocked",
  signals: [
    {
      key: "people_count",
      label: "People count",
      domain: "vision",
      source: "projection",
      unlocks: "the occupancy axis",
      satisfied: false,
      gap: visionGap,
      evidence: {},
    },
  ],
  blocking_gap: { signal: "people_count", ...visionGap },
};

const liveOne = {
  key: "dg_scope1",
  name: "DG runtime ↔ Scope-1",
  question: "What did the generator emit?",
  unlocks: "A Scope-1 figure with a citation",
  domains: ["energy"],
  state: "live",
  signals: [
    {
      key: "dg_runtime",
      label: "DG runtime",
      domain: "energy",
      source: "point_live",
      unlocks: "the runtime axis",
      satisfied: true,
      gap: null,
      evidence: {},
    },
  ],
  blocking_gap: null,
};

/** The live shape: 7 questions, none live, seven blocked, nothing to buy and ONE
 *  gap the store cannot decide about. */
const totals = (over: Record<string, unknown> = {}) => ({
  correlations: 7,
  live: 0,
  blocked: 7,
  blocking_gaps: 7,
  blocking_gaps_by_kind: {
    unit_unconfirmed: 2,
    module_unpopulated: 2,
    role_unbound: 1,
    site_fact_unrecorded: 1,
    module_population_unknown: 1,
  },
  needs_new_hardware: 0,
  no_new_hardware_needed: 6,
  hardware_undetermined: 1,
  signal_gaps: 8,
  signal_gaps_by_kind: {},
  signal_gaps_needing_new_hardware: 0,
  signal_gaps_needing_no_new_hardware: 7,
  signal_gaps_hardware_undetermined: 1,
  ...over,
});

function registry(over: Record<string, unknown> = {}) {
  return vi.spyOn(bi, "correlations").mockResolvedValue({
    start: "2026-09-12T00:00:00Z",
    end: "2026-09-19T00:00:00Z",
    hours: 168,
    totals: totals(),
    correlations: [blockedByUnit, blockedByVision],
    ...over,
  });
}

beforeEach(() => {
  auth.can = () => true;
  auth.hasModule = () => true;
});

describe("the pitch", () => {
  it("prints the three hardware buckets, never two", async () => {
    registry();

    renderWithProviders(<Correlations />);

    expect(await screen.findByText("0")).toBeInTheDocument();
    expect(screen.getByText("of the 7 blocked need new hardware bought")).toBeInTheDocument();
    expect(screen.getByText("6 need nothing bought")).toBeInTheDocument();
    // The third bucket, and it is on screen even though the headline would read
    // better without it.
    expect(screen.getByText("1 undetermined")).toBeInTheDocument();
  });

  it("never folds an undetermined gap into the ones that cost nothing", async () => {
    // Everything is undetermined and nothing is known to be free. A lane that
    // added the two buckets would print "7 need nothing bought" here, which is
    // the claim the backend refused to make.
    registry({
      totals: totals({ needs_new_hardware: 0, no_new_hardware_needed: 0, hardware_undetermined: 7 }),
    });

    renderWithProviders(<Correlations />);

    expect(await screen.findByText("7 undetermined")).toBeInTheDocument();
    expect(screen.getByText("0 need nothing bought")).toBeInTheDocument();
    expect(screen.queryByText("7 need nothing bought")).toBeNull();
  });

  it("reads the totals rather than counting the cards", async () => {
    // Two cards, seven questions. The endpoint counted under one window in one
    // statement; a lane doing its own arithmetic would print 2 and disagree with
    // the thing that computed it.
    registry();

    renderWithProviders(<Correlations />);

    expect(await screen.findByText("7")).toBeInTheDocument();
    expect(screen.getByText("0 live")).toBeInTheDocument();
    expect(screen.getByText("7 blocked")).toBeInTheDocument();
  });

  it("says nothing about an estate the registry never answered for", async () => {
    // Absent is not zero: a registry that did not reply has not said this estate
    // has no cross-domain questions.
    vi.spyOn(bi, "correlations").mockResolvedValue({ hours: 168 });

    renderWithProviders(<Correlations />);

    expect(
      await screen.findByText(/registry did not answer, so nothing here knows which questions/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/need new hardware bought/)).toBeNull();
  });
});

describe("a card", () => {
  it("names the blocking signal, its kind and the door that closes it", async () => {
    registry();

    renderWithProviders(<Correlations />);

    const card = await screen.findByRole("article", { name: "Ambient ↔ chiller load" });
    // The signal an operator would recognise, not the key the gap names it by.
    expect(within(card).getByText(/Ambient temperature — unit unconfirmed/)).toBeInTheDocument();
    expect(within(card).getByRole("link", { name: /Building Intelligence → Units/ })).toHaveAttribute(
      "href",
      "/bi/ratings",
    );
  });

  it("shows which half of the question the estate already supplies", async () => {
    registry();

    renderWithProviders(<Correlations />);

    // Both signals are chips, and they do not read the same: one is supplied,
    // one is the gap. A card that printed only the blockage would hide that the
    // question is half answerable.
    const card = await screen.findByRole("article", { name: "Ambient ↔ chiller load" });
    expect(within(card).getByTitle(/Chiller power — supplied by this estate/)).toHaveTextContent(
      "Chiller power",
    );
    const gapped = within(card).getAllByTitle(/nobody has said what it is in/);
    expect(gapped.some((el) => el.textContent === "Ambient temperature")).toBe(true);
  });

  it("names the room but offers no door this app cannot open", async () => {
    registry();

    renderWithProviders(<Correlations />);

    await screen.findByText("People count ↔ fresh air");
    // There is no Integrations route in this app. The surface is still named —
    // a link that 404s is worse than the room's name.
    expect(screen.getByText("Configurations → Integrations")).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: /Configurations → Integrations/ }),
    ).not.toBeInTheDocument();
  });

  it("calls an undetermined gap undetermined on the card too", async () => {
    registry();

    renderWithProviders(<Correlations />);

    const card = await screen.findByRole("article", { name: "People count ↔ fresh air" });
    expect(within(card).getByText("undetermined")).toBeInTheDocument();
    expect(within(card).queryByText(/nothing to buy/)).toBeNull();
  });

  it("reads as live when every signal is supplied", async () => {
    registry({
      totals: totals({ live: 1, blocked: 6 }),
      correlations: [liveOne, blockedByUnit],
    });

    renderWithProviders(<Correlations />);

    expect(await screen.findByText("live")).toBeInTheDocument();
    expect(
      screen.getByText("Every signal is supplied — this question is being asked."),
    ).toBeInTheDocument();
  });

  it("keeps the gap's four sentences reachable while printing the short form", async () => {
    // JOB 1, ON THIS LANE. The API hands back a summary, this estate's own gating
    // figure and a remedy. None is printed under the card; all three are on the
    // line that is.
    registry();

    renderWithProviders(<Correlations />);

    const card = await screen.findByRole("article", { name: "Ambient ↔ chiller load" });
    const short = within(card).getByText(/Ambient temperature — unit unconfirmed/);
    expect(short).toHaveAttribute(
      "title",
      expect.stringContaining("3 points match and none carries a confirmed unit."),
    );
    expect(short).toHaveAttribute("title", expect.stringContaining("nobody has said what it is in"));
    // And the paragraph itself is not on the screen.
    expect(screen.queryByText(/The platform will not infer one from the tag/)).toBeNull();
  });
});

describe("a caller who may not read Building Intelligence", () => {
  it("sees no lane, and is never charged for the request", async () => {
    const spy = registry();
    auth.can = (p: string) => p !== "bi.read";

    const { container } = renderWithProviders(<Correlations />);

    await waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(spy).not.toHaveBeenCalled();
  });

  it("sees no lane without the analytics module either", async () => {
    const spy = registry();
    auth.hasModule = (m: string) => m !== "analytics";

    const { container } = renderWithProviders(<Correlations />);

    await waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("the tri-state itself", () => {
  it("answers three ways and never two", () => {
    expect(hardwareVerdict(true).text).toBe("needs new hardware");
    expect(hardwareVerdict(false).text).toBe("nothing to buy");
    // The two that must NOT read as "nothing to buy".
    expect(hardwareVerdict(null).text).toBe("undetermined");
    expect(hardwareVerdict(undefined).text).toBe("undetermined");
  });
});
