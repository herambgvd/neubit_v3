/**
 * SURVEILLANCE → EVENTS. The estate's device feed, and what makes it worth
 * watching rather than reading.
 *
 * Three properties are guarded, each of which was a real defect on the page it
 * replaced:
 *
 *   * the counts FILTER. They were four read-only tiles — a number an operator
 *     can see but not act on, on a screen whose whole job is triage;
 *   * the feed is grouped by DAY with a header, so a long scroll never leaves
 *     times with no date attached to them;
 *   * an empty feed says WHY it is empty. "No events" under an active filter and
 *     "no events" on a quiet estate are opposite instructions.
 */
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { httpError, stubApi, type ApiStub } from "@/test/apiStub";
import { renderWithProviders } from "@/test/render";

import CameraEventsPage from "./CameraEvents";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ can: () => true, hasModule: () => true }) }));
// The SSE bridge is a live connection; this suite is about the rendered feed.
vi.mock("./hooks/useVmsEventStream", () => ({
  useVmsEventStream: () => ({ events: [], connected: true }),
}));
// The live canvas mints a node session and attaches WHEP/HLS; this suite is about
// WHICH camera it is pointed at.
vi.mock("./components/LivePlayer", () => ({
  default: ({ cameraName }: { cameraName?: string }) => <div>live:{cameraName}</div>,
}));
// The recorded cell mints a node playback session and streams fMP4; this suite is
// about WHICH moment it is anchored at.
vi.mock("./components/TilePlayback", () => ({
  default: ({ camera, anchorMs }: { camera?: { name?: string }; anchorMs: number | null }) => (
    <div>recording:{camera?.name}:{anchorMs}</div>
  ),
}));

const now = new Date();
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString();

const event = (over: Record<string, unknown> = {}) => ({
  id: `e-${Math.random().toString(36).slice(2)}`,
  camera_id: "fed-cam-1",
  event_type: "motion",
  severity: "warning",
  source: "onvif_pullpoint",
  title: "Channel 1",
  raw: {},
  occurred_at: hoursAgo(1),
  published: true,
  acknowledged: false,
  created_at: hoursAgo(1),
  ...over,
});

let stub: ApiStub;

function stubAll(over: Record<string, unknown> = {}) {
  stub = stubApi({
    "GET /vms/cameras": { items: [], total: 0 },
    "GET /vms/federation/cameras": {
      items: [
        { id: "fed-cam-1", name: "Channel 1", node_id: "n1", node_name: "recorder-a", status: "online" },
      ],
      total: 1,
    },
    "GET /workflow/instances": { items: [], total: 0 },
    "GET /vms/events": {
      items: [
        event({ severity: "critical", event_type: "tamper" }),
        event({ severity: "warning" }),
        event({ severity: "info", occurred_at: hoursAgo(30), created_at: hoursAgo(30) }),
      ],
      total: 3,
    },
    ...over,
  });
  return stub;
}

beforeEach(() => stubAll());

describe("the live strip", () => {
  it("says whether events are arriving right now", async () => {
    renderWithProviders(<CameraEventsPage />);
    expect(await screen.findByText("Live")).toBeInTheDocument();
  });

  it("counts what an operator triages by", async () => {
    renderWithProviders(<CameraEventsPage />);

    // The chip's accessible name is its own content: the count and the label.
    const critical = await screen.findByRole("button", { name: /^1 Critical$/ });
    expect(critical).toBeInTheDocument();
  });

  it("filters by a count — the tiles used to be read-only", async () => {
    renderWithProviders(<CameraEventsPage />);
    await screen.findByText("Live");

    await userEvent.click(screen.getByRole("button", { name: /Critical$/ }));

    // The severity reaches the API, not just a client-side slice.
    const asked = stub.matching("GET /vms/events").some((c) => c.search.get("severity") === "critical");
    expect(asked).toBe(true);
  });

  it("pauses the live append without unmounting the feed", async () => {
    renderWithProviders(<CameraEventsPage />);
    await screen.findByText("Live");

    await userEvent.click(screen.getByRole("button", { name: /pause/i }));
    expect(await screen.findByText("Paused")).toBeInTheDocument();
  });
});

describe("the control bar", () => {
  it("is ONE row: live state, counts and filters together", async () => {
    // It was two stacked cards — a strip of counts above a card of labelled
    // dropdowns — which cost a fifth of the viewport before a single event was
    // visible, on a screen whose whole job is the feed below it.
    renderWithProviders(<CameraEventsPage />);
    const critical = await screen.findByRole("button", { name: /Critical$/ });
    const camera = screen.getByRole("button", { name: /filter by camera/i });

    // Same bar: the chip's parent contains the camera picker's wrapper too.
    const bar = critical.parentElement!;
    expect(bar.contains(camera)).toBe(true);
    expect(bar.querySelector('input[type="date"]')).toBeTruthy();
  });

  it("has ONE control per thing it filters", async () => {
    // The severity dropdown sat beside the severity counts. Two controls for one
    // thing means the one an operator did not touch silently contradicts the one
    // they did.
    renderWithProviders(<CameraEventsPage />);
    await screen.findByText("Live");

    expect(screen.queryByRole("button", { name: /all severities/i })).toBeNull();
    expect(screen.getByRole("button", { name: /Critical$/ })).toBeInTheDocument();
  });

  it("names every unlabelled filter for a screen reader", async () => {
    // The visible labels went with the second row; the placeholder says what each
    // one narrows, and this is what carries that to somebody who cannot see it.
    renderWithProviders(<CameraEventsPage />);
    await screen.findByText("Live");

    expect(screen.getByRole("button", { name: /filter by camera/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /filter by event type/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/filter by day/i)).toBeInTheDocument();
  });
});

describe("the feed", () => {
  it("groups by day, so a time always has a date over it", async () => {
    renderWithProviders(<CameraEventsPage />);

    expect(await screen.findByText("Today")).toBeInTheDocument();
    expect(screen.getByText("Yesterday")).toBeInTheDocument();
  });

  it("names the camera from the estate, not its uuid", async () => {
    renderWithProviders(<CameraEventsPage />);
    expect(await screen.findAllByText("Channel 1")).not.toHaveLength(0);
  });
});

describe("an empty feed", () => {
  it("says the filters are hiding things, and offers to clear them", async () => {
    stubAll({ "GET /vms/events": { items: [], total: 0 } });
    renderWithProviders(<CameraEventsPage />);
    await screen.findByText("Live");

    await userEvent.click(screen.getByRole("button", { name: /Critical$/ }));

    expect(await screen.findByText(/no events match these filters/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /clear filters/i })).toBeInTheDocument();
  });

  it("says the estate is quiet when nothing is filtered", async () => {
    stubAll({ "GET /vms/events": { items: [], total: 0 } });
    renderWithProviders(<CameraEventsPage />);

    expect(await screen.findByText(/no events yet/i)).toBeInTheDocument();
  });

  it("reports a failed read instead of a quiet estate", async () => {
    // One is a reason to relax; the other is a reason to look at the recorder.
    stubAll({ "GET /vms/events": () => httpError(503, "vision is unreachable") });
    renderWithProviders(<CameraEventsPage />);

    expect(await screen.findByText(/could not load events/i)).toBeInTheDocument();
    expect(screen.queryByText(/no events yet/i)).toBeNull();
  });
});


describe("the monitor pane", () => {
  it("plays the RECORDING here, anchored before the event — no trip to Playback", async () => {
    // The pane exists to answer "what happened". It used to answer it with a link
    // to another page: a different query to compose and a lost place in the feed,
    // for the one question this surface is for.
    const at = hoursAgo(1);
    stubAll({
      "GET /vms/events": { items: [event({ severity: "alarm", occurred_at: at })], total: 1 },
    });
    renderWithProviders(<CameraEventsPage />);

    const cell = await screen.findByText(/^recording:Channel 1:/);
    const anchor = Number(cell.textContent!.split(":").pop());
    // A few seconds of pre-roll, so the operator sees it begin.
    expect(anchor).toBeLessThan(Date.parse(at));
    expect(Date.parse(at) - anchor).toBeLessThanOrEqual(15_000);
  });

  it("switches to live for the other question — is it still going on", async () => {
    stubAll();
    renderWithProviders(<CameraEventsPage />);
    await screen.findByText(/^recording:/);

    await userEvent.click(screen.getByRole("button", { name: /^live$/i }));
    expect(await screen.findByText("live:Channel 1")).toBeInTheDocument();
  });

  it("does not call a camera offline just because its status has not arrived", async () => {
    // A list still loading is not a camera that is down — saying "not streaming"
    // then is the same lie as an empty timeline for an unreachable recorder.
    stubAll({
      "GET /vms/federation/cameras": {
        items: [{ id: "fed-cam-1", name: "Channel 1", node_id: "n1", node_name: "recorder-a" }],
        total: 1,
      },
    });
    renderWithProviders(<CameraEventsPage />);
    await screen.findByText(/^recording:/);

    await userEvent.click(screen.getByRole("button", { name: /^live$/i }));
    expect(await screen.findByText("live:Channel 1")).toBeInTheDocument();
    expect(screen.queryByText(/not streaming/i)).toBeNull();
  });

  /**
   * The half that makes this an alarm-MONITORING surface rather than a list: the
   * operator is here to look, so an alarm shows its camera. Enterprise VMS
   * convention, and the reason the off-page notification is only a toast — video
   * belongs on the surface you opened to watch video, never over another task.
   */
  it("opens on the newest alarm and plays its camera", async () => {
    stubAll({
      "GET /vms/events": {
        items: [event({ severity: "alarm", camera_id: "fed-cam-1", title: "Channel 1" })],
        total: 1,
      },
    });
    renderWithProviders(<CameraEventsPage />);

    expect(await screen.findByText(/^recording:Channel 1:/)).toBeInTheDocument();
  });

  it("follows a NEW alarm onto the canvas, and stops following once the operator picks one", async () => {
    stubAll({
      "GET /vms/events": {
        items: [
          event({ severity: "alarm", title: "Channel 1", event_type: "motion" }),
          event({ severity: "alarm", title: "Channel 1", event_type: "tamper" }),
        ],
        total: 2,
      },
    });
    renderWithProviders(<CameraEventsPage />);
    await screen.findByText(/^recording:/);

    const follow = screen.getByRole("checkbox", { name: /follow alarms/i });
    expect(follow).toBeChecked();

    // Clicking a row is an explicit choice; the canvas must stop being yanked.
    await userEvent.click(screen.getAllByRole("button", { name: /tamper/i })[0]);
    expect(follow).not.toBeChecked();
  });

  it("says why there is no picture when the camera is the thing that broke", async () => {
    // The one case where live cannot be shown is exactly when an operator is
    // looking — so it carries the recorder's own sentence, not a black rectangle.
    stubAll({
      "GET /vms/federation/cameras": {
        items: [
          { id: "fed-cam-1", name: "Channel 1", node_id: "n1", node_name: "recorder-a", status: "offline" },
        ],
        total: 1,
      },
      "GET /vms/events": {
        items: [
          event({
            severity: "critical",
            event_type: "connection_lost",
            raw: { payload: { reason: "tcp dial 192.168.1.100:81: connection refused" } },
          }),
        ],
        total: 1,
      },
    });
    renderWithProviders(<CameraEventsPage />);
    await screen.findByText(/^recording:/);
    await userEvent.click(screen.getByRole("button", { name: /^live$/i }));

    expect(await screen.findByText(/not streaming/i)).toBeInTheDocument();
    expect(screen.getByText(/connection refused/)).toBeInTheDocument();
    expect(screen.queryByText(/^live:/)).toBeNull();
  });

  it("offers the recording from the event's instant", async () => {
    stubAll();
    renderWithProviders(<CameraEventsPage />);
    await screen.findByText("Live");

    // The row still links out for the full investigation surface; the PANE plays
    // the clip itself.
    const links = await screen.findAllByRole("link", { name: /recording|investigate/i });
    expect(links[0].getAttribute("href")).toMatch(/\/playback\?camera=fed-cam-1&t=/);
  });
});
