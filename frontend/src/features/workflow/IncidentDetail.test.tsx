/**
 * An incident's detail — and specifically WHICH MOVES IT OFFERS.
 *
 * A transition carries conditions the server evaluates against the instance. The
 * pane used to filter the SOP's transitions by `from_state` alone, so a
 * conditional transition was offered, clicked, and refused with "Transition
 * conditions are not satisfied" — the operator's only signal that a move was
 * never available being an error after they tried it.
 *
 * The server has answered this properly all along on
 * `/instances/{id}/available-transitions`. It is asked now, and the old filter
 * survives only as the fallback for when that call fails: a pane with no moves
 * at all is worse than one offering a move the server will refuse.
 */
import { screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { httpError, stubApi, type ApiStub } from "@/test/apiStub";
import { renderWithProviders } from "@/test/render";

import IncidentDetail from "./IncidentDetail";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock("next/navigation", () => ({
  // The page reads its id from the route segment.
  useParams: () => ({ id: "i1" }),
  useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(""),
}));

const INSTANCE = {
  instance_id: "i1",
  sop_id: "s1",
  sop_name: "Intrusion",
  current_state: "st-open",
  current_state_name: "Open",
  status: "active",
  priority: "high",
  history: [],
};

const TRANSITIONS = [
  { transition_id: "t1", sop_id: "s1", label: "Move to review", from_state_id: "st-open", to_state_id: "st-ack" },
  { transition_id: "t2", sop_id: "s1", label: "Move to hold", from_state_id: "st-open", to_state_id: "st-esc" },
];

let stub: ApiStub;

function stubAll(over: Record<string, unknown> = {}) {
  stub = stubApi({
    "GET /workflow/instances/i1": INSTANCE,
    "GET /workflow/instances/i1/available-transitions": [TRANSITIONS[0]],
    "GET /workflow/sops/s1/states": {
      items: [
        { state_id: "st-open", name: "Open" },
        { state_id: "st-ack", name: "Acknowledged" },
        { state_id: "st-esc", name: "Escalated" },
      ],
    },
    "GET /workflow/sops/s1/transitions": { items: TRANSITIONS },
    "GET /workflow/forms": { items: [] },
    "GET /auth/users": { items: [] },
    ...over,
  });
  return stub;
}

beforeEach(() => stubAll());

describe("the moves it offers", () => {
  it("asks the server which transitions are actually available", async () => {
    renderWithProviders(<IncidentDetail />);

    await waitFor(() =>
      expect(stub.matching("GET /workflow/instances/i1/available-transitions")).not.toHaveLength(0),
    );
    expect(await screen.findByText("Move to review")).toBeInTheDocument();
    // "Move to hold" leaves the same state but its conditions do not hold, so the
    // server left it out. Offering it would end in a refusal after the click.
    expect(screen.queryByText("Move to hold")).toBeNull();
  });

  it("falls back to the structurally-legal moves when that call fails", async () => {
    // A pane with no moves at all is worse than one offering a move the server
    // will refuse — the operator can still act, and the server still guards.
    stubAll({
      "GET /workflow/instances/i1/available-transitions": () => httpError(503, "unavailable"),
    });
    renderWithProviders(<IncidentDetail />);

    expect(await screen.findByText("Move to review")).toBeInTheDocument();
    expect(screen.getByText("Move to hold")).toBeInTheDocument();
  });
});
