/**
 * THE ALARM POP-UP, on every page.
 *
 *   * ANYWHERE ELSE it is a corner card: what, where, and one click to go look.
 *     Never a camera thrown over a form somebody is filling in.
 *   * ON THE EVENTS PAGE it pops up too (SCRUM-327), at the top over the panes,
 *     with "Show in panes" — HikCentral's and DSS's alarm window opens wherever
 *     the operator is — unless the operator keeps that page to its own feed.
 *
 * And a rule that decides whether the mechanism is worth anything at all: it
 * fires for alarms, not for every frame the estate produces. A console that
 * toasts a heartbeat teaches an operator to ignore toasts, and then it has no way
 * left to tell them something is wrong.
 */
import { act, render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock is hoisted above the file's own consts, so the spy is created INSIDE
// the factory and read back through the mocked module.
vi.mock("sonner", () => {
  const fn = vi.fn();
  return {
    toast: Object.assign(fn, {
      success: vi.fn(),
      error: vi.fn(),
      custom: vi.fn(),
      dismiss: vi.fn(),
    }),
  };
});

const push = vi.fn();
let pathname = "/streaming";
vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
  useRouter: () => ({ push }),
}));

let frames: unknown[] = [];
vi.mock("./useVmsEventStream", () => ({
  useVmsEventStream: () => ({ events: frames, connected: true }),
}));

// The estate roster: the corner names the camera and the recorder that owns it,
// which is the difference between "Channel 1" and a node-side uuid.
vi.mock("./useEstateCameras", () => ({
  useEstateCameras: () => ({
    cameras: [{ id: "fed:n1:cam-1", real_id: "fed-cam-1", name: "Lobby entrance", node_name: "recorder-a" }],
  }),
}));

const ack = vi.fn((_id: string) => Promise.resolve({}));
vi.mock("../api", () => ({ vms: { events: { ack: (id: string) => ack(id) } } }));

// The operator's alert settings live in their preferences (SCRUM-326).
let prefs: Record<string, unknown> = {};
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { preferences: prefs }, reload: vi.fn() }) }));

// The tone is Web Audio; this suite is about WHEN it rings, and in which sound.
const tone = vi.fn((_t: string, _v: number, _id?: string) => true);
vi.mock("../alertSound", async (orig) => ({
  ...(await orig<typeof import("../alertSound")>()),
  playAlertTone: (t: string, v: number, id?: string) => tone(t, v, id),
}));

import AlarmCorner from "../components/AlarmCorner";
import { alarmQueue, clearAlarms } from "../alarmQueue";
import { toastInset } from "@/lib/toastInset";
import { RECORDER_STATE_QUERIES, useEventNotifier } from "./useEventNotifier";

/** The hook needs a QueryClient (it invalidates the feed after an ack). */
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    {children}
  </QueryClientProvider>
);
const run = () => renderHook(() => useEventNotifier(), { wrapper });

/** Render the corner as the shell mounts it, so the card can be asserted on as
 *  the thing an operator actually sees. */
function renderToast() {
  render(<AlarmCorner />, { wrapper });
}

/** The card, by its label — a region, not an alert, so its countdown is not read out. */
const card = () => screen.getByRole("region", { name: /alarm:/i });

/** Text the operator SEES: the screen-reader announcement repeats some of it. */
const seen = (re: RegExp) => screen.getAllByText(re).filter((el) => !el.closest(".sr-only"));

const frame = (over: Record<string, unknown> = {}) => ({
  id: `e-${Math.random().toString(36).slice(2)}`,
  event_id: over.event_id ?? `x-${Math.random().toString(36).slice(2)}`,
  camera_id: "fed-cam-1",
  camera_name: "Channel 1",
  event_type: "motion",
  severity: "alarm",
  occurred_at: new Date().toISOString(),
  ...over,
});

beforeEach(() => {
  ack.mockClear();
  push.mockClear();
  frames = [];
  pathname = "/streaming";
  prefs = {};
  tone.mockClear();
  // Module state outlives a test.
  clearAlarms();
});

describe("off the Events page", () => {
  it("says what, how bad, where and when — not just a type and a name", () => {
    // It used to be one line, "tamper · Channel 2", which is barely more than
    // "something happened". An operator triages on severity, camera, recorder and
    // age, and every one of those was a page away.
    frames = [frame({ event_type: "tamper", severity: "critical" })];
    run();
    renderToast();

    expect(screen.getByText("Tamper")).toBeInTheDocument();
    expect(screen.getByText("Critical")).toBeInTheDocument();
    // The ESTATE's name for the camera, and the recorder that owns it — the frame
    // itself only carried "Channel 1" and a node-side id.
    expect(seen(/Lobby entrance/)).toHaveLength(1);
    expect(screen.getByText(/recorder-a/)).toBeInTheDocument();
    expect(screen.getByText(/just now/)).toBeInTheDocument();
  });

  it("takes one click to the event that raised it", async () => {
    frames = [frame({ event_id: "ev-9" })];
    run();
    renderToast();

    await userEvent.click(screen.getByRole("button", { name: /open in events/i }));
    expect(push).toHaveBeenCalledWith("/events?event=ev-9");
  });

  it("acknowledges from the corner, without opening the page", async () => {
    // An alarm an operator RECOGNISES should not cost a navigation to close.
    frames = [frame({ id: "row-7" })];
    run();
    renderToast();

    await userEvent.click(screen.getByRole("button", { name: /acknowledge/i }));
    expect(ack).toHaveBeenCalledWith("row-7");
  });

  it("raises ONE card for a burst, not a toast per alarm (SCRUM-312)", () => {
    // A stack of toasts left gaps and could stop every timer in it. The card
    // pages the burst and keeps its own clock (see AlarmNotification.test).
    frames = [frame(), frame(), frame({ severity: "critical" })];
    run();
    renderToast();
    expect(screen.getAllByRole("region", { name: /alarm:/i })).toHaveLength(1);
    expect(screen.getByText("1 of 3")).toBeInTheDocument();
  });

  it("is not a sonner toast, so the toaster's hover cannot clip it", () => {
    // Sonner measured the card once, before its pager row appeared, and pinned
    // it to that height on hover — the bottom of the card went off-screen.
    frames = [frame(), frame()];
    run();
    renderToast();
    expect(card().closest("[data-sonner-toast]")).toBeNull();
    expect(card().closest(".fixed")).not.toBeNull();
  });

  it("moves the app's toasts up while it holds the corner, and gives the room back", () => {
    const height = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(136);
    try {
      frames = [frame()];
      run();
      renderToast();
      expect(toastInset()).toBe(136);

      act(() => clearAlarms());
      expect(toastInset()).toBe(0);
    } finally {
      height.mockRestore();
    }
  });

  it("stays quiet for anything below an alarm", () => {
    // The rule that keeps the mechanism worth having.
    frames = [frame({ severity: "info" }), frame({ severity: "warning" })];
    run();
    expect(alarmQueue()).toHaveLength(0);
  });

  it("shows no pop-up when the operator turned pop-ups off — and still rings", () => {
    prefs = { event_alert_popup: false };
    frames = [frame()];
    run();
    expect(alarmQueue()).toHaveLength(0);
    expect(tone).toHaveBeenCalledWith("alarm", 70, "hilo");
  });

  it("says a thing once, however often the buffer replays it", () => {
    const one = frame({ event_id: "ev-dup" });
    frames = [one, { ...one }];
    run();
    expect(alarmQueue()).toHaveLength(1);
  });
});

describe("on the Events page (SCRUM-327)", () => {
  it("queues the alarm for the page's alarm window, and keeps the corner card away", () => {
    // The operator may be reading another event or the table: the feed alone
    // does not tell them. The window in the middle of the page does (AlarmWindow,
    // which the page renders); the corner stays empty, and so do the toasts' room.
    const height = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(136);
    try {
      pathname = "/events";
      frames = [frame({ event_type: "tamper" })];
      run();
      renderToast();
      expect(alarmQueue()).toHaveLength(1);
      expect(screen.queryByRole("region", { name: /alarm:/i })).not.toBeInTheDocument();
      expect(toastInset()).toBe(0);
    } finally {
      height.mockRestore();
    }
  });

  it("shows the corner card there instead when the operator turned the window off", () => {
    prefs = { event_alert_popup_on_events: false };
    pathname = "/events";
    frames = [frame()];
    run();
    renderToast();
    expect(card()).toBeInTheDocument();
    expect(tone).toHaveBeenCalledTimes(1);
  });

  it("does not pop up LATER an alarm that arrived while pop-ups were off", () => {
    // The buffer replays when the settings change. An alarm that has had its
    // moment must not chase the operator afterwards.
    prefs = { event_alert_popup: false };
    pathname = "/events";
    const one = frame({ event_id: "ev-seen" });
    frames = [one];
    const { rerender } = renderHook(() => useEventNotifier(), { wrapper });

    prefs = {};
    pathname = "/streaming";
    rerender();
    expect(alarmQueue()).toHaveLength(0);
  });
});

describe("the alert tone (SCRUM-326)", () => {
  it("rings the critical tone for a critical, at the operator's volume", () => {
    prefs = { event_alert_volume: 40 };
    frames = [frame({ severity: "critical", event_type: "tamper" })];
    run();
    expect(tone).toHaveBeenCalledWith("critical", 40, "yelp");
  });

  it("rings in the sound the operator picked for that priority (SCRUM-327)", () => {
    prefs = { event_alert_critical_sound: "warble", event_alert_alarm_sound: "horn" };
    frames = [frame({ severity: "critical" })];
    const { rerender } = run();
    expect(tone).toHaveBeenLastCalledWith("critical", 70, "warble");

    // Past the burst window, so the next alarm rings on its own.
    const later = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 10_000);
    frames = [frame(), ...frames];
    rerender();
    later.mockRestore();
    expect(tone).toHaveBeenLastCalledWith("alarm", 70, "horn");
  });

  it("rings on the Events page too", () => {
    // An operator on the other monitor still has to be told.
    pathname = "/events";
    frames = [frame()];
    run();
    expect(tone).toHaveBeenCalledTimes(1);
  });

  it("rings ONCE for a burst, at its worst severity", () => {
    frames = [frame(), frame({ severity: "critical" }), frame()];
    run();
    expect(tone).toHaveBeenCalledTimes(1);
    expect(tone).toHaveBeenCalledWith("critical", 70, "yelp");
    expect(alarmQueue()).toHaveLength(3);
  });

  it("stays silent when muted, and the card still comes", () => {
    prefs = { event_alert_sound: false };
    frames = [frame()];
    run();
    expect(tone).not.toHaveBeenCalled();
    expect(alarmQueue()).toHaveLength(1);
  });

  it("stays silent through a timed mute, and rings once it has run out", () => {
    prefs = { event_alert_mute_until: Date.now() + 60_000 };
    frames = [frame()];
    run();
    expect(tone).not.toHaveBeenCalled();
    expect(alarmQueue()).toHaveLength(1);

    tone.mockClear();
    prefs = { event_alert_mute_until: Date.now() - 1 };
    frames = [frame()];
    run();
    expect(tone).toHaveBeenCalledTimes(1);
  });

  it("does not ring for what the operator does not want to hear", () => {
    prefs = { event_alert_level: "critical" };
    frames = [frame({ severity: "alarm" }), frame({ severity: "info" })];
    run();
    expect(tone).not.toHaveBeenCalled();
    expect(alarmQueue()).toHaveLength(0);
  });
});

describe("plate reads (SCRUM-326)", () => {
  const plate = (list: string, severity: string) =>
    frame({
      event_type: "anpr",
      severity,
      raw: { node_id: "n1", payload: { anpr: { read_id: `r-${list}`, plate: "PB10GN4497", list } } },
    });

  it("with 'block-list hits only', a visitor's read stays in the list and a hit interrupts", () => {
    prefs = { event_alert_anpr: "hits" };
    frames = [plate("visitor", "alarm")];
    const { rerender } = run();
    expect(alarmQueue()).toHaveLength(0);
    expect(tone).not.toHaveBeenCalled();

    frames = [plate("block", "critical"), ...frames];
    rerender();
    expect(alarmQueue()).toHaveLength(1);
    expect(tone).toHaveBeenCalledWith("critical", 70, "yelp");
  });

  it("with plate alerts off, no read interrupts — other alarms still do", () => {
    prefs = { event_alert_anpr: "off" };
    frames = [plate("block", "critical"), frame({ severity: "alarm" })];
    run();
    expect(alarmQueue()).toHaveLength(1);
    expect(alarmQueue()[0].event.event_type).toBe("motion");
  });
});

// SCRUM-334: a recorder going down or coming back refreshes every list that shows
// its cameras at once, instead of each waiting out its own poll — the wall goes dark,
// and plays again, within the heartbeat that noticed.
describe("a recorder going down or coming back", () => {
  function runWithClient() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const own = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    renderHook(() => useEventNotifier(), { wrapper: own });
    return invalidate.mock.calls.map(([arg]) => JSON.stringify((arg as { queryKey: unknown }).queryKey));
  }

  it.each(["recorder_offline", "recorder_online"])("%s refreshes the camera lists and the recorders", (type) => {
    frames = [frame({ event_type: type, camera_id: null, severity: "critical" })];
    const keys = runWithClient();
    for (const key of RECORDER_STATE_QUERIES) expect(keys).toContain(JSON.stringify(key));
  });

  it("leaves the lists alone for an ordinary camera event", () => {
    frames = [frame({ event_type: "motion" })];
    expect(runWithClient()).toEqual([]);
  });
});
