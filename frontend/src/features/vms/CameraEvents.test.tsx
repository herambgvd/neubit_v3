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
import { screen, within } from "@testing-library/react";
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
      items: [{ id: "fed-cam-1", name: "Channel 1", node_id: "n1", node_name: "recorder-a" }],
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
