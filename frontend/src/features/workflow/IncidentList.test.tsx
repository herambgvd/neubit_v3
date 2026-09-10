/**
 * ALARMS — the work half of the console, redesigned to the shape the events feed
 * settled on.
 *
 * Three properties are held here, each of which was a real defect on the page it
 * replaces:
 *
 *   1. IT WAS INVALID HTML. The whole alarm card was a <Link>, and the camera
 *      strip inside it held another one. An <a> inside an <a> threw a hydration
 *      error on every render of /alarms. The row is a selector now, not a link.
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
  it("is a table whose rows do not navigate", async () => {
    // The card WAS a link, and it wrapped another one. A row that navigates also
    // throws away the video the operator was just told to look at.
    stubAll();
    renderWithProviders(<IncidentList />);

    const table = await screen.findByRole("table");
    const row = within(table).getAllByRole("row")[1];
    expect(within(row).queryByRole("link")).toBeNull();
  });

  it("puts the alarm's own facts and its recording on screen at once", async () => {
    stubAll();
    renderWithProviders(<IncidentList />);

    // The first row is selected without being asked, so the panes are never blank
    // while the queue holds something.
    // The procedure's name appears on the row AND in the facts column — one
    // screen, two readings of the same alarm, which is the point of the layout.
    expect(await screen.findAllByText("Camera tamper")).toHaveLength(2);
    expect(await screen.findByTestId("recording")).toHaveAttribute("data-camera", "Channel 1");
    expect(screen.getByText("live:Channel 1")).toBeInTheDocument();
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

    expect(await screen.findByText("No alarms")).toBeInTheDocument();
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
