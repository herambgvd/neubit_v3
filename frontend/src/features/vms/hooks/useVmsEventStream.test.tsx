/**
 * The camera-event stream, pinned at the seam (EventSource is stubbed; nothing
 * here talks to a server):
 *
 *   1. mounting BEFORE the access token exists must retry, not give up — the
 *      token lives in memory only, so a page that mounts while the auth provider
 *      is still probing the refresh cookie sees none, and a bare `return` there
 *      left the stream dead for the rest of the session
 *   2. the token is read at CONNECT time, so a reconnect uses the refreshed one
 *   3. the connection is closed on unmount and when the caller disables it
 *   4. the buffer is capped, newest first
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { tokens } from "@/lib/api";
import { FakeEventSource, stubEventSource } from "@/test/eventsource";

import { useVmsEventStream } from "./useVmsEventStream";

beforeEach(() => {
  vi.useFakeTimers();
  stubEventSource();
  tokens.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Let the hook's backoff timers fire. */
const runBackoff = async () => {
  await act(async () => {
    vi.advanceTimersByTime(60_000);
  });
};

describe("connecting without a session yet", () => {
  it("retries until the access token appears instead of staying dead", async () => {
    renderHook(() => useVmsEventStream({}));
    expect(FakeEventSource.instances).toHaveLength(0);

    // Still nothing to connect with — but the hook must keep trying.
    await runBackoff();
    expect(FakeEventSource.instances).toHaveLength(0);

    tokens.set("late-arriving-token");
    await runBackoff();

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.last?.url).toContain("late-arriving-token");
  });

  it("reconnects with the token stored after a refresh, not the one it mounted with", async () => {
    tokens.set("first-token");
    renderHook(() => useVmsEventStream({}));
    expect(FakeEventSource.last?.url).toContain("first-token");

    tokens.set("refreshed-token");
    await act(async () => {
      FakeEventSource.last?.fail();
    });
    await runBackoff();

    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.last?.url).toContain("refreshed-token");
  });
});

describe("stream lifecycle", () => {
  it("closes the connection when the consumer unmounts", async () => {
    tokens.set("t");
    const { unmount } = renderHook(() => useVmsEventStream({}));
    const es = FakeEventSource.last;

    unmount();

    expect(es?.closed).toBe(true);
  });

  it("opens no connection at all while the caller has it disabled", async () => {
    tokens.set("t");
    renderHook(() => useVmsEventStream({ enabled: false }));
    await runBackoff();
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it("keeps only the filtered camera's events off the shared stream", async () => {
    tokens.set("t");
    const { result } = renderHook(() => useVmsEventStream({ cameraId: "cam-7" }));
    await act(async () => {
      FakeEventSource.last?.emit("vms.event", { id: "a", camera_id: "cam-7" });
      FakeEventSource.last?.emit("vms.event", { id: "b", camera_id: "cam-9" });
    });
    expect(result.current.events.map((e) => e.id)).toEqual(["a"]);
  });

  it("shares ONE connection between every consumer in the tab (SCRUM-325)", async () => {
    // Three streams per tab held three of the browser's six connections to the
    // host for good, and the events page queued behind them on "Loading events…".
    tokens.set("t");
    const first = renderHook(() => useVmsEventStream({}));
    const second = renderHook(() => useVmsEventStream({ cameraId: "cam-7" }));
    expect(FakeEventSource.instances).toHaveLength(1);

    await act(async () => {
      FakeEventSource.last?.open();
      FakeEventSource.last?.emit("vms.event", { id: "a", camera_id: "cam-7" });
    });
    expect(first.result.current.events.map((e) => e.id)).toEqual(["a"]);
    expect(second.result.current.connected).toBe(true);

    // The stream stays up while anyone still listens, and closes with the last.
    const es = FakeEventSource.last;
    first.unmount();
    expect(es?.closed).toBe(false);
    second.unmount();
    expect(es?.closed).toBe(true);
  });

  it("reports itself connected only after the server actually opens the stream", async () => {
    tokens.set("t");
    const { result } = renderHook(() => useVmsEventStream({}));
    expect(result.current.connected).toBe(false);

    await act(async () => {
      FakeEventSource.last?.open();
    });
    expect(result.current.connected).toBe(true);

    await act(async () => {
      FakeEventSource.last?.fail();
    });
    expect(result.current.connected).toBe(false);
  });
});

describe("the event buffer", () => {
  it("keeps the newest event first", async () => {
    tokens.set("t");
    const { result } = renderHook(() => useVmsEventStream({}));

    await act(async () => {
      FakeEventSource.last?.emit("vms.event", { id: "older" });
      FakeEventSource.last?.emit("vms.event", { id: "newer" });
    });

    expect(result.current.events.map((e) => e.id)).toEqual(["newer", "older"]);
  });

  it("never grows past the cap, however long the stream stays open", async () => {
    tokens.set("t");
    const { result } = renderHook(() => useVmsEventStream({ max: 3 }));

    await act(async () => {
      for (let i = 0; i < 25; i += 1) FakeEventSource.last?.emit("vms.event", { id: `e${i}` });
    });

    expect(result.current.events).toHaveLength(3);
    expect(result.current.events[0]?.id).toBe("e24");
  });

  it("ignores a keepalive comment rather than pushing a null event", async () => {
    tokens.set("t");
    const { result } = renderHook(() => useVmsEventStream({}));

    await act(async () => {
      FakeEventSource.last?.emit("vms.event", "not json at all");
    });

    expect(result.current.events).toHaveLength(0);
  });
});
