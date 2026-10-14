/**
 * THE ALARM WINDOW (SCRUM-327) — how a new alarm opens on the Events page: in the
 * middle of the screen, large, with what / how bad / where / when, the page's own
 * picture and details for it, the other alarms waiting, and the window's own
 * clock. Pinned here: it is a labelled modal dialog that takes focus without
 * pressing anything, closes on ✕ or Esc but not on a stray click, pages a burst,
 * and lets go of an alarm without acknowledging it.
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import AlarmWindow from "./AlarmWindow";
import { alarmQueue, clearAlarms, pushAlarm, type QueuedAlarm } from "../alarmQueue";

const alarm = (key: string, over: Partial<QueuedAlarm["event"]> = {}): QueuedAlarm => ({
  key,
  event: {
    id: key,
    event_id: key,
    event_type: "tamper",
    severity: "alarm",
    occurred_at: new Date().toISOString(),
    camera_id: `cam-${key}`,
    ...over,
  } as QueuedAlarm["event"],
  cameraName: `Camera ${key}`,
  recorderName: "recorder-a",
  ackId: key,
  raisedAt: Date.now(),
});

const props = () => ({
  onMute: vi.fn(),
  onShowInPanes: vi.fn(),
  renderMedia: (a: QueuedAlarm) => <div>picture of {a.key}</div>,
  renderDetails: (a: QueuedAlarm) => <div>details of {a.key}</div>,
});

const dialog = () => screen.getByRole("dialog");

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
  act(() => clearAlarms());
});

afterEach(() => {
  act(() => clearAlarms());
  vi.useRealTimers();
});

describe("the window", () => {
  it("opens for an alarm with what, how bad, where and when, the picture and the details", () => {
    act(() => pushAlarm(alarm("a")));
    render(<AlarmWindow {...props()} />);

    const w = within(dialog());
    expect(dialog()).toHaveAttribute("aria-modal", "true");
    expect(w.getByRole("heading", { name: "Tamper" })).toBeInTheDocument();
    expect(w.getByText("Alarm")).toBeInTheDocument();
    expect(w.getByText(/recorder-a/)).toBeInTheDocument();
    expect(w.getByText("picture of a")).toBeInTheDocument();
    expect(w.getByText("details of a")).toBeInTheDocument();
  });

  it("is not there without an alarm", () => {
    render(<AlarmWindow {...props()} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("takes focus onto itself — no button an Enter could press by accident", () => {
    act(() => pushAlarm(alarm("a")));
    render(<AlarmWindow {...props()} />);
    expect(document.activeElement).toBe(dialog());
    // Focus on the window itself is not reading: the clock still runs.
    expect(screen.getByText("Closes in 15 s")).toBeInTheDocument();
  });

  it("leads a plate read with its plate", () => {
    act(() =>
      pushAlarm(
        alarm("p", {
          event_type: "anpr",
          raw: { node_id: "n1", payload: { anpr: { read_id: "r1", plate: "PB10GN4497", list: "block" } } },
        }),
      ),
    );
    render(<AlarmWindow {...props()} />);
    expect(screen.getByRole("heading", { name: "ANPR · PB10GN4497" })).toBeInTheDocument();
  });

  it("shares the column between the picture and a linked camera, and gives an alarm without one the whole of it", () => {
    act(() => {
      pushAlarm(alarm("a"));
      pushAlarm(alarm("b"));
    });
    const extra = (a: QueuedAlarm) => (a.key === "b" ? <div>linked of {a.key}</div> : null);
    render(<AlarmWindow {...props()} renderExtra={extra} />);

    // Newest in front: b has a linked camera, and it shares the column.
    const picture = screen.getByText("picture of b").parentElement!;
    expect(screen.getByText("linked of b").parentElement!.parentElement).toBe(picture.parentElement);
    expect(picture.parentElement!.children).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: /next alarm/i }));
    expect(screen.getByText("picture of a").parentElement!.parentElement!.children).toHaveLength(1);
  });
});

describe("closing it", () => {
  it("closes on ✕ and on Esc — every alarm stays open in the list", () => {
    act(() => {
      pushAlarm(alarm("a"));
      pushAlarm(alarm("b"));
    });
    render(<AlarmWindow {...props()} />);
    fireEvent.click(screen.getByRole("button", { name: /close the alarm window/i }));
    expect(alarmQueue()).toHaveLength(0);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    act(() => pushAlarm(alarm("c")));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(alarmQueue()).toHaveLength(0);
  });

  it("closes on its own clock, and holds a critical until answered", () => {
    act(() => pushAlarm(alarm("a")));
    render(<AlarmWindow {...props()} />);
    act(() => vi.advanceTimersByTime(15_000));
    expect(alarmQueue()).toHaveLength(0);

    act(() => pushAlarm(alarm("crit", { severity: "critical" })));
    expect(screen.getByText("Stays until answered")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(10 * 60_000));
    expect(alarmQueue()).toHaveLength(1);
  });

  it("dismisses one alarm and shows the next", () => {
    act(() => {
      pushAlarm(alarm("a"));
      pushAlarm(alarm("b"));
    });
    render(<AlarmWindow {...props()} />);
    fireEvent.click(screen.getByRole("button", { name: /^dismiss$/i }));
    expect(alarmQueue().map((a) => a.key)).toEqual(["a"]);
    expect(screen.getByText("details of a")).toBeInTheDocument();
  });

  it("hands the alarm to the panes", () => {
    const p = props();
    act(() => pushAlarm(alarm("a")));
    render(<AlarmWindow {...p} />);
    fireEvent.click(screen.getByRole("button", { name: /show in panes/i }));
    expect(p.onShowInPanes).toHaveBeenCalledWith(expect.objectContaining({ key: "a" }));
  });
});

describe("a burst", () => {
  it("is one window, paged, with the others waiting one click away", () => {
    act(() => {
      pushAlarm(alarm("a"));
      pushAlarm(alarm("b"));
      pushAlarm(alarm("c"));
    });
    render(<AlarmWindow {...props()} />);
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByText("1 of 3")).toBeInTheDocument();
    expect(screen.getByText("Also waiting (2)")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Camera a/ }));
    expect(screen.getByText("details of a")).toBeInTheDocument();
    expect(screen.getByText("3 of 3")).toBeInTheDocument();
  });

  it("keeps what the operator is reading when another alarm arrives", () => {
    act(() => {
      pushAlarm(alarm("a"));
      pushAlarm(alarm("b"));
    });
    render(<AlarmWindow {...props()} />);
    fireEvent.click(screen.getByRole("button", { name: /next alarm/i }));
    expect(screen.getByText("details of a")).toBeInTheDocument();

    fireEvent.mouseEnter(dialog());
    act(() => pushAlarm(alarm("c")));
    expect(screen.getByText("details of a")).toBeInTheDocument();
    expect(screen.getByText("3 of 3")).toBeInTheDocument();
  });

  it("puts a critical in front of every alarm", () => {
    act(() => {
      pushAlarm(alarm("a"));
      pushAlarm(alarm("crit", { severity: "critical" }));
      pushAlarm(alarm("b"));
    });
    render(<AlarmWindow {...props()} />);
    expect(screen.getByText("details of crit")).toBeInTheDocument();
  });
});
