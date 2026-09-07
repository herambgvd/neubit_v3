/**
 * The video-wall SSE bridge. The wall's shared state is server-authoritative, so
 * the properties that matter are about the CONNECTION, not the payload rendering:
 *
 *   1. no access token yet → retry, never a silent permanent give-up
 *   2. every `wall.state` frame REPLACES the state (no hand-merging)
 *   3. a frame addressed to a different wall is ignored
 *   4. the connection is closed on unmount and when no wall is selected
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { tokens } from "@/lib/api";
import { FakeEventSource, stubEventSource } from "@/test/eventsource";

import { useWallStream } from "./useWallStream";

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

describe("connecting", () => {
  it("retries until the access token appears instead of staying dead", async () => {
    renderHook(() => useWallStream("w1"));
    expect(FakeEventSource.instances).toHaveLength(0);

    tokens.set("late-arriving-token");
    await runBackoff();

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.last?.url).toContain("wall_id=w1");
  });

  it("opens nothing until a wall is chosen", async () => {
    tokens.set("t");
    renderHook(() => useWallStream(null));
    await runBackoff();
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it("closes the connection when the console unmounts", () => {
    tokens.set("t");
    const { unmount } = renderHook(() => useWallStream("w1"));
    const es = FakeEventSource.last;

    unmount();

    expect(es?.closed).toBe(true);
  });

  it("re-subscribes when the operator switches to another wall", async () => {
    tokens.set("t");
    const { rerender } = renderHook(({ id }: { id: string }) => useWallStream(id), {
      initialProps: { id: "w1" },
    });
    const first = FakeEventSource.last;

    rerender({ id: "w2" });

    expect(first?.closed).toBe(true);
    expect(FakeEventSource.last?.url).toContain("wall_id=w2");
  });
});

describe("state frames", () => {
  const frame = (state: Record<string, Record<string, string>>, extra = {}) => ({
    wall_id: "w1",
    state,
    ...extra,
  });

  it("replaces the whole wall state on each frame rather than merging into it", async () => {
    tokens.set("t");
    const { result } = renderHook(() => useWallStream("w1"));

    await act(async () => {
      FakeEventSource.last?.emit("wall.state", frame({ m1: { "0": "cam-a" } }));
    });
    expect(result.current.state).toEqual({ m1: { "0": "cam-a" } });

    await act(async () => {
      FakeEventSource.last?.emit("wall.state", frame({ m2: { "0": "cam-b" } }));
    });
    // cam-a is GONE: the server said so.
    expect(result.current.state).toEqual({ m2: { "0": "cam-b" } });
  });

  it("ignores a frame belonging to a different wall", async () => {
    tokens.set("t");
    const { result } = renderHook(() => useWallStream("w1"));

    await act(async () => {
      FakeEventSource.last?.emit("wall.state", {
        wall_id: "someone-elses-wall",
        state: { m9: { "0": "cam-z" } },
      });
    });

    expect(result.current.state).toBeNull();
  });

  it("carries who changed the wall alongside the state", async () => {
    tokens.set("t");
    const { result } = renderHook(() => useWallStream("w1"));

    await act(async () => {
      FakeEventSource.last?.emit(
        "wall.state",
        frame({ m1: { "0": "cam-a" } }, { action: "push", actor_id: "u7" }),
      );
    });

    expect(result.current.lastFrame).toMatchObject({ action: "push", actor_id: "u7" });
  });

  it("survives a keepalive comment without clearing the wall", async () => {
    tokens.set("t");
    const { result } = renderHook(() => useWallStream("w1"));

    await act(async () => {
      FakeEventSource.last?.emit("wall.state", frame({ m1: { "0": "cam-a" } }));
      FakeEventSource.last?.emit("wall.state", ": keepalive");
    });

    expect(result.current.state).toEqual({ m1: { "0": "cam-a" } });
  });
});
