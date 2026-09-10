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
import { useEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
// The real tile mints a node session and streams fMP4. This stand-in reports
// what the caller actually reacts to: whether the window held any footage.
let footagePresent = true;
vi.mock("@/features/vms/components/TilePlayback", () => ({
  default: function TilePlaybackStub({
    camera,
    anchorMs,
    onFootage,
  }: {
    camera?: { name?: string };
    anchorMs: number | null;
    onFootage?: (present: boolean) => void;
  }) {
    useEffect(() => {
      onFootage?.(footagePresent);
    }, [onFootage]);
    return <div data-testid="recording" data-camera={camera?.name} data-anchor={String(anchorMs)} />;
  },
}));
vi.mock("@/features/vms/components/LivePlayer", () => ({
  default: ({ cameraName }: { cameraName?: string }) => <div>live:{cameraName}</div>,
}));

beforeEach(() => {
  footagePresent = true;
});

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
    // Both pictures are on screen at once: the recording large, live beside it.
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

    // Both cells say it — neither pretends to have a picture.
    expect(await screen.findAllByText(/no camera on this alarm/i)).not.toHaveLength(0);
  });

  it("distinguishes a camera it cannot reach from one with no footage", async () => {
    // A federated recorder that is down is not an empty recorder, and telling an
    // operator "nothing recorded" sends them looking for the wrong fault.
    stubAll({
      "GET /vms/federation/cameras": { items: [], total: 0 },
    });
    renderWithProviders(<IncidentList />);

    expect(await screen.findAllByText(/camera not reachable/i)).not.toHaveLength(0);
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

    await userEvent.click(await screen.findByRole("button", { name: /^3 Critical$/ }));
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

    // The filters are folded away until asked for — five selects took more of the
    // rail than the queue did.
    await userEvent.click(await screen.findByRole("button", { name: /filters/i }));
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: /filter by priority/i }),
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
    // Inside the ring: the duration ALONE. "1h 30m left" is wider than the hole
    // and was drawn straight through the stroke — the words belong under it.
    const big = within(ring).getAllByText(/^\d/)[0];
    expect(big.textContent).toBe("1h 30m");
    expect(within(ring).getByText(/of 2h/)).toBeInTheDocument();
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


describe("which picture gets the big cell", () => {
  /**
   * The first build gave the recording the big cell unconditionally. On an estate
   * where that camera was not being recorded, the largest thing on the console was
   * a black rectangle reading "No footage at this time" while the live view — which
   * had a picture — sat in the smallest tile on the page. Upside down.
   */
  it("keeps the recording large while there is footage", async () => {
    stubAll();
    renderWithProviders(<IncidentList />);

    // The recording is the big cell; live is the small card beside it.
    const big = await screen.findByTestId("recording");
    expect(big).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /show live large/i })).toBeInTheDocument();
  });

  it("hands the space to live when the window holds nothing", async () => {
    footagePresent = false;
    stubAll();
    renderWithProviders(<IncidentList />);

    // Live has been promoted, so the small card is now the recording.
    expect(await screen.findByRole("button", { name: /show the recording large/i })).toBeInTheDocument();
    expect(screen.getByText("live:Channel 1")).toBeInTheDocument();
  });

  it("stops second-guessing an operator who chose", async () => {
    // The window is empty, so live is promoted — and then the operator asks for
    // the recording anyway (to see the gap, or because they know it fills in).
    // The recording remounts and reports "empty" again; that must NOT yank the
    // cell back to live, or the toggle is unusable on exactly the alarms where
    // somebody would reach for it.
    footagePresent = false;
    stubAll();
    renderWithProviders(<IncidentList />);
    await screen.findByRole("button", { name: /show the recording large/i });

    await userEvent.click(screen.getByRole("button", { name: "Recording" }));

    expect(await screen.findByRole("button", { name: /show live large/i })).toBeInTheDocument();
  });
});


describe("the page is not mostly empty space", () => {
  /**
   * The first bento stretched every cell to fill the pane. A 16:9 stream in a
   * taller cell paints the difference black, so most of the console was a band
   * under the picture; three counters floated in a card six times their height;
   * and the right column still ran out before the rail did.
   *
   * The fix is that the pictures keep their own shape and the cards that can use
   * more room take what is left — so this pins the shape, and pins that the space
   * goes to something with content in it.
   */
  it("gives the video its own aspect instead of a fill", async () => {
    stubAll();
    const { container } = renderWithProviders(<IncidentList />);
    await screen.findByTestId("recording");

    const frames = [...container.querySelectorAll(".aspect-video")];
    // Both pictures — the big cell and the small one.
    expect(frames.length).toBeGreaterThanOrEqual(2);
    // And none of them is also told to fill its column, which is what produced
    // the band.
    expect(frames.some((f) => f.classList.contains("flex-1"))).toBe(false);
  });

  it("fills the leftover height with the facts, not with nothing", async () => {
    stubAll();
    renderWithProviders(<IncidentList />);

    // The right column's tail is a real card about this alarm — waited on by the
    // CONTENT, since the card's own heading renders before the queue lands.
    expect(await screen.findByText("Origin")).toBeInTheDocument();
    expect(screen.getByText("Details")).toBeInTheDocument();
    expect(screen.getAllByText(/rule matched a camera event/i)).not.toHaveLength(0);
  });

  it("shows what has been done to the alarm, and the note somebody wrote", async () => {
    // The timeline exists on every incident and was visible nowhere. It is the
    // answer a second operator arrives needing — has anyone looked at this — and
    // it is the only reason making somebody write a note was worth anything.
    stubAll({
      "GET /workflow/instances": {
        items: [
          incident({
            status: "active",
            current_state_name: "Investigating",
            timeline: [
              {
                transition_id: "tr1",
                transition_name: "Start investigating",
                from_state_id: "st1",
                from_state_name: "Open",
                to_state_id: "st2",
                to_state_name: "Investigating",
                executed_by: "u-1",
                executed_by_name: "Heramb",
                notes: "two people at Gate 2",
                form_data: null,
                form_labels: null,
                executed_at: iso(12),
              },
            ],
          }),
        ],
        total: 1,
      },
    });
    renderWithProviders(<IncidentList />);

    expect(await screen.findByText("Start investigating")).toBeInTheDocument();
    expect(screen.getByText(/two people at Gate 2/)).toBeInTheDocument();
    expect(screen.getByText(/Heramb · now Investigating/)).toBeInTheDocument();
    // And the entry that is always true but never in the timeline.
    expect(screen.getByText("Raised")).toBeInTheDocument();
  });

  it("says an alarm was escalated by a person, when it was", async () => {
    // The envelope the escalate dialog sends carries raised_by: "operator" — an
    // operator reading the queue should not have to guess whether a rule or a
    // colleague put this in front of them.
    stubAll({
      "GET /workflow/instances": {
        items: [
          incident({
            trigger_data: {
              source: "vision",
              raised_by: "operator",
              payload: { camera_id: "fed-cam-1", event_id: "ev-1", occurred_at: iso(30) },
            },
          }),
        ],
        total: 1,
      },
    });
    renderWithProviders(<IncidentList />);

    // Said in both places it matters: the facts card, and the trail's first line.
    expect(await screen.findAllByText(/escalated by an operator/i)).not.toHaveLength(0);
  });
});
