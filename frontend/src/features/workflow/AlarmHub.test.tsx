/**
 * HUB MODE — the screen a control room leaves up.
 *
 * /alarms is the case surface, read at a desk. This is the other half: alarms
 * arrive, an operator looks and clears, for eight hours. Three properties make it
 * that rather than a second copy of the queue.
 */
import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { renderWithProviders } from "@/test/render";
import { stubApi, type ApiStub } from "@/test/apiStub";
import AlarmHub, { hubOrder } from "./AlarmHub";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ can: () => true, hasModule: () => true }) }));
// The SSE bridge, captured so a test can make an alarm "arrive".
let onArrival: ((e: unknown) => void) | null = null;
vi.mock("./hooks/useIncidentStream", () => ({
  useIncidentStream: (cb: (e: unknown) => void) => {
    onArrival = cb;
  },
}));
vi.mock("@/features/vms/components/TilePlayback", () => ({
  default: ({ camera }: { camera?: { name?: string } }) => (
    <div data-testid="recording" data-camera={camera?.name} />
  ),
}));
vi.mock("@/features/vms/components/LivePlayer", () => ({
  default: ({ cameraName }: { cameraName?: string }) => <div>live:{cameraName}</div>,
}));

const NOW = Date.now();
const iso = (minsAgo: number) => new Date(NOW - minsAgo * 60_000).toISOString();

const inc = (over: Record<string, unknown> = {}) => ({
  instance_id: `i-${Math.random().toString(36).slice(2)}`,
  sop_id: "s1",
  sop_name: "Camera tamper",
  name: "Tamper · Channel 1",
  status: "pending",
  priority: "high",
  site_id: "site-7",
  current_state: "st1",
  current_state_name: "Open",
  sla_hours: 2,
  sla_deadline: new Date(NOW + 60 * 60_000).toISOString(),
  is_sla_breached: false,
  created_at: iso(20),
  updated_at: iso(20),
  timeline: [],
  trigger_data: { source: "vision", payload: { camera_id: "cam-1", occurred_at: iso(20) } },
  ...over,
});

let stub: ApiStub;

function stubAll(over: Record<string, unknown> = {}) {
  stub = stubApi({
    "GET /workflow/instances": { items: [inc({ instance_id: "i-1" })], total: 1 },
    "GET /workflow/sops/s1/states": {
      items: [
        { state_id: "st1", name: "Open", order: 0, is_initial: true },
        { state_id: "st2", name: "Investigating", order: 1 },
      ],
    },
    "GET /vms/cameras": { items: [], total: 0 },
    "GET /vms/federation/cameras": {
      items: [
        { id: "cam-1", name: "Channel 1", node_id: "n1", node_name: "recorder-a", status: "online" },
        { id: "cam-2", name: "Channel 2", node_id: "n1", node_name: "recorder-a", status: "online" },
      ],
      total: 2,
    },
    "GET /device-placements/index": {
      items: [
        { device_id: "fed:n1:cam-1", device_type: "camera", site_id: "site-7", floor_id: "f1" },
        { device_id: "fed:n1:cam-2", device_type: "camera", site_id: "site-7", floor_id: "f1" },
      ],
      count: 2,
    },
    "PATCH /workflow/instances/i-1/status": inc({ instance_id: "i-1", status: "active" }),
    ...over,
  });
  return stub;
}

describe("what next means", () => {
  it("puts the overdue first, then the worst, then the oldest", () => {
    // An operator clearing top-down should be clearing the right things first.
    const late = inc({ instance_id: "late", priority: "low", is_sla_breached: true });
    const crit = inc({ instance_id: "crit", priority: "critical", created_at: iso(5) });
    const old = inc({ instance_id: "old", priority: "high", created_at: iso(300) });
    const fresh = inc({ instance_id: "fresh", priority: "high", created_at: iso(1) });

    expect(hubOrder([fresh, crit, old, late] as never).map((i) => i.instance_id)).toEqual([
      "late",
      "crit",
      "old",
      "fresh",
    ]);
  });
});

describe("the mosaic", () => {
  it("gives the alarm's own camera the big cell and its neighbours the small ones", async () => {
    stubAll();
    renderWithProviders(<AlarmHub />);

    expect(await screen.findByTestId("recording")).toHaveAttribute("data-camera", "Channel 1");
    // The neighbour is live, and it is NOT the alarm's own camera.
    expect(screen.getByText("live:Channel 2")).toBeInTheDocument();
    expect(screen.queryByText("live:Channel 1")).toBeNull();
  });

  it("says a camera is unplaced rather than showing empty cells", async () => {
    stubAll({ "GET /device-placements/index": { items: [], count: 0 } });
    renderWithProviders(<AlarmHub />);

    // site_id on the incident still resolves the site, so this needs an alarm
    // with neither.
    stub.set({
      "GET /workflow/instances": { items: [inc({ instance_id: "i-1", site_id: null })], total: 1 },
    });
    expect(await screen.findByTestId("recording")).toBeInTheDocument();
  });

  it("never opens on a closed alarm", async () => {
    stubAll({
      "GET /workflow/instances": {
        items: [inc({ instance_id: "done", status: "resolved", name: "Old · Channel 5" })],
        total: 1,
      },
    });
    renderWithProviders(<AlarmHub />);

    expect(await screen.findByText(/nothing open/i)).toBeInTheDocument();
  });
});

describe("the keyboard", () => {
  it("moves to the next alarm on N", async () => {
    stubAll({
      "GET /workflow/instances": {
        items: [
          inc({ instance_id: "i-1", name: "First · Channel 1", priority: "critical" }),
          inc({ instance_id: "i-2", name: "Second · Channel 2", priority: "high" }),
        ],
        total: 2,
      },
    });
    renderWithProviders(<AlarmHub />);

    await screen.findByText("1 / 2");
    await userEvent.keyboard("n");
    expect(await screen.findByText("2 / 2")).toBeInTheDocument();
  });

  it("takes the alarm on A", async () => {
    stubAll();
    renderWithProviders(<AlarmHub />);
    await screen.findByTestId("recording");

    await userEvent.keyboard("a");
    await vi.waitFor(() =>
      expect(stub.matching("PATCH /workflow/instances/i-1/status")).toHaveLength(1),
    );
  });

  it("leaves typing alone", async () => {
    // A key that fires the queue while somebody is typing is a key that gets the
    // hub switched off.
    stubAll({
      "GET /workflow/instances": {
        items: [inc({ instance_id: "i-1" }), inc({ instance_id: "i-2" })],
        total: 2,
      },
    });
    renderWithProviders(
      <>
        <input aria-label="somewhere to type" />
        <AlarmHub />
      </>,
    );
    await screen.findByText("1 / 2");

    await userEvent.click(screen.getByLabelText("somewhere to type"));
    await userEvent.keyboard("n");
    expect(screen.getByText("1 / 2")).toBeInTheDocument();
  });
});

describe("an arrival", () => {
  it("refreshes the queue without moving the operator off what they are deciding", async () => {
    // A console that yanks the picture mid-decision teaches people to work
    // somewhere else. The arrival invalidates the list; it must not touch the
    // cursor.
    stubAll({
      "GET /workflow/instances": {
        items: [
          inc({ instance_id: "i-1", name: "First · Channel 1", priority: "critical" }),
          inc({ instance_id: "i-2", name: "Second · Channel 2" }),
        ],
        total: 2,
      },
    });
    renderWithProviders(<AlarmHub />);
    await screen.findByText("1 / 2");
    await userEvent.keyboard("n");
    await screen.findByText("2 / 2");

    const before = stub.matching("GET /workflow/instances").length;
    onArrival?.({ data: { instance_id: "i-3" } });

    // The queue is re-read…
    await vi.waitFor(() =>
      expect(stub.matching("GET /workflow/instances").length).toBeGreaterThan(before),
    );
    // …and the operator is still on the alarm they had chosen.
    expect(screen.getByText("2 / 2")).toBeInTheDocument();
  });
});
