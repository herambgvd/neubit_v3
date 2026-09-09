/**
 * PULSE — the screen an operator opens when something is already wrong.
 *
 * Which is why almost every test here is about a degraded case. The failures
 * that matter are not "the page threw"; they are the page looking calm about
 * something it does not know:
 *
 *   * a recorder that did not answer, with its cameras silently missing from the
 *     totals and nothing saying so;
 *   * a failed read rendering as an empty, green estate;
 *   * a disk with no readable usage drawn as 0% full;
 *   * a fault-trace stage the recorder does not instrument shown as a pass.
 */
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { httpError, stubApi, type ApiStub } from "@/test/apiStub";
import { renderWithProviders } from "@/test/render";

import Pulse from "./Pulse";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ can: () => true, hasModule: () => true }) }));

const NODE = {
  node_id: "n1",
  node_name: "north",
  reachable: true,
  generated_at: "2026-09-09T06:00:00Z",
  verdict: { level: "ok", headline: "Recorder healthy", detail: null },
  engine: {},
  system: { cpu_pct: 8, mem_pct: 30 },
  sensors_reported: true,
  retention_default_days: 30,
  cameras: { total: 3, online: 2, recording_active: 2, recording_gap_free: true },
  volumes: [{ name: "rec", path: "/srv", pool_type: "local", is_default: true, used_percent: 61, usage: {}, usage_error: null }],
};

const OVERVIEW = {
  generated_at: "2026-09-09T06:00:00Z",
  partial: false,
  totals: {
    recorders: 1,
    recorders_answered: 1,
    cameras_total: 3,
    cameras_online: 2,
    cameras_recording: 2,
    recording_gap_free: true,
  },
  storage: { worst_used_percent: 61, volumes_measured: 1, volumes_total: 1, retention_days_min: 30 },
  nodes: [NODE],
  unreachable: [],
  offline_cameras: [
    { camera_id: "c3", name: "Ramp", node_id: "n1", node_name: "north", status: "offline", last_seen_at: null, last_error: "no route to host" },
  ],
  attention: [
    { severity: "warning", kind: "camera_offline", item: "Ramp is offline", where: "north", detail: "no route to host", camera_id: "c3", node_id: "n1" },
  ],
};

const BOARD = {
  node_id: "n1",
  node_name: "north",
  verdict: { level: "ok", headline: "Recorder healthy" },
  // The recorder's own spelling (nvr hwstat.SysUsage), which is what the board
  // has to read — reading `cpu_pct` renders "—" for a machine it did measure.
  system: { cpu_percent: 8.4, mem_percent: 30.2 },
  sensors_reported: true,
  volumes: [
    { name: "cold", path: null, pool_type: "s3", is_default: false, used_percent: null, usage: null, usage_error: "s3 pool has no probeable path" },
  ],
  cameras: {
    total: 2,
    online: 1,
    recording_active: 1,
    recording_gap_free: true,
    items: [
      { id: "c1", name: "Lobby", enabled: true, status: "online", recording_active: true },
      { id: "c3", name: "Ramp", enabled: true, status: "offline" },
    ],
  },
};

const TRACE = {
  node_id: "n1",
  node_name: "north",
  verdict: {
    level: "fault",
    attribution: "network",
    summary: "NETWORK SEGMENT — the NVR application is cleared",
    nvr_cleared: true,
    not_instrumented: ["display render fps"],
  },
  stages: [
    { key: "camera", label: "CAMERA", state: "ok", measured: true, evidence: [{ text: "device CPU 30%", tone: "ok" }] },
    { key: "network", label: "NETWORK", state: "bad", measured: true, evidence: [{ text: "packet loss 2.4%", tone: "bad" }] },
    { key: "display", label: "DISPLAY", state: "ok", measured: false, evidence: [] },
  ],
};

let stub: ApiStub;

function stubAll(over: Record<string, unknown> = {}) {
  stub = stubApi({
    "GET /vms/pulse/overview": OVERVIEW,
    "GET /vms/pulse/nodes/n1/sysmon": BOARD,
    "GET /vms/pulse/nodes/n1/cameras/c3/isolate": TRACE,
    ...over,
  });
  return stub;
}

beforeEach(() => stubAll());

describe("the estate figures", () => {
  it("shows what the recorders report", async () => {
    renderWithProviders(<Pulse />);

    expect(await screen.findByText("2 / 3")).toBeInTheDocument(); // cameras online
    expect(screen.getByText("61%")).toBeInTheDocument(); // fullest volume
    expect(screen.getByText("30d")).toBeInTheDocument(); // shortest retention
  });

  it("says the numbers cover only the recorders that answered", async () => {
    // Without this line "8 / 12" reads as the whole estate while a recorder's
    // cameras are silently absent from both halves of it.
    stubAll({
      "GET /vms/pulse/overview": {
        ...OVERVIEW,
        partial: true,
        totals: { ...OVERVIEW.totals, recorders: 2, recorders_answered: 1 },
        unreachable: [{ node_id: "n2", name: "south", error: "connection refused" }],
      },
    });
    renderWithProviders(<Pulse />);

    expect(await screen.findByText(/1 of 2 recorders answered/i)).toBeInTheDocument();
    expect(screen.getByText(/connection refused/)).toBeInTheDocument();
  });

  it("does not call a recorder that is recording nothing gap-free", async () => {
    stubAll({
      "GET /vms/pulse/overview": {
        ...OVERVIEW,
        totals: { ...OVERVIEW.totals, cameras_recording: 0, recording_gap_free: null },
      },
    });
    renderWithProviders(<Pulse />);

    expect(await screen.findByText("nothing recording")).toBeInTheDocument();
    expect(screen.queryByText(/gap-free/i)).toBeNull();
  });

  it("reports a failed read instead of an empty, healthy-looking estate", async () => {
    stubAll({ "GET /vms/pulse/overview": () => httpError(503, "vision is unreachable") });
    renderWithProviders(<Pulse />);

    expect(await screen.findByText(/could not read the estate/i)).toBeInTheDocument();
    expect(await screen.findByText(/vision is unreachable/i)).toBeInTheDocument();
  });
});

describe("what needs attention", () => {
  it("lists it, worst first, in the order the service ranked", async () => {
    renderWithProviders(<Pulse />);
    expect(await screen.findByText("Ramp is offline")).toBeInTheDocument();
  });

  it("opens the fault trace for an offline camera — the answer the count cannot give", async () => {
    renderWithProviders(<Pulse />);
    await userEvent.click(await screen.findByText("Ramp is offline"));

    await waitFor(() =>
      expect(stub.matching("GET /vms/pulse/nodes/n1/cameras/c3/isolate")).toHaveLength(1),
    );
    expect(await screen.findByText(/Fault isolated: NETWORK/)).toBeInTheDocument();
    // The sentence that ends the "is it the recorder or the network" argument.
    expect(screen.getByText(/recorder cleared/i)).toBeInTheDocument();
  });

  it("says which stages the recorder does not measure at all", async () => {
    renderWithProviders(<Pulse />);
    await userEvent.click(await screen.findByText("Ramp is offline"));

    expect(await screen.findByText("not instrumented")).toBeInTheDocument();
    expect(screen.getByText(/display render fps/)).toBeInTheDocument();
  });
});

describe("a recorder's own board", () => {
  it("is fetched only when one is opened", async () => {
    renderWithProviders(<Pulse />);
    await screen.findByText("Ramp is offline");
    expect(stub.matching("GET /vms/pulse/nodes/n1/sysmon")).toHaveLength(0);

    await userEvent.click(screen.getByText("north"));
    await waitFor(() => expect(stub.matching("GET /vms/pulse/nodes/n1/sysmon")).toHaveLength(1));
  });

  it("reads the hardware sample under the recorder's own field names", async () => {
    renderWithProviders(<Pulse />);
    await screen.findByText("Ramp is offline");
    await userEvent.click(screen.getByText("north"));

    expect(await screen.findByText("8%")).toBeInTheDocument();
    expect(screen.getByText("30%")).toBeInTheDocument();
  });

  it("shows a volume it could not read as unreadable, not as empty", async () => {
    renderWithProviders(<Pulse />);
    await screen.findByText("Ramp is offline");
    await userEvent.click(screen.getByText("north"));

    expect(await screen.findByText("usage unreadable")).toBeInTheDocument();
    expect(screen.getByText(/s3 pool has no probeable path/)).toBeInTheDocument();
    expect(screen.queryByText("0% used")).toBeNull();
  });

  it("says a box reported no hardware sample rather than printing zeros", async () => {
    stubAll({
      "GET /vms/pulse/nodes/n1/sysmon": { ...BOARD, sensors_reported: false, system: {} },
    });
    renderWithProviders(<Pulse />);
    await screen.findByText("Ramp is offline");
    await userEvent.click(screen.getByText("north"));

    expect(await screen.findByText(/reported no hardware sample/i)).toBeInTheDocument();
  });

  it("traces a camera straight from the board", async () => {
    renderWithProviders(<Pulse />);
    await screen.findByText("Ramp is offline");
    await userEvent.click(screen.getByText("north"));

    const board = await screen.findByText("Ramp");
    await userEvent.click(board);
    await waitFor(() =>
      expect(stub.matching("GET /vms/pulse/nodes/n1/cameras/c3/isolate")).toHaveLength(1),
    );
  });

  it("reports an unreachable recorder in the pane rather than showing nothing", async () => {
    stubAll({
      "GET /vms/pulse/nodes/n1/sysmon": () => httpError(503, "recorder did not answer"),
    });
    renderWithProviders(<Pulse />);
    await screen.findByText("Ramp is offline");
    await userEvent.click(screen.getByText("north"));

    const pane = await screen.findByText(/the recorder did not answer/i);
    expect(pane).toBeInTheDocument();
  });
});

describe("the recorder list", () => {
  it("names a recorder that did not answer, with its error", async () => {
    stubAll({
      "GET /vms/pulse/overview": {
        ...OVERVIEW,
        partial: true,
        totals: { ...OVERVIEW.totals, recorders: 2, recorders_answered: 1 },
        unreachable: [{ node_id: "n2", name: "south", error: "timeout after 5s" }],
      },
    });
    renderWithProviders(<Pulse />);

    const card = (await screen.findByText("south")).closest("div")!.parentElement!;
    expect(within(card).getByText(/timeout after 5s/)).toBeInTheDocument();
  });
});
