/**
 * The operator-popup stream. It is mounted ONCE app-wide, which is exactly why
 * a silent give-up is expensive: nothing else would ever re-arm it, and camera
 * popups — the thing an operator is meant to be interrupted by — would simply
 * stop for the rest of the session. So:
 *
 *   1. mounting before the access token exists must retry, not return
 *   2. the connection closes on unmount
 *   3. a burst of popups is capped, and the same event never pops twice
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { tokens } from "@/lib/api";
import { FakeEventSource, stubEventSource } from "@/test/eventsource";

import { useVmsPopups } from "./useVmsPopups";

vi.mock("sonner", () => ({ toast: { warning: vi.fn(), success: vi.fn(), error: vi.fn() } }));

beforeEach(() => {
  vi.useFakeTimers();
  stubEventSource();
  tokens.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const runBackoff = async () => {
  await act(async () => {
    vi.advanceTimersByTime(60_000);
  });
};

describe("connecting without a session yet", () => {
  it("retries until the access token appears instead of staying dead", async () => {
    renderHook(() => useVmsPopups());
    expect(FakeEventSource.instances).toHaveLength(0);

    tokens.set("late-arriving-token");
    await runBackoff();

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.last?.url).toContain("late-arriving-token");
  });

  it("closes the connection when the popup host unmounts", () => {
    tokens.set("t");
    const { unmount } = renderHook(() => useVmsPopups());
    const es = FakeEventSource.last;

    unmount();

    expect(es?.closed).toBe(true);
  });

  it("opens nothing while popups are disabled", async () => {
    tokens.set("t");
    renderHook(() => useVmsPopups({ enabled: false }));
    await runBackoff();
    expect(FakeEventSource.instances).toHaveLength(0);
  });
});

describe("the active popup queue", () => {
  const popup = (n: number) => ({
    event_id: `e${n}`,
    camera_id: `cam-${n}`,
    reason: `motion ${n}`,
    event_type: "motion",
  });

  it("never lets a burst cover the screen with more than three camera pops", async () => {
    tokens.set("t");
    const { result } = renderHook(() => useVmsPopups());

    await act(async () => {
      for (let i = 0; i < 10; i += 1) FakeEventSource.last?.emit("vms.popup", popup(i));
    });

    expect(result.current.active).toHaveLength(3);
  });

  it("pops the same event only once, however many times it is republished", async () => {
    tokens.set("t");
    const { result } = renderHook(() => useVmsPopups());

    await act(async () => {
      FakeEventSource.last?.emit("vms.popup", popup(1));
      FakeEventSource.last?.emit("vms.popup", popup(1));
      FakeEventSource.last?.emit("vms.popup", popup(1));
    });

    expect(result.current.active).toHaveLength(1);
  });

  it("drops a popup from the queue once the operator dismisses it", async () => {
    tokens.set("t");
    const { result } = renderHook(() => useVmsPopups());

    await act(async () => {
      FakeEventSource.last?.emit("vms.popup", popup(1));
    });
    const key = result.current.active[0]?.key;

    await act(async () => {
      result.current.dismiss(String(key));
    });

    expect(result.current.active).toHaveLength(0);
  });

  it("does not open a camera pop for a popup that names no camera", async () => {
    tokens.set("t");
    const { result } = renderHook(() => useVmsPopups());

    await act(async () => {
      FakeEventSource.last?.emit("vms.popup", { event_id: "no-cam", reason: "system" });
    });

    expect(result.current.active).toHaveLength(0);
  });
});
