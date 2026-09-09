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
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { httpError, stubApi, type ApiStub } from "@/test/apiStub";
import { renderWithProviders } from "@/test/render";

import CameraEventsPage from "./CameraEvents";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ can: () => true, hasModule: () => true }) }));
// The SSE bridge is a live connection; this suite is about the rendered feed.
let liveFrames: unknown[] = [];
vi.mock("./hooks/useVmsEventStream", () => ({
  useVmsEventStream: () => ({ events: liveFrames, connected: true }),
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

// Fixtures are pinned to LOCAL calendar days, not to "N hours ago": run this
// suite at 00:30 and an hour-ago event belongs to YESTERDAY, which made the
// day-grouping assertions pass or fail by the wall clock.
const atLocal = (dayOffset: number, hour: number) => {
  const d = new Date();
  d.setDate(d.getDate() - dayOffset);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
};
const TODAY = atLocal(0, 9);
const YESTERDAY = atLocal(1, 22);

const event = (over: Record<string, unknown> = {}) => ({
  id: `e-${Math.random().toString(36).slice(2)}`,
  camera_id: "fed-cam-1",
  event_type: "motion",
  severity: "warning",
  source: "onvif_pullpoint",
  title: "Channel 1",
  raw: {},
  occurred_at: TODAY,
  published: true,
  acknowledged: false,
  created_at: TODAY,
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
        event({ severity: "info", occurred_at: YESTERDAY, created_at: YESTERDAY }),
      ],
      total: 3,
    },
    ...over,
  });
  return stub;
}

beforeEach(() => {
  liveFrames = [];
  Object.defineProperty(globalThis, "scrollY", { value: 0, writable: true, configurable: true });
  stubAll();
});

describe("the live strip", () => {
  it("says whether events are arriving right now", async () => {
    renderWithProviders(<CameraEventsPage />);
    expect(await screen.findByText("Live feed")).toBeInTheDocument();
  });

  it("counts what an operator triages by", async () => {
    renderWithProviders(<CameraEventsPage />);

    // The chip's accessible name is its own content: the count and the label.
    const critical = await screen.findByRole("button", { name: /^1 Critical$/ });
    expect(critical).toBeInTheDocument();
  });

  it("filters by a count — the tiles used to be read-only", async () => {
    renderWithProviders(<CameraEventsPage />);
    await screen.findByText("Live feed");

    await userEvent.click(screen.getByRole("button", { name: /Critical$/ }));

    // The severity reaches the API, not just a client-side slice.
    const asked = stub.matching("GET /vms/events").some((c) => c.search.get("severity") === "critical");
    expect(asked).toBe(true);
  });

  it("pauses the live append without unmounting the feed", async () => {
    renderWithProviders(<CameraEventsPage />);
    await screen.findByText("Live feed");

    await userEvent.click(screen.getByRole("button", { name: /pause/i }));
    expect(await screen.findByText("Feed paused")).toBeInTheDocument();
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
    await screen.findByText("Live feed");

    expect(screen.queryByRole("button", { name: /all severities/i })).toBeNull();
    expect(screen.getByRole("button", { name: /Critical$/ })).toBeInTheDocument();
  });

  it("names every unlabelled filter for a screen reader", async () => {
    // The visible labels went with the second row; the placeholder says what each
    // one narrows, and this is what carries that to somebody who cannot see it.
    renderWithProviders(<CameraEventsPage />);
    await screen.findByText("Live feed");

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
    await screen.findByText("Live feed");

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
    const at = TODAY;
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
    // Two now: the recording pane switched to live, and the Live view panel that
    // is always beside it.
    expect(await screen.findAllByText("live:Channel 1")).toHaveLength(2);
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
    expect(await screen.findAllByText("live:Channel 1")).not.toHaveLength(0);
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
    await userEvent.click(screen.getAllByRole("row", { name: /tamper/i })[0]);
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

    expect(await screen.findAllByText(/not streaming/i)).not.toHaveLength(0);
    // The recorder's own sentence, on the pane and in the Details column.
    expect(screen.getAllByText(/connection refused/)).not.toHaveLength(0);
    expect(screen.queryByText(/^live:/)).toBeNull();
  });

  it("offers the recording from the event's instant", async () => {
    stubAll();
    renderWithProviders(<CameraEventsPage />);
    await screen.findByText("Live feed");

    // The row still links out for the full investigation surface; the PANE plays
    // the clip itself.
    const links = await screen.findAllByRole("link", { name: /recording|investigate/i });
    expect(links[0].getAttribute("href")).toMatch(/\/playback\?camera=fed-cam-1&t=/);
  });
});


describe("what is still happening", () => {
  /**
   * A stateful event with no `ended_at` has not finished — four are open on the
   * live estate, one for thirteen hours. It used to render as an ordinary row in
   * the day it began, identical to a motion blip. It is a STATUS now, in the
   * column an operator scans, counting up while they look at it.
   */
  const openEvent = (over: Record<string, unknown> = {}) =>
    event({
      severity: "critical",
      event_type: "connection_lost",
      occurred_at: YESTERDAY,
      created_at: YESTERDAY,
      raw: { stateful: true, started_at: YESTERDAY, ended_at: null, payload: { reason: "connection refused" } },
      ...over,
    });

  it("is marked Ongoing, with the time it has been running", async () => {
    stubAll({ "GET /vms/events": { items: [openEvent(), event()], total: 2 } });
    renderWithProviders(<CameraEventsPage />);

    expect(await screen.findAllByText("Ongoing")).not.toHaveLength(0);
    // A duration, not a timestamp: hours since it started.
    expect(screen.getAllByText(/\d+h \d+m/).length).toBeGreaterThan(0);
  });

  it("does not mark an instantaneous event as ongoing", async () => {
    // A motion pulse has no end because it was a pulse. Calling that "ongoing"
    // would leave every blip flagged forever.
    stubAll({ "GET /vms/events": { items: [event({ raw: { stateful: false } })], total: 1 } });
    renderWithProviders(<CameraEventsPage />);
    await screen.findByText("Live feed");

    expect(screen.queryByText("Ongoing")).toBeNull();
  });
});

describe("how long an event ran", () => {
  it("prints the span the recorder measured", async () => {
    const start = atLocal(0, 9);
    const end = new Date(Date.parse(start) + 5 * 3_600_000 + 18 * 60_000).toISOString();
    stubAll({
      "GET /vms/events": {
        items: [event({ event_type: "tamper", occurred_at: start, raw: { started_at: start, ended_at: end } })],
        total: 1,
      },
    });
    renderWithProviders(<CameraEventsPage />);

    // Both the row and the Details panel carry it.
    expect(await screen.findAllByText("5h 18m")).not.toHaveLength(0);
  });

  it("says a span is unreliable rather than drawing it backwards", async () => {
    // Observed on the live ledger: an end of 1970 against a start of today.
    const start = atLocal(0, 9);
    stubAll({
      "GET /vms/events": {
        items: [event({ occurred_at: start, raw: { started_at: start, ended_at: "1970-01-01T00:00:00Z" } })],
        total: 1,
      },
    });
    renderWithProviders(<CameraEventsPage />);

    expect(await screen.findAllByText(/duration unreliable/i)).not.toHaveLength(0);
  });
});


describe("a live arrival while the operator is reading", () => {
  /**
   * A feed that prepends while somebody is at row forty moves the row they were
   * reading. So arrivals are counted while they are away from the top, and the
   * count is a button that takes them back — nothing is hidden, the rows are
   * already in the list.
   */
  it("announces new events instead of yanking the scroll", async () => {
    stubAll();
    const { rerender } = renderWithProviders(<CameraEventsPage />);
    // Wait for the HISTORY, not just the strip: an arrival in the first non-empty
    // commit is the first load, not news, and asserting before it lands would
    // test that instead.
    await screen.findByText("Today");

    // Reading further down the feed…
    // act(): the scroll handler sets state, and React must flush it before the
    // arrival below is judged against it.
    act(() => {
      (globalThis as { scrollY: number }).scrollY = 900;
      globalThis.dispatchEvent(new Event("scroll"));
    });
    // …when something arrives.
    liveFrames = [event({ id: "new-1", event_id: "new-1", event_type: "tamper", occurred_at: TODAY })];
    rerender(<CameraEventsPage />);

    const pill = await screen.findByRole("button", { name: /1 new event/i });
    expect(pill).toBeInTheDocument();
  });

  it("says nothing when they are already looking at the top", async () => {
    stubAll();
    const { rerender } = renderWithProviders(<CameraEventsPage />);
    await screen.findByText("Today");

    liveFrames = [event({ id: "new-2", event_id: "new-2", event_type: "video_loss", occurred_at: TODAY })];
    rerender(<CameraEventsPage />);

    // The arrival really did reach the feed — otherwise this test would pass by
    // testing nothing, which is exactly how a "no pill" assertion goes stale.
    expect(await screen.findAllByText(/video loss/i)).not.toHaveLength(0);
    expect(screen.queryByRole("button", { name: /new event/i })).toBeNull();
  });
});


describe("acknowledging a burst", () => {
  /**
   * Twenty-nine of the fifty-nine events on this estate are motion from one
   * camera. Acknowledging them a row at a time is the work the console should be
   * doing, which is what the checkboxes are for.
   */
  it("acks every selected event in one action", async () => {
    stubAll({
      "GET /vms/events": {
        items: [
          event({ id: "a1", event_id: "a1" }),
          event({ id: "a2", event_id: "a2" }),
          event({ id: "a3", event_id: "a3", acknowledged: true }),
        ],
        total: 3,
      },
    });
    renderWithProviders(<CameraEventsPage />);
    // findBy: the strip renders before the history lands, so waiting on "Live
    // feed" would assert against an empty table.
    const selectAll = await screen.findByRole("checkbox", { name: /select all/i });
    await userEvent.click(selectAll);
    await userEvent.click(screen.getByRole("button", { name: /acknowledge selected/i }));

    // Only the two that were open: re-acking the third is a request for nothing.
    await waitFor(() => expect(stub.matching("POST /vms/events/*")).toHaveLength(2));
  });

  it("offers no bulk action until something is selected", async () => {
    stubAll();
    renderWithProviders(<CameraEventsPage />);
    await screen.findByText("Live feed");

    expect(screen.queryByRole("button", { name: /acknowledge selected/i })).toBeNull();
  });
});
