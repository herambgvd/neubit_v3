/**
 * ALARMS — the work half of the console, redesigned to the shape the events feed
 * settled on.
 *
 * Three properties are held here, each of which was a real defect on the page it
 * replaces:
 *
 *   1. IT WAS INVALID HTML. The whole alarm card was a <Link>, and the camera
 *      strip inside it held another one. An <a> inside an <a> threw a hydration
 *      error on every render of /alarms. A rail row is a selector now, not a
 *      link — and a click must not navigate, or it throws away the footage the
 *      operator was just told to look at.
 *   2. TWO OF THE FOUR COUNTS LIED ABOUT THEIR SCOPE — "Critical" and "Active"
 *      come from /stats (the whole deployment) while "Overdue" and "Unassigned"
 *      can only be counted from the rows loaded. Four tiles in a row, two meaning
 *      different things, and nothing saying which.
 *   3. AN EMPTY QUEUE READ AS ALL CLEAR. On an estate with no rules and no
 *      escalations, "No active alarms" beside a green shield says the estate is
 *      quiet when the truth is that nothing can raise one.
 */
import { describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { renderWithProviders } from "@/test/render";
import { stubApi, type ApiStub } from "@/test/apiStub";
import { HeaderSlotOutlet } from "@/components/shell/HeaderSlot";
import IncidentList from "./IncidentList";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ can: () => true, hasModule: () => true }) }));
vi.mock("./hooks/useIncidentStream", () => ({ useIncidentStream: () => undefined }));
// The recorded cell mints a node playback session and streams fMP4; this suite is
// about WHICH moment it is anchored at.
vi.mock("@/features/vms/components/TilePlayback", () => ({
  default: ({ camera, anchorMs }: { camera?: { name?: string }; anchorMs: number | null }) => (
    <div data-testid="recording" data-camera={camera?.name} data-anchor={String(anchorMs)} />
  ),
}));
vi.mock("@/features/vms/components/EventLivePane", () => ({
  default: ({ camera }: { camera?: { name?: string } | null }) => <div>live:{camera?.name || "none"}</div>,
}));

const NOW = new Date();
const iso = (minsAgo: number) => new Date(NOW.getTime() - minsAgo * 60_000).toISOString();

const incident = (over: Record<string, unknown> = {}) => ({
  instance_id: `i-${Math.random().toString(36).slice(2)}`,
  sop_id: "s1",
  sop_name: "Camera tamper",
  sop_version: 1,
  name: "Tamper · Channel 1",
  description: null,
  priority: "high",
  site_id: null,
  current_state: "st1",
  current_state_name: "Open",
  status: "pending",
  assigned_to: null,
  assignment: null,
  sla_hours: 2,
  sla_deadline: new Date(NOW.getTime() + 90 * 60_000).toISOString(),
  is_sla_breached: false,
  state_entered_at: iso(30),
  escalation: null,
  tags: [],
  timeline: [],
  metadata: null,
  trigger_data: {
    source: "vision",
    payload: { camera_id: "fed-cam-1", event_id: "ev-1", occurred_at: iso(30) },
  },
  event_id: "ev-1",
  event_type: "tamper",
  event_source: "vision",
  source_event_id: "ev-1",
  closed_at: null,
  outcome: null,
  created_at: iso(30),
  updated_at: iso(30),
  ...over,
});

let stub: ApiStub;

function stubAll(over: Record<string, unknown> = {}) {
  stub = stubApi({
    "GET /workflow/sops": { items: [], total: 0 },
    "GET /sites": { items: [], total: 0 },
    "GET /workflow/instances/stats": { by_status: { active: 7 }, by_priority: { critical: 3 } },
    "GET /vms/cameras": { items: [], total: 0 },
    "GET /vms/federation/cameras": {
      items: [
        { id: "fed-cam-1", name: "Channel 1", node_id: "n1", node_name: "recorder-a", status: "online" },
      ],
      total: 1,
    },
    "GET /workflow/instances": { items: [incident()], total: 1 },
    ...over,
  });
  return stub;
}

describe("the queue", () => {
  it("has rows that select rather than navigate", async () => {
    stubAll();
    renderWithProviders(<IncidentList />);

    const row = await screen.findByRole("button", { name: /Tamper · Channel 1/ });
    expect(within(row).queryByRole("link")).toBeNull();
  });

  it("puts the alarm's own facts and its recording on screen at once", async () => {
    stubAll();
    renderWithProviders(<IncidentList />);

    // The first alarm takes the big cell without being asked, so the bento is
    // never blank while the queue holds something.
    expect(await screen.findByTestId("recording")).toHaveAttribute("data-camera", "Channel 1");
    expect(screen.getByText("live:Channel 1")).toBeInTheDocument();
    // Its own title, in the cell rather than only in the rail.
    expect(screen.getByRole("heading", { name: "Tamper · Channel 1" })).toBeInTheDocument();
  });

  it("plays the recording from before the event, not from the alarm's own time", async () => {
    stubAll();
    renderWithProviders(<IncidentList />);

    const pane = await screen.findByTestId("recording");
    const anchor = Number(pane.getAttribute("data-anchor"));
    const eventMs = new Date(iso(30)).getTime();
    // Eight seconds of pre-roll: the thing is seen beginning.
    expect(eventMs - anchor).toBe(8000);
  });

  it("says an alarm has no camera rather than showing an empty player", async () => {
    stubAll({
      "GET /workflow/instances": {
        items: [incident({ trigger_data: { source: "manual", payload: {} }, event_source: "manual" })],
        total: 1,
      },
    });
    renderWithProviders(<IncidentList />);

    expect(await screen.findByText(/no camera on this alarm/i)).toBeInTheDocument();
  });

  it("distinguishes a camera it cannot reach from one with no footage", async () => {
    // A federated recorder that is down is not an empty recorder, and telling an
    // operator "nothing recorded" sends them looking for the wrong fault.
    stubAll({
      "GET /vms/federation/cameras": { items: [], total: 0 },
    });
    renderWithProviders(<IncidentList />);

    expect(await screen.findByText(/camera not reachable/i)).toBeInTheDocument();
  });
});

describe("the counts in the top bar", () => {
  it("rides in the header, and says which numbers are page-only", async () => {
    stubAll();
    renderWithProviders(
      <>
        <header data-testid="topbar">
          <HeaderSlotOutlet />
        </header>
        <IncidentList />
      </>,
    );

    const bar = screen.getByTestId("topbar");
    // Deployment-wide, from /stats — waited for, since the chip renders a 0 until
    // that query lands.
    const critical = await screen.findByRole("button", { name: "3 Critical" });
    expect(bar).toContainElement(critical);
    // Page-only, and it must SAY so — the old tiles looked identical.
    expect(screen.getByRole("button", { name: /Unassigned$/ })).toHaveAttribute(
      "title",
      expect.stringContaining("this page only"),
    );
  });

  it("filters by a count that maps onto a filter", async () => {
    stubAll();
    renderWithProviders(<IncidentList />);

    await userEvent.click(await screen.findByRole("button", { name: /Critical$/ }));
    await vi.waitFor(() =>
      expect(
        stub
          .matching("GET /workflow/instances")
          .some((c) => c.search.get("priority") === "critical"),
      ).toBe(true),
    );
  });
});

describe("an empty queue", () => {
  it("says where an alarm comes from, instead of reading as all clear", async () => {
    stubAll({ "GET /workflow/instances": { items: [], total: 0 } });
    renderWithProviders(<IncidentList />);

    expect(await screen.findByText(/no alarms\./i)).toBeInTheDocument();
    expect(screen.getByText(/rule matches an event, or when somebody escalates/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /go to events/i })).toHaveAttribute("href", "/events");
  });

  it("offers the filters back when they are what emptied it", async () => {
    stubAll({ "GET /workflow/instances": { items: [], total: 0 } });
    renderWithProviders(<IncidentList />);

    await userEvent.selectOptions(
      await screen.findByRole("combobox", { name: /filter by priority/i }),
      "critical",
    );

    expect(await screen.findByText(/no alarms match these filters/i)).toBeInTheDocument();
  });
});


describe("the bento", () => {
  /**
   * B was chosen over the table for a reason: an alarm is worked, not scanned.
   * The screen has to answer the three questions that follow the picture — how
   * long is left, what is the next step, and is it still happening.
   */
  it("shows the clock as a shape, not only as a number", async () => {
    stubAll();
    renderWithProviders(<IncidentList />);

    // 90 of 120 minutes left on a 2h procedure.
    const ring = await screen.findByRole("img", { name: /1h 30m/i });
    expect(ring).toBeInTheDocument();
  });

  it("draws a full ring when the deadline has passed, not an empty one", async () => {
    // Empty means "none left"; so does empty when there was never a clock. An
    // overdue alarm fills the ring in the breach colour so the two cannot be
    // confused at a glance.
    stubAll({
      "GET /workflow/instances": {
        items: [
          incident({
            instance_id: "i-late",
            sla_deadline: new Date(NOW.getTime() - 6 * 60_000).toISOString(),
            is_sla_breached: true,
          }),
        ],
        total: 1,
      },
    });
    const { container } = renderWithProviders(<IncidentList />);

    await screen.findByRole("img", { name: /overdue/i });
    const arc = container.querySelector("circle[stroke-dasharray]") as SVGCircleElement;
    const [drawn, whole] = (arc.getAttribute("stroke-dasharray") || "").split(" ").map(Number);
    expect(drawn).toBeCloseTo(whole, 1);
    expect(arc.getAttribute("stroke")).toBe("#f87171");
  });

  it("says there is no limit rather than drawing an empty ring", async () => {
    // An empty ring and "no clock at all" must not look the same — one means out
    // of time, the other means the procedure never set one.
    stubAll({
      "GET /workflow/instances": {
        items: [incident({ sla_hours: null, sla_deadline: null })],
        total: 1,
      },
    });
    renderWithProviders(<IncidentList />);

    expect(await screen.findByRole("img", { name: /no time limit/i })).toBeInTheDocument();
  });

  it("runs the procedure's own moves, not a fixed set of buttons", async () => {
    stubAll({
      "GET /workflow/sops/s1/states": [
        { state_id: "st1", sop_id: "s1", name: "Open", description: null, color: "#F59E0B", position_x: 0, position_y: 0, is_initial: true, is_terminal: false, is_cancellation: false, sla_hours: null, entry_actions: [], exit_actions: [], required_role_ids: [], order: 0, created_at: iso(0), updated_at: iso(0) },
        { state_id: "st2", sop_id: "s1", name: "Investigating", description: null, color: "#3B82F6", position_x: 0, position_y: 0, is_initial: false, is_terminal: false, is_cancellation: false, sla_hours: null, entry_actions: [], exit_actions: [], required_role_ids: [], order: 1, created_at: iso(0), updated_at: iso(0) },
        { state_id: "st3", sop_id: "s1", name: "Dismissed", description: null, color: "#6B7280", position_x: 0, position_y: 0, is_initial: false, is_terminal: false, is_cancellation: true, sla_hours: null, entry_actions: [], exit_actions: [], required_role_ids: [], order: 3, created_at: iso(0), updated_at: iso(0) },
      ],
      "GET /workflow/instances": { items: [incident({ instance_id: "i-1" })], total: 1 },
      "GET /workflow/instances/i-1/available-transitions": [
        { transition_id: "tr1", sop_id: "s1", from_state_id: "st1", to_state_id: "st2", label: "Start investigating", description: null, requires_note: false, confirmation_required: false, required_role_ids: [], form_id: null, conditions: [], notification_config: null, created_at: iso(0), updated_at: iso(0) },
      ],
      "PATCH /workflow/instances/i-1/transition": incident({ status: "active" }),
    });
    renderWithProviders(<IncidentList />);

    // The cancellation branch is NOT drawn as a step in the line — "Dismissed" is
    // a way off the path, not step three of three.
    expect(await screen.findByText("Investigating")).toBeInTheDocument();
    expect(screen.queryByText("Dismissed")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Start investigating" }));
    await vi.waitFor(() =>
      expect(stub.matching("PATCH /workflow/instances/i-1/transition")).toHaveLength(1),
    );
    expect(stub.body("PATCH /workflow/instances/i-1/transition")?.transition_id).toBe("tr1");
  });

  it("asks for the note a transition demands before it will run", async () => {
    stubAll({
      "GET /workflow/sops/s1/states": [],
      "GET /workflow/instances": { items: [incident({ instance_id: "i-1" })], total: 1 },
      "GET /workflow/instances/i-1/available-transitions": [
        { transition_id: "tr9", sop_id: "s1", from_state_id: "st1", to_state_id: "st3", label: "Resolve", description: null, requires_note: true, confirmation_required: false, required_role_ids: [], form_id: null, conditions: [], notification_config: null, created_at: iso(0), updated_at: iso(0) },
      ],
      "PATCH /workflow/instances/i-1/transition": incident({ status: "completed" }),
    });
    renderWithProviders(<IncidentList />);

    await userEvent.click(await screen.findByRole("button", { name: "Resolve" }));
    // Nothing has been sent yet: the procedure asked for an account of what
    // happened, and an incident closed without one teaches nobody anything.
    expect(stub.matching("PATCH /workflow/instances/i-1/transition")).toHaveLength(0);

    await userEvent.type(screen.getByRole("textbox", { name: /say what happened/i }), "lens wiped clean");
    await userEvent.click(screen.getByRole("button", { name: /^Resolve$/ }));

    await vi.waitFor(() =>
      expect(stub.matching("PATCH /workflow/instances/i-1/transition")).toHaveLength(1),
    );
    expect(stub.body("PATCH /workflow/instances/i-1/transition")?.notes).toBe("lens wiped clean");
  });
});
