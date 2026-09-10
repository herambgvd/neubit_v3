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
import { screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { httpError, stubApi, type ApiStub } from "@/test/apiStub";
import { renderWithProviders } from "@/test/render";

import IncidentDetail from "./IncidentDetail";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ can: () => true, hasModule: () => true }) }));
vi.mock("@/features/vms/components/TilePlayback", () => ({
  default: function TilePlaybackStub({ camera }: { camera?: { name?: string } }) {
    return <div data-testid="recording" data-camera={camera?.name} />;
  },
}));
vi.mock("@/features/vms/components/LivePlayer", () => ({
  default: ({ cameraName }: { cameraName?: string }) => <div>live:{cameraName}</div>,
}));
vi.mock("next/navigation", () => ({
  // The page reads its id from the route segment.
  useParams: () => ({ id: "i1" }),
  useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(""),
}));

const AT = "2026-09-10T06:42:19Z";

const INSTANCE = {
  instance_id: "i1",
  sop_id: "s1",
  sop_name: "Intrusion",
  sop_version: 2,
  name: "Intrusion · Channel 1",
  current_state: "st-open",
  current_state_name: "Open",
  status: "active",
  priority: "high",
  created_at: AT,
  updated_at: AT,
  sla_hours: 1,
  sla_deadline: new Date(Date.now() + 30 * 60_000).toISOString(),
  is_sla_breached: false,
  assigned_to: null,
  assignment: null,
  event_type: "zone_intrusion",
  event_source: "vision",
  source_event_id: "ev-1",
  trigger_data: {
    source: "vision",
    payload: { camera_id: "fed-cam-1", event_id: "ev-1", occurred_at: AT },
  },
  timeline: [
    {
      transition_id: "t0",
      transition_name: "Take it",
      from_state_id: "st-new",
      from_state_name: "New",
      to_state_id: "st-open",
      to_state_name: "Open",
      executed_by: "u-1",
      executed_by_name: "Heramb",
      notes: "two people at Gate 2",
      form_data: null,
      form_labels: null,
      executed_at: AT,
    },
  ],
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
    "GET /vms/cameras": { items: [], total: 0 },
    "GET /vms/federation/cameras": {
      items: [
        { id: "fed-cam-1", name: "Channel 1", node_id: "n1", node_name: "recorder-a", status: "online" },
      ],
      total: 1,
    },
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


describe("the case file", () => {
  /**
   * The queue screen answers "what now". This page answers the questions that
   * outlive the shift — what happened, what was done, on what evidence — and it
   * is where the PDF an investigation asks for comes from.
   */
  it("opens on the evidence, at the event's own instant", async () => {
    renderWithProviders(<IncidentDetail />);

    expect(await screen.findByTestId("recording")).toHaveAttribute("data-camera", "Channel 1");
    // And it names the camera and the moment under the picture, rather than
    // leaving an operator to guess which camera they are looking at.
    expect(screen.getAllByText(/Channel 1/).length).toBeGreaterThan(0);
  });

  it("carries the whole record: the clock, the facts and the trail", async () => {
    renderWithProviders(<IncidentDetail />);

    // The clock as a shape, the same as the queue screen.
    expect(await screen.findByRole("img", { name: /30m/i })).toBeInTheDocument();
    // The trail, with the note somebody was made to write.
    expect(screen.getByText("Take it")).toBeInTheDocument();
    expect(screen.getByText(/two people at Gate 2/)).toBeInTheDocument();
    // And the facts.
    expect(screen.getByText("Details")).toBeInTheDocument();
    expect(screen.getByText("Origin")).toBeInTheDocument();
  });

  it("names the procedure and the version this alarm is running", async () => {
    // A SOP is edited over time; an alarm runs the version it started on, and a
    // reconstruction a week later has to know which.
    renderWithProviders(<IncidentDetail />);

    // Named in the Procedure header, beside the version it is running.
    const version = await screen.findByText("v2");
    const header = version.parentElement as HTMLElement;
    expect(header).toHaveTextContent("Procedure");
    expect(header).toHaveTextContent("Intrusion");
  });

  it("says an alarm could not be opened, rather than showing an empty case", async () => {
    stubAll({ "GET /workflow/instances/i1": () => httpError(404, "not found") });
    renderWithProviders(<IncidentDetail />);

    expect(await screen.findByText(/could not be opened/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /back to the queue/i })).toHaveAttribute("href", "/alarms");
  });

  it("collects the note a transition demands before making the move", async () => {
    stubAll({
      "GET /workflow/instances/i1/available-transitions": [
        { ...TRANSITIONS[0], label: "Resolve", requires_note: true },
      ],
    });
    const { default: userEvent } = await import("@testing-library/user-event");
    renderWithProviders(<IncidentDetail />);

    await userEvent.click(await screen.findByRole("button", { name: "Resolve" }));
    expect(stub.matching("PATCH /workflow/instances/i1/transition")).toHaveLength(0);

    await userEvent.type(screen.getByRole("textbox"), "lens wiped clean");
    // The modal's own confirm, not the button that opened it.
    const dialog = screen.getByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: /^Resolve$/ }));

    await waitFor(() =>
      expect(stub.matching("PATCH /workflow/instances/i1/transition")).toHaveLength(1),
    );
    expect(stub.body("PATCH /workflow/instances/i1/transition")?.notes).toBe("lens wiped clean");
  });
});
