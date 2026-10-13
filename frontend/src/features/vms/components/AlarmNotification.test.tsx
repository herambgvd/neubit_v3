/**
 * THE CORNER ALARM CARD (SCRUM-312).
 *
 * A burst used to be a stack of toasts with gaps between them, some of which
 * never left: sonner paused every timer while its stack was expanded, and a
 * dismissal under the cursor could leave it expanded. What is pinned here is the
 * replacement — one card, paged, on a clock of its own that always resumes —
 * and the pop-up it became (SCRUM-327): the clock on show, the operator's own
 * time, a critical in front of every alarm, focus that pauses it, Esc that closes.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import AlarmNotification, { LINGER_MS } from "./AlarmNotification";
import { AUTO_HIDE_MS, alarmQueue, clearAlarms, pushAlarm, removeAlarm, type QueuedAlarm } from "../alarmQueue";

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

/** The card, by its label — a region, not an alert, so its countdown is not read out. */
const card = () => screen.getByRole("region", { name: /alarm:/i });
const noCard = () => expect(screen.queryByRole("region", { name: /alarm:/i })).not.toBeInTheDocument();

const handlers = () => ({
  onView: vi.fn(),
  onAck: vi.fn(),
  onDismiss: vi.fn(),
  onMute: vi.fn(),
});

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
  act(() => clearAlarms());
});

afterEach(() => {
  act(() => clearAlarms());
  vi.useRealTimers();
});

describe("a burst", () => {
  it("is one card paged newest first, not a stack", () => {
    act(() => {
      pushAlarm(alarm("a"));
      pushAlarm(alarm("b"));
      pushAlarm(alarm("c"));
    });
    render(<AlarmNotification {...handlers()} />);

    expect(screen.getAllByRole("region", { name: /alarm:/i })).toHaveLength(1);
    expect(screen.getByText("Camera c")).toBeInTheDocument();
    expect(screen.getByText("1 of 3")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /older alarm/i }));
    expect(screen.getByText("Camera b")).toBeInTheDocument();
    expect(screen.getByText("2 of 3")).toBeInTheDocument();
  });

  it("shows the newest again when another alarm arrives", () => {
    act(() => {
      pushAlarm(alarm("a"));
      pushAlarm(alarm("b"));
    });
    render(<AlarmNotification {...handlers()} />);
    fireEvent.click(screen.getByRole("button", { name: /older alarm/i }));
    expect(screen.getByText("Camera a")).toBeInTheDocument();

    act(() => pushAlarm(alarm("c")));
    expect(screen.getByText("Camera c")).toBeInTheDocument();
    expect(screen.getByText("1 of 3")).toBeInTheDocument();
  });

  it("clears every queued alarm with one control", () => {
    const h = handlers();
    act(() => {
      pushAlarm(alarm("a"));
      pushAlarm(alarm("b"));
    });
    render(<AlarmNotification {...h} />);

    fireEvent.click(screen.getByRole("button", { name: /clear all \(2\)/i }));
    expect(alarmQueue()).toHaveLength(0);
    noCard();
  });

  it("has no pager or clear-all for a single alarm — Dismiss is that", () => {
    act(() => pushAlarm(alarm("a")));
    render(<AlarmNotification {...handlers()} />);
    expect(screen.queryByText(/of 1/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /clear all/i })).not.toBeInTheDocument();
  });
});

describe("the card's own clock", () => {
  it("leaves 15 s after the newest alarm", () => {
    act(() => pushAlarm(alarm("a")));
    render(<AlarmNotification {...handlers()} />);

    act(() => vi.advanceTimersByTime(AUTO_HIDE_MS - 1));
    expect(alarmQueue()).toHaveLength(1);
    act(() => vi.advanceTimersByTime(1));
    expect(alarmQueue()).toHaveLength(0);
    noCard();
  });

  it("waits while the pointer is on it, and still leaves after the pointer goes", () => {
    act(() => pushAlarm(alarm("a")));
    render(<AlarmNotification {...handlers()} />);
    const box = card().parentElement as HTMLElement;

    fireEvent.mouseEnter(box);
    act(() => vi.advanceTimersByTime(AUTO_HIDE_MS * 3));
    expect(alarmQueue()).toHaveLength(1);

    // The bug this replaces: the pause never ended. Here it does — after a
    // short linger, so the card does not vanish the instant the pointer moves.
    fireEvent.mouseLeave(box);
    act(() => vi.advanceTimersByTime(LINGER_MS - 1));
    expect(alarmQueue()).toHaveLength(1);
    act(() => vi.advanceTimersByTime(1));
    expect(alarmQueue()).toHaveLength(0);
  });

  it("keeps running after the alarm under the pointer is dismissed", () => {
    // Dismissing the hovered alarm used to leave every timer paused.
    const h = handlers();
    act(() => {
      pushAlarm(alarm("a"));
      pushAlarm(alarm("b"));
    });
    h.onDismiss.mockImplementation((x: QueuedAlarm) => removeAlarm(x.key));
    render(<AlarmNotification {...h} />);
    const box = card().parentElement as HTMLElement;

    fireEvent.mouseEnter(box);
    act(() => fireEvent.click(screen.getByRole("button", { name: /dismiss alert/i })));
    fireEvent.mouseLeave(box);
    act(() => vi.advanceTimersByTime(AUTO_HIDE_MS + LINGER_MS));
    expect(alarmQueue()).toHaveLength(0);
  });

  it("holds a critical until someone decides", () => {
    act(() => {
      pushAlarm(alarm("a"));
      pushAlarm(alarm("crit", { severity: "critical" }));
    });
    render(<AlarmNotification {...handlers()} />);
    act(() => vi.advanceTimersByTime(AUTO_HIDE_MS * 10));
    expect(alarmQueue()).toHaveLength(2);
  });
});

describe("after it empties", () => {
  it("comes back for the next alarm", () => {
    act(() => pushAlarm(alarm("a")));
    render(<AlarmNotification {...handlers()} />);
    act(() => clearAlarms());
    noCard();

    act(() => pushAlarm(alarm("b")));
    expect(screen.getAllByRole("region", { name: /alarm:/i })).toHaveLength(1);
    expect(screen.getByText("Camera b")).toBeInTheDocument();
  });

  it("does not start the next card paused when it was emptied under the pointer", () => {
    // Clear all is clicked with the pointer ON the card, and the card goes with
    // it — no mouseleave ever comes. The next card must still leave on time.
    act(() => {
      pushAlarm(alarm("a"));
      pushAlarm(alarm("b"));
    });
    render(<AlarmNotification {...handlers()} />);
    fireEvent.mouseEnter(card().parentElement as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: /clear all/i }));

    act(() => pushAlarm(alarm("c")));
    act(() => vi.advanceTimersByTime(AUTO_HIDE_MS));
    expect(alarmQueue()).toHaveLength(0);
  });
});

describe("the buttons", () => {
  it("acknowledges the alarm on show, and views it", () => {
    const h = handlers();
    act(() => {
      pushAlarm(alarm("a"));
      pushAlarm(alarm("b"));
    });
    render(<AlarmNotification {...h} />);

    fireEvent.click(screen.getByRole("button", { name: /acknowledge/i }));
    expect(h.onAck).toHaveBeenCalledWith(expect.objectContaining({ key: "b" }));
    fireEvent.click(screen.getByRole("button", { name: /view video/i }));
    expect(h.onView).toHaveBeenCalledWith(expect.objectContaining({ key: "b" }));
  });
});

describe("the pop-up's clock, on show (SCRUM-327)", () => {
  it("says when it will close, and that it waits while the pointer is on it", () => {
    act(() => pushAlarm(alarm("a")));
    render(<AlarmNotification {...handlers()} />);
    expect(screen.getByText("Closes in 15 s")).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(5_000));
    expect(screen.getByText("Closes in 10 s")).toBeInTheDocument();

    fireEvent.mouseEnter(card().parentElement as HTMLElement);
    expect(screen.getByText("Paused")).toBeInTheDocument();
  });

  it("keeps the operator's time, or stays until closed", () => {
    act(() => pushAlarm(alarm("a")));
    const { rerender } = render(<AlarmNotification {...handlers()} closeAfterMs={30_000} />);
    act(() => vi.advanceTimersByTime(AUTO_HIDE_MS));
    expect(alarmQueue()).toHaveLength(1);
    act(() => vi.advanceTimersByTime(30_000 - AUTO_HIDE_MS));
    expect(alarmQueue()).toHaveLength(0);

    act(() => pushAlarm(alarm("b")));
    rerender(<AlarmNotification {...handlers()} closeAfterMs={null} />);
    expect(screen.getByText("Stays open")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(10 * 60_000));
    expect(alarmQueue()).toHaveLength(1);
  });

  it("holds a critical and says so — or lets it go when the operator chose that", () => {
    act(() => pushAlarm(alarm("crit", { severity: "critical" })));
    const { rerender } = render(<AlarmNotification {...handlers()} />);
    expect(screen.getByText("Stays until answered")).toBeInTheDocument();

    rerender(<AlarmNotification {...handlers()} criticalStays={false} />);
    act(() => vi.advanceTimersByTime(AUTO_HIDE_MS));
    expect(alarmQueue()).toHaveLength(0);
  });

  it("does not let a lesser alarm take the card from a critical, nor restart its clock", () => {
    act(() => pushAlarm(alarm("crit", { severity: "critical" })));
    render(<AlarmNotification {...handlers()} criticalStays={false} />);
    act(() => vi.advanceTimersByTime(10_000));

    act(() => pushAlarm(alarm("later")));
    expect(screen.getByText("Camera crit")).toBeInTheDocument();
    expect(screen.getByText("1 of 2")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(AUTO_HIDE_MS - 10_000));
    expect(alarmQueue()).toHaveLength(0);
  });

  it("pauses while focus is in it, and Esc there closes the alarm on show", () => {
    const h = handlers();
    act(() => pushAlarm(alarm("a")));
    render(<AlarmNotification {...h} />);

    act(() => screen.getByRole("button", { name: /acknowledge/i }).focus());
    expect(screen.getByText("Paused")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(AUTO_HIDE_MS * 2));
    expect(alarmQueue()).toHaveLength(1);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(h.onDismiss).toHaveBeenCalledWith(expect.objectContaining({ key: "a" }));
  });

  it("ignores Esc pressed anywhere else on the page", () => {
    const h = handlers();
    act(() => pushAlarm(alarm("a")));
    render(
      <>
        <input aria-label="elsewhere" />
        <AlarmNotification {...h} />
      </>,
    );
    act(() => screen.getByRole("textbox", { name: "elsewhere" }).focus());
    fireEvent.keyDown(document, { key: "Escape" });
    expect(h.onDismiss).not.toHaveBeenCalled();
  });

  it("shows the alarm's picture, and the words the page gives its view button", () => {
    act(() => pushAlarm(alarm("a")));
    render(
      <AlarmNotification
        {...handlers()}
        viewLabel="Show in panes"
        media={(x) => <img alt={`picture of ${x.key}`} />}
      />,
    );
    expect(screen.getByRole("img", { name: "picture of a" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /show in panes/i })).toBeInTheDocument();
  });
});
