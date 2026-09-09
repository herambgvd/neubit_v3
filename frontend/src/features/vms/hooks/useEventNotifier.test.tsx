/**
 * THE SPLIT EVERY ENTERPRISE VMS MAKES, and why it is not cosmetic.
 *
 *   * On the alarm-MONITORING surface, an alarm shows its VIDEO — the operator is
 *     there to watch, so the console switches the canvas.
 *   * ANYWHERE ELSE it is a corner toast: what, where, and one click to go look.
 *     Never a camera thrown over a form somebody is filling in.
 *
 * And a rule that decides whether the mechanism is worth anything at all: it
 * fires for alarms, not for every frame the estate produces. A console that
 * toasts a heartbeat teaches an operator to ignore toasts, and then it has no way
 * left to tell them something is wrong.
 */
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock is hoisted above the file's own consts, so the spy is created INSIDE
// the factory and read back through the mocked module.
vi.mock("sonner", () => {
  const fn = vi.fn();
  return { toast: Object.assign(fn, { success: vi.fn(), error: vi.fn() }) };
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

import { toast as toastImport } from "sonner";

import { setEventsMuted, useEventNotifier } from "./useEventNotifier";

const toast = toastImport as unknown as ReturnType<typeof vi.fn>;

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
  toast.mockClear();
  push.mockClear();
  frames = [];
  pathname = "/streaming";
  setEventsMuted(false);
});

describe("off the Events page", () => {
  it("toasts an alarm with what and where", () => {
    frames = [frame({ event_type: "tamper" })];
    renderHook(() => useEventNotifier());

    expect(toast).toHaveBeenCalledTimes(1);
    expect(String(toast.mock.calls[0][0])).toMatch(/tamper · Channel 1/);
  });

  it("takes one click to the event that raised it", () => {
    frames = [frame({ event_id: "ev-9" })];
    renderHook(() => useEventNotifier());

    const opts = toast.mock.calls[0][1] as { action: { onClick: () => void } };
    opts.action.onClick();
    expect(push).toHaveBeenCalledWith("/camera-events?event=ev-9");
  });

  it("stays quiet for anything below an alarm", () => {
    // The rule that keeps the mechanism worth having.
    frames = [frame({ severity: "info" }), frame({ severity: "warning" })];
    renderHook(() => useEventNotifier());
    expect(toast).not.toHaveBeenCalled();
  });

  it("stays quiet when the operator muted it", () => {
    setEventsMuted(true);
    frames = [frame()];
    renderHook(() => useEventNotifier());
    expect(toast).not.toHaveBeenCalled();
  });

  it("says a thing once, however often the buffer replays it", () => {
    const one = frame({ event_id: "ev-dup" });
    frames = [one, { ...one }];
    renderHook(() => useEventNotifier());
    expect(toast).toHaveBeenCalledTimes(1);
  });
});

describe("on the Events page", () => {
  it("says nothing — the video is already showing it", () => {
    pathname = "/camera-events";
    frames = [frame()];
    renderHook(() => useEventNotifier());
    expect(toast).not.toHaveBeenCalled();
  });

  it("does not toast it LATER either, once the operator navigates away", () => {
    // The buffer replays on the next surface. An event they already watched must
    // not chase them across the console.
    pathname = "/camera-events";
    const one = frame({ event_id: "ev-seen" });
    frames = [one];
    const { rerender } = renderHook(() => useEventNotifier());

    pathname = "/streaming";
    rerender();
    expect(toast).not.toHaveBeenCalled();
  });
});
