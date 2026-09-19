/**
 * BI → Setup → Units: one question at a time, readings on the screen, the
 * platform doing the checking — and nothing saved until a person presses.
 */
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { httpError, stubApi, type ApiStub } from "@/test/apiStub";
import { renderWithProviders } from "@/test/render";

import UnitsSetup from "./UnitsSetup";

const perms = { granted: new Set<string>() };
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ can: (p: string) => perms.granted.has(p), hasModule: () => true }),
}));

const P = (id: string, tag: string, value: number | null) => ({
  point_id: id, point_tag: tag, device_tag: "B1-Incomer", value, at: value == null ? null : "2026-09-20T09:00:00Z",
});

const volts = {
  key: "voltage_v", label: "Voltage", kind: "unit", unit: "V", eligible: 2,
  points: [P("v1", "VoltL1_V", 231.4), P("v2", "VoltL2_V", 229.8)],
};
const hertz = {
  key: "frequency_hz", label: "Frequency", kind: "unit", unit: "Hz", eligible: 1,
  points: [P("h1", "Freq_Hz", 50.01)],
};
const odd = {
  key: "current_a", label: "Current", kind: "unit", unit: "A", eligible: 2,
  points: [P("a1", "CurrL1_A", 12.4), P("a2", "CurrL2_A", 88_000)],
};
const contradiction = {
  key: "ambiguous_current_named_in_volts", label: "Current tag, volts suffix", kind: "ambiguous", unit: null,
  eligible: 1, points: [P("c1", "CurrL1_V", 12.4)],
};

let stub: ApiStub;
function catalogue(patterns: unknown[], unmatched: unknown[] = []) {
  stub = stubApi({
    "GET /bi/units/patterns": {
      patterns,
      totals: { points: 10, matched: 10, unmatched: unmatched.length, eligible: 5, already_confirmed: 63 },
      unmatched_sample: [],
      unmatched_points: unmatched,
    },
    "POST /bi/units/confirm": { confirmed: 1 },
  });
}

const render = () => {
  renderWithProviders(<UnitsSetup />);
  return userEvent.setup();
};

beforeEach(() => {
  perms.granted = new Set(["bi.read", "bi.manage"]);
});

describe("what the platform checked for you", () => {
  it("offers every kind whose readings all fit, in one press", async () => {
    catalogue([volts, hertz, odd]);
    const user = render();

    expect(await screen.findByText("3 numbers already read exactly like their unit")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Accept all 2" }));

    await waitFor(() => expect(stub.matching("POST /bi/units/confirm")).toHaveLength(2));
    const bodies = stub.matching("POST /bi/units/confirm").map((c) => c.body);
    expect(bodies).toContainEqual({ point_ids: ["v1", "v2"], unit: "V" });
    expect(bodies).toContainEqual({ point_ids: ["h1"], unit: "Hz" });
    // The kind with a reading out of range was NOT in the sweep.
    expect(JSON.stringify(bodies)).not.toContain("a1");
  });

  it("holds back a reading that does not fit, and saves only the ones that do", async () => {
    catalogue([odd]);
    const user = render();

    expect(await screen.findByText("Are these 2 numbers in amps?")).toBeInTheDocument();
    expect(screen.getByText(/1 does not — shown above/)).toBeInTheDocument();
    // The suspicious reading is what is shown.
    expect(screen.getByText("88,000")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Save the 1 that read like amps" }));
    await waitFor(() =>
      expect(stub.body("POST /bi/units/confirm")).toEqual({ point_ids: ["a1"], unit: "A" }),
    );
  });

  it("lets a person overrule the check, explicitly", async () => {
    catalogue([odd]);
    const user = render();

    await user.click(await screen.findByRole("button", { name: "All 2 are amps anyway" }));
    await waitFor(() =>
      expect(stub.body("POST /bi/units/confirm")).toEqual({ point_ids: ["a1", "a2"], unit: "A" }),
    );
  });
});

describe("a name that contradicts itself", () => {
  it("is asked with its reading and the two things it could be", async () => {
    catalogue([contradiction]);
    const user = render();

    expect(await screen.findByRole("heading", { name: "CurrL1_V" })).toBeInTheDocument();
    expect(screen.getByText("12.4")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /It is current — amps/ }));

    await waitFor(() =>
      expect(stub.body("POST /bi/units/confirm")).toEqual({ point_ids: ["c1"], unit: "A" }),
    );
  });
});

describe("taking it back", () => {
  it("offers undo on what was just saved, and undo clears exactly those points", async () => {
    catalogue([odd]);
    const user = render();

    await user.click(await screen.findByRole("button", { name: "Save the 1 that read like amps" }));
    await user.click(await screen.findByRole("button", { name: "Undo" }));

    await waitFor(() => expect(stub.matching("POST /bi/units/confirm")).toHaveLength(2));
    expect(stub.matching("POST /bi/units/confirm")[1].body).toEqual({ point_ids: ["a1"], unit: null });
  });
});

describe("a point that has stopped reporting", () => {
  it("is saved only when the person says so", async () => {
    catalogue([odd]);
    let calls = 0;
    stub.set({
      "POST /bi/units/confirm": () => {
        calls += 1;
        if (calls === 1) httpError(422, "not reporting", "POINT_NOT_REPORTING");
        return { confirmed: 1 };
      },
    });
    const user = render();

    await user.click(await screen.findByRole("button", { name: "Save the 1 that read like amps" }));
    expect(await screen.findByText("Some of these have stopped reporting.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save anyway" }));

    await waitFor(() => expect(calls).toBe(2));
    expect(stub.matching("POST /bi/units/confirm")[1].body).toEqual({
      point_ids: ["a1"], unit: "A", acknowledge_not_reporting: true,
    });
  });
});

describe("skipping", () => {
  it("does not lose what was skipped — it asks again", async () => {
    catalogue([odd]);
    const user = render();

    await user.click(await screen.findByRole("button", { name: /Skip this one/ }));
    expect(await screen.findByText("1 skipped")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Go through them again" }));
    expect(await screen.findByText("Are these 2 numbers in amps?")).toBeInTheDocument();
  });
});

describe("a viewer without bi.manage", () => {
  it("sees the questions and the readings, and can save nothing", async () => {
    perms.granted = new Set(["bi.read"]);
    catalogue([odd]);
    render();

    expect(await screen.findByText("Are these 2 numbers in amps?")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Save|anyway|Accept/ })).not.toBeInTheDocument();
    expect(screen.getByText(/Answering needs/)).toHaveTextContent("bi.manage");
  });
});

describe("a catalogue without readings", () => {
  it("never claims the work is done while the server still counts it open", async () => {
    // A reading-writer that predates this screen answers with no `points`.
    // The walk is then empty because it is blind — and it once said "Every
    // number has a unit" over 422 open points, to an operator who had pressed
    // nothing.
    stubApi({
      "GET /bi/units/patterns": {
        patterns: [{ key: "voltage_v", label: "Voltage", kind: "unit", unit: "V", eligible: 64 }],
        totals: { points: 493, matched: 485, unmatched: 8, eligible: 422, already_confirmed: 63 },
        unmatched_sample: [],
      },
    });
    render();

    expect(await screen.findByText("430 numbers still have no unit")).toBeInTheDocument();
    expect(screen.getByText(/Nothing has been saved/)).toBeInTheDocument();
    expect(screen.queryByText("Every number has a unit")).not.toBeInTheDocument();
  });
});
