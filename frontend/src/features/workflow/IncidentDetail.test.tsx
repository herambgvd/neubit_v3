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

  it("reads as a record: masthead facts, then the sections in order", async () => {
    renderWithProviders(<IncidentDetail />);

    // The four facts that identify a case, in the masthead.
    expect(await screen.findByText("Where")).toBeInTheDocument();
    expect(screen.getByText("Owner")).toBeInTheDocument();
    expect(screen.getByText("Deadline")).toBeInTheDocument();

    // Then the document's sections, in the order a reader needs them.
    const sections = screen
      .getAllByRole("heading", { level: 2 })
      .map((h) => h.textContent?.trim());
    expect(sections).toEqual(["Evidence", "Procedure", "Log", "Close out", "Raw event"]);
  });

  it("logs what was done, and the note somebody was made to write", async () => {
    renderWithProviders(<IncidentDetail />);

    expect(await screen.findByText("Take it")).toBeInTheDocument();
    expect(screen.getByText(/two people at Gate 2/)).toBeInTheDocument();
    // The first line of any log is the one entry that is never in the timeline.
    expect(screen.getByText(/^Raised/)).toBeInTheDocument();
  });

  it("keeps the raw event out of the way until it is asked for", async () => {
    // It is the thing you go looking for, not the thing you read first.
    const { default: userEvent } = await import("@testing-library/user-event");
    renderWithProviders(<IncidentDetail />);

    const reveal = await screen.findByRole("button", { name: /what the device sent/i });
    await userEvent.click(reveal);
    expect(screen.queryByRole("button", { name: /what the device sent/i })).toBeNull();
  });

  it("names the procedure and the version this alarm is running", async () => {
    // A SOP is edited over time; an alarm runs the version it started on, and a
    // reconstruction a week later has to know which.
    renderWithProviders(<IncidentDetail />);

    // In the masthead, beside the procedure's name.
    const version = await screen.findByText("v2");
    const cell = version.closest("dd") as HTMLElement;
    expect(cell).toHaveTextContent("Intrusion");
  });

  it("says an alarm could not be opened, rather than showing an empty case", async () => {
    stubAll({ "GET /workflow/instances/i1": () => httpError(404, "not found") });
    renderWithProviders(<IncidentDetail />);

    expect(await screen.findByText(/could not be opened/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /back to the queue/i })).toHaveAttribute("href", "/alarms");
  });

  it("puts a move that ENDS the case under Close out, not under Procedure", async () => {
    // The two sections split the same list by where the move lands, so neither
    // invents a button the other already owns.
    stubAll({
      "GET /workflow/sops/s1/states": {
        items: [
          { state_id: "st-open", name: "Open", order: 0 },
          { state_id: "st-ack", name: "Acknowledged", order: 1 },
          { state_id: "st-done", name: "Resolved", order: 2, is_terminal: true },
        ],
      },
      "GET /workflow/instances/i1/available-transitions": [
        TRANSITIONS[0],
        { transition_id: "t9", sop_id: "s1", label: "Resolve", from_state_id: "st-open", to_state_id: "st-done", requires_note: true },
      ],
    });
    renderWithProviders(<IncidentDetail />);

    // Waited on the BUTTON: the section's heading renders before the moves land.
    const resolve = await screen.findByRole("button", { name: /Resolve/ });
    const closeOut = screen.getByRole("heading", { name: "Close out" }).parentElement!;
    expect(closeOut).toContainElement(resolve);
    // And the forward move is NOT down there with it.
    expect(within(closeOut).queryByRole("button", { name: "Move to review" })).toBeNull();
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
