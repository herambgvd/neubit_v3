/**
 * UNITS is the screen whose single rule is "the platform may SUGGEST a unit from
 * a tag; only a human may STORE one". Every property below is that rule made
 * checkable:
 *
 *   • a suggestion is rendered WITH the basis it matched and is never written
 *     until the operator confirms an explicit list of point ids;
 *   • bulk is a SELECTION, not a server-side pattern expansion — the button
 *     ticks the rows and the POST still carries their ids;
 *   • `acknowledge_not_reporting` is sent ONLY in answer to the refusal, never
 *     by default, or the guard it defeats may as well not exist;
 *   • a failed load reports the failure, not an estate with nothing to confirm.
 */
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";

import UnitsPanel from "./UnitsPanel";
import { bi } from "../api";

const can = vi.fn(() => true);
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ can: (p: string) => canRef.fn(p) }) }));
const canRef = { fn: can as (p: string) => boolean };

interface Row {
  point_id: string;
  device_tag: string;
  point_tag: string;
  type: string;
  unit: string | null;
  unit_source: string | null;
  unit_confirmed_by?: string | null;
  suggestion?: { unit: string; basis: string } | null;
}

const row = (over: Partial<Row> & { point_id: string; point_tag: string }): Row => ({
  device_tag: "MTR-1",
  type: "num",
  unit: null,
  unit_source: null,
  suggestion: null,
  ...over,
});

function unitsReturn(items: Row[], counts?: unknown) {
  return vi.spyOn(bi, "units").mockResolvedValue({ items, total: items.length, counts });
}

const renderPanel = () => {
  renderWithProviders(<UnitsPanel />);
  return userEvent.setup();
};

beforeEach(() => {
  canRef.fn = () => true;
});

describe("a failed load", () => {
  it("reports the failure instead of an estate with nothing to confirm", async () => {
    vi.spyOn(bi, "units").mockRejectedValue(new Error("reading store is unreachable"));

    renderPanel();

    expect(await screen.findByText(/reading store is unreachable/i)).toBeInTheDocument();
    expect(screen.queryByText(/nothing matches this filter/i)).not.toBeInTheDocument();
  });

  it("says nothing matches when the filter genuinely returns nothing", async () => {
    unitsReturn([]);

    renderPanel();

    expect(await screen.findByText(/nothing matches this filter/i)).toBeInTheDocument();
  });
});

describe("what a row says about who stated the unit", () => {
  it("names the operator for a confirmed unit", async () => {
    unitsReturn([
      row({ point_id: "p1", point_tag: "KWH", unit: "kWh", unit_source: "operator", unit_confirmed_by: "asha@x.io" }),
    ]);

    renderPanel();

    expect(await screen.findByText("asha@x.io")).toBeInTheDocument();
  });

  it("says NOBODY stated it, rather than leaving the cell ambiguous", async () => {
    unitsReturn([row({ point_id: "p1", point_tag: "KWH" })]);

    renderPanel();

    expect(await screen.findByText("nobody")).toBeInTheDocument();
    expect(screen.getByText("not recorded")).toBeInTheDocument();
  });

  it("credits the wire when the unit came off a reading rather than a human", async () => {
    unitsReturn([row({ point_id: "p1", point_tag: "KWH", unit: "kWh", unit_source: "reading" })]);

    renderPanel();

    expect(await screen.findByText(/the wire \(env\.u\)/i)).toBeInTheDocument();
  });

  it("renders a confirmed EMPTY unit as a ratio, not as an unconfirmed point", async () => {
    unitsReturn([row({ point_id: "p1", point_tag: "PF", unit: "", unit_source: "operator" })]);

    renderPanel();

    expect(await screen.findByText("— (a ratio)")).toBeInTheDocument();
    expect(screen.queryByText("not recorded")).not.toBeInTheDocument();
  });
});

describe("a suggestion", () => {
  it("is shown with the pattern it matched, so the operator confirms a REASON", async () => {
    unitsReturn([
      row({ point_id: "p1", point_tag: "KWH_kwh", suggestion: { unit: "kWh", basis: "the tag ends in `_kwh`" } }),
    ]);

    renderPanel();

    // Once in the row itself, once in the bulk-select button it powers.
    expect(await screen.findAllByText(/the tag ends in `_kwh`/)).not.toHaveLength(0);
  });

  it("says no pattern matched rather than offering a guess", async () => {
    unitsReturn([row({ point_id: "p1", point_tag: "4F-3F AC DB" })]);

    renderPanel();

    expect(await screen.findByText(/no pattern matched/i)).toBeInTheDocument();
  });

  it("is never stored by merely being displayed", async () => {
    const confirm = vi.spyOn(bi, "confirmUnits").mockResolvedValue({ updated: 1, unit: "kWh" });
    unitsReturn([
      row({ point_id: "p1", point_tag: "KWH_kwh", suggestion: { unit: "kWh", basis: "the tag ends in `_kwh`" } }),
    ]);

    renderPanel();
    await screen.findByText("KWH_kwh");

    expect(confirm).not.toHaveBeenCalled();
  });
});

describe("the bulk path", () => {
  it("offers a group per suggestion basis, counting the rows it would tick", async () => {
    unitsReturn([
      row({ point_id: "p1", point_tag: "A_kwh", suggestion: { unit: "kWh", basis: "the tag ends in `_kwh`" } }),
      row({ point_id: "p2", point_tag: "B_kwh", suggestion: { unit: "kWh", basis: "the tag ends in `_kwh`" } }),
      row({ point_id: "p3", point_tag: "C_degc", suggestion: { unit: "°C", basis: "the tag ends in `_degc`" } }),
    ]);

    renderPanel();

    expect(await screen.findByText(/Select 2 where the tag ends in `_kwh`/)).toBeInTheDocument();
    expect(screen.getByText(/Select 1 where the tag ends in `_degc`/)).toBeInTheDocument();
  });

  it("posts the SELECTED point ids, never a pattern for the server to expand", async () => {
    const confirm = vi.spyOn(bi, "confirmUnits").mockResolvedValue({ updated: 2, unit: "kWh" });
    unitsReturn([
      row({ point_id: "p1", point_tag: "A_kwh", suggestion: { unit: "kWh", basis: "the tag ends in `_kwh`" } }),
      row({ point_id: "p2", point_tag: "B_kwh", suggestion: { unit: "kWh", basis: "the tag ends in `_kwh`" } }),
    ]);
    const user = renderPanel();

    await user.click(await screen.findByText(/Select 2 where/));
    expect(await screen.findByText(/2 points selected/i)).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText(/unit, e.g. kWh/i), "kWh");
    await user.click(screen.getByRole("button", { name: /confirm as/i }));

    await waitFor(() =>
      expect(confirm).toHaveBeenCalledWith({
        point_ids: ["p1", "p2"],
        unit: "kWh",
        acknowledge_not_reporting: undefined,
      }),
    );
  });

  it("keeps clearing a unit reachable, since a mis-typed one would poison a rating", async () => {
    const confirm = vi.spyOn(bi, "confirmUnits").mockResolvedValue({ updated: 1, unit: null });
    unitsReturn([row({ point_id: "p1", point_tag: "KWH", unit: "kWh", unit_source: "operator" })]);
    const user = renderPanel();

    await user.click(await screen.findByText("KWH"));
    await user.click(screen.getByRole("button", { name: /clear unit/i }));

    await waitFor(() =>
      expect(confirm).toHaveBeenCalledWith(
        expect.objectContaining({ point_ids: ["p1"], unit: null }),
      ),
    );
    expect(await screen.findByText(/cleared back to unconfirmed/i)).toBeInTheDocument();
  });
});

describe("the not-reporting refusal", () => {
  const refusal = {
    response: {
      data: {
        error: {
          code: "POINT_NOT_REPORTING",
          message: "Not stored: 1 point is carrying no readings.",
          details: {
            points: [
              {
                point_id: "p1",
                device_tag: "4FKC2",
                point_tag: "IWT",
                state: "never_reported",
                last_reading_at: null,
                reporting_siblings: ["4FKC2_IWT"],
              },
            ],
          },
        },
      },
    },
  };

  async function selectAndConfirm() {
    unitsReturn([row({ point_id: "p1", point_tag: "IWT" })]);
    const user = renderPanel();
    await user.click(await screen.findByText("IWT"));
    await user.type(screen.getByPlaceholderText(/unit, e.g. kWh/i), "degC");
    await user.click(screen.getByRole("button", { name: /confirm as/i }));
    return user;
  }

  it("never sends the acknowledgement on the FIRST attempt", async () => {
    const confirm = vi.spyOn(bi, "confirmUnits").mockRejectedValue(refusal);

    await selectAndConfirm();

    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(confirm.mock.calls[0][0]).toMatchObject({ acknowledge_not_reporting: undefined });
  });

  it("renders the challenge — with the working sibling tag — not a generic error line", async () => {
    vi.spyOn(bi, "confirmUnits").mockRejectedValue(refusal);

    await selectAndConfirm();

    expect(await screen.findByText(/4FKC2_IWT/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /assert anyway/i })).toBeInTheDocument();
  });

  it("sends the acknowledgement only when the operator presses assert anyway", async () => {
    const confirm = vi.spyOn(bi, "confirmUnits").mockRejectedValue(refusal);

    const user = await selectAndConfirm();
    await screen.findByRole("button", { name: /assert anyway/i });
    await user.click(screen.getByRole("button", { name: /assert anyway/i }));

    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(2));
    expect(confirm.mock.calls[1][0]).toMatchObject({
      point_ids: ["p1"],
      acknowledge_not_reporting: true,
    });
  });

  it("reports an unrelated failure as an error rather than as this challenge", async () => {
    vi.spyOn(bi, "confirmUnits").mockRejectedValue(new Error("database is on fire"));

    await selectAndConfirm();

    expect(await screen.findByText(/database is on fire/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /assert anyway/i })).not.toBeInTheDocument();
  });
});

describe("an operator without bi.manage", () => {
  it("can read what has been confirmed but is offered nothing to press", async () => {
    canRef.fn = () => false;
    unitsReturn([
      row({ point_id: "p1", point_tag: "A_kwh", suggestion: { unit: "kWh", basis: "the tag ends in `_kwh`" } }),
    ]);
    const user = renderPanel();

    await screen.findByText("A_kwh");
    expect(screen.getByText(/Recording a unit needs/i)).toBeInTheDocument();
    expect(screen.queryByText(/Select 1 where/)).not.toBeInTheDocument();

    // Clicking a row selects nothing, so no confirmation bar can appear.
    await user.click(screen.getByText("A_kwh"));
    expect(screen.queryByPlaceholderText(/unit, e.g. kWh/i)).not.toBeInTheDocument();
  });
});
