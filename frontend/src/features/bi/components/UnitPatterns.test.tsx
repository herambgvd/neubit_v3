/**
 * THE PATTERN CATALOGUE exists because the server was allowed to expand a
 * pattern on its own — a prohibition `units.py` used to state outright, repealed
 * on ONE condition: the operator can still see the actual rows before they
 * apply. Every property below is that condition made checkable:
 *
 *   • a bulk confirmation is impossible until a DRY RUN has come back, and what
 *     the dry run renders is the ROWS, not merely `would_update_count`;
 *   • a `state` or `ambiguous` pattern renders as a deliberate answer — its
 *     reason, and nothing to press — rather than as an error or an empty state;
 *   • `unit: ""` (dimensionless, a real assertion) and `unit: null` (nothing
 *     proposed) read differently;
 *   • a viewer without `bi.manage` is offered no control at all, not even the
 *     preview — the dry run is a POST behind the same key.
 */
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";

import UnitPatterns from "./UnitPatterns";
import { bi } from "../api";

const can = vi.fn(() => true);
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ can: (p: string) => canRef.fn(p) }) }));
const canRef = { fn: can as (p: string) => boolean };

interface Pattern {
  key: string;
  label: string;
  kind: string;
  unit: string | null;
  proposes_unit: boolean;
  basis: string;
  matched: number;
  eligible: number;
  already_confirmed: number;
  sample_tags?: string[];
  categories?: string[];
}

const pattern = (over: Partial<Pattern> & { key: string }): Pattern => ({
  label: "Active power",
  kind: "unit",
  unit: "kW",
  proposes_unit: true,
  basis: "the tag ends in `_kw`",
  matched: 12,
  eligible: 12,
  already_confirmed: 0,
  sample_tags: ["1F_KW", "2F_KW"],
  ...over,
});

function catalogue(patterns: Pattern[]) {
  return vi.spyOn(bi, "unitPatterns").mockResolvedValue({
    patterns,
    totals: {
      points: 766,
      matched: patterns.reduce((n, p) => n + p.matched, 0),
      unmatched: 31,
      eligible: patterns.reduce((n, p) => n + p.eligible, 0),
      already_confirmed: patterns.reduce((n, p) => n + p.already_confirmed, 0),
    },
    unmatched_sample: ["Batt_Time_Rem", "Point1"],
  });
}

const renderPanel = () => {
  renderWithProviders(<UnitPatterns />);
  return userEvent.setup();
};

beforeEach(() => {
  canRef.fn = () => true;
});

describe("the dry run before the apply", () => {
  const dryRes = {
    mode: "pattern",
    dry_run: true,
    pattern: "active_power_kw",
    updated: 0,
    would_update_count: 2,
    would_update: [
      { point_id: "p1", label: "1F-DB / 1F_KW" },
      { point_id: "p2", label: "2F-DB / 2F_KW" },
    ],
    skipped_already_confirmed: [],
    skipped_already_confirmed_count: 0,
    unit: "kW",
    confirmed_not_reporting: [],
  };

  it("offers no apply button until the rows have been resolved", async () => {
    catalogue([pattern({ key: "active_power_kw", eligible: 2 })]);

    renderPanel();

    expect(await screen.findByRole("button", { name: /Show the 2 point/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Confirm these/ })).not.toBeInTheDocument();
  });

  it("renders the ACTUAL ROWS, not just how many there are", async () => {
    catalogue([pattern({ key: "active_power_kw", eligible: 2 })]);
    const confirm = vi.spyOn(bi, "confirmUnitPattern").mockResolvedValue(dryRes);
    const user = renderPanel();

    await user.click(await screen.findByRole("button", { name: /Show the 2 point/ }));

    // The names. A count-only screen is exactly what the repealed prohibition
    // was about, so both labels must be on screen.
    expect(await screen.findByText("1F-DB / 1F_KW")).toBeInTheDocument();
    expect(screen.getByText("2F-DB / 2F_KW")).toBeInTheDocument();
    expect(confirm).toHaveBeenCalledWith({
      pattern: "active_power_kw",
      category: undefined,
      dry_run: true,
    });
    expect(screen.getByText(/Nothing has been written/i)).toBeInTheDocument();
  });

  it("applies only after the preview, and only then writes", async () => {
    catalogue([pattern({ key: "active_power_kw", eligible: 2 })]);
    const confirm = vi
      .spyOn(bi, "confirmUnitPattern")
      .mockResolvedValueOnce(dryRes)
      .mockResolvedValueOnce({ ...dryRes, dry_run: false, updated: 2, would_update: null });
    const user = renderPanel();

    await user.click(await screen.findByRole("button", { name: /Show the 2 point/ }));
    await user.click(await screen.findByRole("button", { name: /Confirm these 2 point/ }));

    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(2));
    expect(confirm.mock.calls[0][0]).toMatchObject({ dry_run: true });
    expect(confirm.mock.calls[1][0]).toMatchObject({
      pattern: "active_power_kw",
      dry_run: false,
    });
    expect(await screen.findByText(/2 point\(s\) recorded as/)).toBeInTheDocument();
  });

  it("names the rows a person already ruled on, apart from the ones it would write", async () => {
    catalogue([pattern({ key: "active_power_kw", eligible: 2, already_confirmed: 1 })]);
    vi.spyOn(bi, "confirmUnitPattern").mockResolvedValue({
      ...dryRes,
      skipped_already_confirmed: [{ point_id: "p9", point_tag: "3F_KW", unit: "kW", unit_source: "operator" }],
      skipped_already_confirmed_count: 1,
    });
    const user = renderPanel();

    await user.click(await screen.findByRole("button", { name: /Show the 2 point/ }));

    expect(await screen.findByText(/A pattern never overrules a person/i)).toBeInTheDocument();
    expect(screen.getByText("3F_KW")).toBeInTheDocument();
  });
});

describe("a pattern that proposes nothing", () => {
  it("renders a STATE pattern as a deliberate answer with its reason, and no apply", async () => {
    catalogue([
      pattern({
        key: "on_off_state",
        label: "On/off state",
        kind: "state",
        unit: null,
        proposes_unit: false,
        basis: "the tag ends in `STS` — a state, not a measurement",
        eligible: 40,
      }),
    ]);

    renderPanel();

    expect(await screen.findByText("state, not a measurement")).toBeInTheDocument();
    expect(
      screen.getByText(/these tags are a state, not a measurement, so there is no unit to write/i),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Show the 40 point/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Confirm these/ })).not.toBeInTheDocument();
  });

  it("renders an AMBIGUOUS pattern as the collision it is, not as an error", async () => {
    catalogue([
      pattern({
        key: "kw_amps_collision",
        label: "Power tag with an amps suffix",
        kind: "ambiguous",
        unit: null,
        proposes_unit: false,
        basis: "`KWL1_A` names power and ends in the amps suffix",
        eligible: 6,
      }),
    ]);

    renderPanel();

    expect(await screen.findByText("ambiguous tag")).toBeInTheDocument();
    expect(
      screen.getByText(/the tag names one quantity and carries another's suffix/i),
    ).toBeInTheDocument();
    // Not an error line, and not an empty state.
    expect(screen.queryByText(/Could not load/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/No tag convention matches/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Show the 6 point/ })).not.toBeInTheDocument();
  });
});

describe("an empty unit is not a missing one", () => {
  it("reads a confirmed dimensionless unit as the assertion it is", async () => {
    catalogue([
      pattern({ key: "power_factor", label: "Power factor", unit: "", basis: "the tag is `PF`" }),
    ]);

    renderPanel();

    expect(await screen.findByText(/dimensionless — a ratio, deliberately no unit/)).toBeInTheDocument();
    expect(screen.queryByText("no unit proposed")).not.toBeInTheDocument();
  });

  it("reads a null unit as nothing proposed", async () => {
    catalogue([
      pattern({ key: "on_off_state", kind: "state", unit: null, proposes_unit: false }),
    ]);

    renderPanel();

    expect(await screen.findByText("no unit proposed")).toBeInTheDocument();
    expect(screen.queryByText(/dimensionless/)).not.toBeInTheDocument();
  });
});

describe("an operator without bi.manage", () => {
  it("reads the catalogue and is offered nothing to press", async () => {
    canRef.fn = () => false;
    const confirm = vi.spyOn(bi, "confirmUnitPattern");
    catalogue([pattern({ key: "active_power_kw", eligible: 2 })]);

    renderPanel();

    await screen.findByText("Active power");
    expect(screen.getByText(/Confirming a convention needs/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Show the 2 point/ })).not.toBeInTheDocument();
    expect(confirm).not.toHaveBeenCalled();
  });
});
