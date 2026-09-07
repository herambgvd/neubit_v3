/**
 * THE CHALLENGE is what an operator sees instead of a silent success when they
 * assert a unit or a role on a point that carries no readings. Two properties:
 *
 *   1. `notReportingDetail` must recognise the refusal by its MACHINE CODE and
 *      nothing else — matching on message text would turn every unrelated 422
 *      into this dialog, and a missed match turns the refusal into a generic
 *      error line, which is exactly the silent outcome the guard exists for.
 *   2. The panel must show the spelling that WORKS beside the one that does not
 *      (the reporting siblings on the same device) and must not offer to rebind
 *      anything — clicking a sibling is deliberately inert.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import NotReportingChallenge, {
  notReportingDetail,
  type NotReportingDetail,
} from "./NotReportingChallenge";

/** An axios-shaped rejection carrying the uniform error envelope. */
const refusal = (code: string, details?: unknown) => ({
  response: { data: { error: { code, message: "Not stored", details } } },
});

describe("notReportingDetail", () => {
  it("recognises the refusal by its code and hands back the details", () => {
    const details = { requested: 3, challenged: 1 };
    expect(notReportingDetail(refusal("POINT_NOT_REPORTING", details))).toEqual(details);
  });

  it("returns an empty detail rather than null when the code is right but details are absent", () => {
    // The dialog must still open: the refusal happened.
    expect(notReportingDetail(refusal("POINT_NOT_REPORTING"))).toEqual({});
  });

  it.each([
    ["a different backend refusal", refusal("VALIDATION_ERROR", {})],
    ["an error with no envelope at all", new Error("network down")],
    ["null", null],
    ["undefined", undefined],
  ])("declines to claim %s is this refusal", (_label, error) => {
    expect(notReportingDetail(error)).toBeNull();
  });
});

const DETAIL: NotReportingDetail = {
  thresholds: { silent_after_hours: 24 },
  points: [
    {
      point_id: "p1",
      device_tag: "4FKC2",
      point_tag: "IWT",
      state: "never_reported",
      last_reading_at: null,
      reporting_siblings: ["4FKC2_IWT", "4FKC2_OWT"],
    },
    {
      point_id: "p2",
      device_tag: "4FKC2",
      point_tag: "AMPS",
      state: "silent",
      last_reading_at: "2026-01-01T09:30:00Z",
      reporting_siblings: [],
    },
  ],
};

const renderChallenge = (detail = DETAIL, onAssertAnyway = vi.fn(), onCancel = vi.fn()) => {
  render(
    <NotReportingChallenge
      detail={detail}
      onAssertAnyway={onAssertAnyway}
      onCancel={onCancel}
    />,
  );
  return { onAssertAnyway, onCancel };
};

describe("the challenge panel", () => {
  it("distinguishes an address that never reported from one that went silent", () => {
    renderChallenge();

    expect(screen.getByText(/never reported — this address has produced no value, ever/i)).toBeInTheDocument();
    expect(screen.getByText(/silent — nothing for over 24h/i)).toBeInTheDocument();
  });

  it("uses the server's own silence threshold rather than a hard-coded one", () => {
    renderChallenge({ ...DETAIL, thresholds: { silent_after_hours: 6 } });

    expect(screen.getByText(/nothing for over 6h/i)).toBeInTheDocument();
  });

  it("puts the spelling that WORKS on screen beside the one that does not", () => {
    renderChallenge();

    expect(screen.getByText("4FKC2_IWT, 4FKC2_OWT")).toBeInTheDocument();
  });

  it("says so plainly when the whole device is quiet, rather than showing a blank", () => {
    renderChallenge();

    expect(screen.getByText(/nothing on this device is reporting/i)).toBeInTheDocument();
  });

  it("prints 'never' rather than an empty cell for a point with no last reading", () => {
    renderChallenge();

    expect(screen.getByText("never")).toBeInTheDocument();
    expect(screen.getByText("2026-01-01 09:30:00")).toBeInTheDocument();
  });

  it("counts the challenged points in its own message when the server sent none", () => {
    renderChallenge();

    expect(screen.getByText(/2 of the selected point\(s\) are carrying no readings/i)).toBeInTheDocument();
  });

  it("prefers the server's message when there is one", () => {
    render(
      <NotReportingChallenge
        detail={DETAIL}
        message="Not stored: 1 point has never reported."
        onAssertAnyway={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByText("Not stored: 1 point has never reported.")).toBeInTheDocument();
  });

  it("offers a deliberate second press rather than rebinding anything itself", async () => {
    const { onAssertAnyway } = renderChallenge();
    const user = userEvent.setup();

    // The sibling tags are text, not controls — nothing here rebinds.
    expect(screen.queryByRole("button", { name: /4FKC2_IWT/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /assert anyway/i }));

    expect(onAssertAnyway).toHaveBeenCalledTimes(1);
  });

  it("disables both the assertion and its label while the answer is in flight", () => {
    render(
      <NotReportingChallenge detail={DETAIL} busy onAssertAnyway={vi.fn()} onCancel={vi.fn()} />,
    );

    expect(screen.getByRole("button", { name: /saving/i })).toBeDisabled();
  });

  it("renders without a points list at all, rather than throwing", () => {
    render(<NotReportingChallenge detail={{}} onAssertAnyway={vi.fn()} onCancel={vi.fn()} />);

    expect(screen.getByText(/0 of the selected point\(s\)/i)).toBeInTheDocument();
  });
});
