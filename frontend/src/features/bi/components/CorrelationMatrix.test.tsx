/**
 * The matrix exists to keep four states apart that a naive grid renders
 * identically as a number:
 *
 *   ok                a coefficient, with the bucket count beside it — +0.98
 *                     over 4 buckets and over 400 are different claims
 *   undefined_frozen  one side never moved, so Pearson has NO value. The cell
 *                     must say UNDEF; a 0.00 here is a fabricated finding
 *   no_overlap        the two series never filled the same bucket
 *   too_few           fewer overlaps than the server's floor
 *
 * A cell is also only coloured when the coefficient is DEFINED — colour on an
 * undefined cell reads as a measurement.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import CorrelationMatrix, { fmtR, type CorrPair, type CorrSeries } from "./CorrelationMatrix";

const s = (id: string, tag: string, frozen = false): CorrSeries => ({
  point_id: id,
  point_tag: tag,
  device_tag: "CH-1",
  category: "hvac",
  buckets: 100,
  distinct_values: frozen ? 1 : 50,
  frozen,
});

const A = s("p1", "OWT");
const B = s("p2", "IWT");

function pair(over: Partial<CorrPair> = {}): CorrPair {
  return { a: "p1", b: "p2", n: 96, r: 0.87, status: "ok", reason: "computed", ...over };
}

const renderMatrix = (pairs: CorrPair[], series: CorrSeries[] = [A, B]) =>
  render(<CorrelationMatrix series={series} pairs={pairs} />);

describe("fmtR", () => {
  it.each([
    ["a positive coefficient with an explicit sign", 0.8712, "+0.87"],
    ["a negative coefficient", -0.8712, "-0.87"],
    ["a perfect correlation", 1, "+1.00"],
    ["zero, which is a real coefficient", 0, "+0.00"],
  ])("prints %s as %s", (_label, r, expected) => {
    expect(fmtR(r)).toBe(expected);
  });

  it.each([
    ["an absent coefficient", null],
    ["an undefined coefficient", undefined],
    ["a non-finite coefficient", NaN],
    ["an infinite coefficient", Infinity],
  ])("prints %s as an em dash, never as a number", (_label, r) => {
    expect(fmtR(r)).toBe("—");
  });
});

describe("a defined coefficient", () => {
  it("shows the number AND the bucket count it rests on", () => {
    renderMatrix([pair({ r: 0.87, n: 96 })]);

    // Both cells of the symmetric pair carry it.
    expect(screen.getAllByText("+0.87").length).toBeGreaterThan(0);
    expect(screen.getAllByText("n=96").length).toBeGreaterThan(0);
  });

  it("is the only kind of cell that is given a colour", () => {
    const { container } = renderMatrix([pair()]);
    const coloured = [...container.querySelectorAll("td")].filter((td) =>
      (td.getAttribute("style") ?? "").includes("background"),
    );
    expect(coloured.length).toBeGreaterThan(0);
  });
});

describe("a coefficient that does not exist", () => {
  it("says UNDEF for a frozen series rather than showing it as zero", () => {
    renderMatrix([pair({ r: null, status: "undefined_frozen", reason: "OWT never moved" })], [
      s("p1", "OWT", true),
      B,
    ]);

    expect(screen.getAllByText("UNDEF").length).toBeGreaterThan(0);
    // ANY correlation value, not two spellings of zero. The component formats as
    // `(r >= 0 ? "+" : "") + r.toFixed(2)`, so a bare "0.00" can never render and
    // asserting its absence could not fail — while a bug that printed "-0.50"
    // would have passed both of the literals this replaces.
    expect(screen.queryByText(/^[+-]\d+\.\d{2}$/)).not.toBeInTheDocument();
  });

  it("marks the frozen series itself, so the reader knows which side is stuck", () => {
    renderMatrix([pair({ r: null, status: "undefined_frozen" })], [s("p1", "OWT", true), B]);

    expect(screen.getByText("frozen")).toBeInTheDocument();
  });

  it("distinguishes 'never shared a bucket' from 'too few buckets'", () => {
    renderMatrix([pair({ r: null, n: 0, status: "no_overlap" })]);
    expect(screen.getAllByText("NO OVERLAP").length).toBeGreaterThan(0);

    renderMatrix([pair({ r: null, n: 2, status: "too_few" })]);
    expect(screen.getAllByText("n TOO LOW").length).toBeGreaterThan(0);
  });

  it("shows a status it has no wording for AS SENT rather than blank", () => {
    renderMatrix([pair({ r: null, status: "some_new_server_state" })]);

    expect(screen.getAllByText("some_new_server_state").length).toBeGreaterThan(0);
  });

  it("still reports n, because zero overlaps is itself the finding", () => {
    renderMatrix([pair({ r: null, n: 0, status: "no_overlap" })]);

    expect(screen.getAllByText("n=0").length).toBeGreaterThan(0);
  });

  it("gives an undefined cell no colour", () => {
    const { container } = renderMatrix([pair({ r: null, status: "undefined_frozen" })]);
    const coloured = [...container.querySelectorAll("td")].filter((td) =>
      (td.getAttribute("style") ?? "").includes("background"),
    );
    expect(coloured).toHaveLength(0);
  });
});

describe("a pair the server did not return", () => {
  it("renders as absent rather than as a zero coefficient", () => {
    renderMatrix([]);

    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
    expect(screen.queryByText("+0.00")).not.toBeInTheDocument();
  });
});

describe("selecting a cell", () => {
  it("hands back the two point ids, in the order the grid crossed them", async () => {
    const onSelect = vi.fn();
    render(<CorrelationMatrix series={[A, B]} pairs={[pair()]} onSelect={onSelect} />);
    const user = userEvent.setup();

    await user.click(screen.getAllByText("+0.87")[0]);

    expect(onSelect).toHaveBeenCalledWith("p1", "p2");
  });
});
