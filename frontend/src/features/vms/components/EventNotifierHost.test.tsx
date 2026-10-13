/**
 * THE RING LASTS AS LONG AS THE POP-UP (SCRUM-327): while it holds an alarm
 * nobody has answered or silenced, its priority keeps ringing — one looping
 * sound, started once and stopped when the pop-up lets go, not a timer that
 * replays a ring (a background tab's timers are throttled; its alarms would ring
 * late).
 */
import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const start = vi.fn((_t: string, _v: number, _id?: string) => true);
const stop = vi.fn();
vi.mock("../alertSound", async (orig) => ({
  ...(await orig<typeof import("../alertSound")>()),
  installAlertSoundUnlock: () => () => {},
  startAlertLoop: (t: string, v: number, id?: string) => start(t, v, id),
  stopAlertLoop: () => stop(),
}));

let soundState = "ready";
vi.mock("./EventAlertControl", () => ({ useAlertSoundState: () => soundState }));
vi.mock("./AlarmCorner", () => ({ default: () => null }));
vi.mock("../hooks/useEventNotifier", () => ({ useEventNotifier: () => {} }));

let prefs: Record<string, unknown> = {};
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { preferences: prefs }, reload: vi.fn() }) }));
vi.mock("@tanstack/react-query", () => ({ useMutation: () => ({ mutateAsync: vi.fn(), isPending: false }) }));

import EventNotifierHost from "./EventNotifierHost";
import { clearAlarms, pushAlarm, silenceAlarms, type QueuedAlarm } from "../alarmQueue";

const alarm = (key: string, severity: string): QueuedAlarm => ({
  key,
  event: { id: key, event_id: key, event_type: "tamper", severity } as QueuedAlarm["event"],
  cameraName: "Gate",
  recorderName: null,
  raisedAt: Date.now(),
});

beforeEach(() => {
  start.mockClear();
  stop.mockClear();
  prefs = {};
  soundState = "ready";
  act(() => clearAlarms());
});

describe("ringing until answered", () => {
  it("repeats a critical in the operator's sound, and stops when it is answered", () => {
    prefs = { event_alert_critical_sound: "hilo", event_alert_volume: 50 };
    render(<EventNotifierHost />);
    act(() => pushAlarm(alarm("c", "critical")));
    expect(start).toHaveBeenCalledWith("critical", 50, "hilo");

    act(() => clearAlarms());
    expect(stop).toHaveBeenCalled();
  });

  it("stops on Silence, and rings again for the next critical", () => {
    render(<EventNotifierHost />);
    act(() => pushAlarm(alarm("c1", "critical")));
    act(() => silenceAlarms());
    expect(stop).toHaveBeenCalledTimes(1);

    start.mockClear();
    act(() => pushAlarm(alarm("c2", "critical")));
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("keeps ringing an alarm while its pop-up is open, and stops when it closes", () => {
    render(<EventNotifierHost />);
    act(() => pushAlarm(alarm("a", "alarm")));
    expect(start).toHaveBeenCalledWith("alarm", 70, "hilo");

    act(() => clearAlarms());
    expect(stop).toHaveBeenCalled();
  });

  it("rings an alarm once when the operator turned the repeat off", () => {
    prefs = { event_alert_repeat_alarm: false };
    render(<EventNotifierHost />);
    act(() => pushAlarm(alarm("a", "alarm")));
    expect(start).not.toHaveBeenCalled();
  });

  it("stays quiet while muted, and while the browser holds sound back", () => {
    prefs = { event_alert_sound: false };
    const { unmount } = render(<EventNotifierHost />);
    act(() => pushAlarm(alarm("c", "critical")));
    expect(start).not.toHaveBeenCalled();
    unmount();

    prefs = {};
    soundState = "blocked";
    render(<EventNotifierHost />);
    expect(start).not.toHaveBeenCalled();
  });
});
