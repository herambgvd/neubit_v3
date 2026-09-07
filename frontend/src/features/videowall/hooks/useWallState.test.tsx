/**
 * useWallState — the console's single source of truth for a wall's live state.
 *
 * The load-bearing one here is IDENTITY: before anything has loaded the hook
 * returns a shared EMPTY object, not a fresh `{}`. A fresh literal changes
 * identity on every render, which made every consumer memo keyed on `state`
 * recompute every frame (the compiler's "existing memoization could not be
 * preserved"). That regression is cheap to reintroduce and invisible on screen,
 * so it gets its own test.
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { tokens } from "@/lib/api";
import { FakeEventSource, stubEventSource } from "@/test/eventsource";
import { queryWrapper } from "@/test/render";

import { videowall } from "../api";
import { useWallState } from "./useWallState";

beforeEach(() => {
  stubEventSource();
  tokens.set("t");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the not-yet-loaded wall", () => {
  it("hands every render the SAME empty state object, so consumer memos hold", async () => {
    vi.spyOn(videowall.state, "get").mockReturnValue(new Promise(() => {}));
    const { Wrapper } = queryWrapper();

    const { result, rerender } = renderHook(() => useWallState("w1"), { wrapper: Wrapper });
    const first = result.current.state;
    rerender();
    rerender();

    expect(result.current.state).toEqual({});
    expect(result.current.state).toBe(first);
  });

  it("reports itself loading, and stops once the snapshot lands", async () => {
    vi.spyOn(videowall.state, "get").mockResolvedValue({
      wall_id: "w1",
      state: { m1: { "0": "cam-a" } },
    });
    const { Wrapper } = queryWrapper();

    const { result } = renderHook(() => useWallState("w1"), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.state).toEqual({ m1: { "0": "cam-a" } });
  });

  it("asks for no snapshot at all while it is disabled", () => {
    const get = vi.spyOn(videowall.state, "get").mockResolvedValue({ wall_id: "w1", state: {} });
    const { Wrapper } = queryWrapper();

    renderHook(() => useWallState("w1", { enabled: false }), { wrapper: Wrapper });

    expect(get).not.toHaveBeenCalled();
    expect(FakeEventSource.instances).toHaveLength(0);
  });
});

describe("live frames and control mutations", () => {
  beforeEach(() => {
    vi.spyOn(videowall.state, "get").mockResolvedValue({ wall_id: "w1", state: { m1: { "0": "seed" } } });
  });

  it("lets a live frame overrule the seeded snapshot", async () => {
    const { Wrapper } = queryWrapper();
    const { result } = renderHook(() => useWallState("w1"), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.state).toEqual({ m1: { "0": "seed" } }));

    await act(async () => {
      FakeEventSource.last?.emit("wall.state", {
        wall_id: "w1",
        state: { m1: { "0": "from-sse" } },
      });
    });

    expect(result.current.state).toEqual({ m1: { "0": "from-sse" } });
  });

  it("shows the acting operator the pushed camera without waiting for the echo", async () => {
    const push = vi
      .spyOn(videowall.state, "push")
      .mockResolvedValue({ wall_id: "w1", state: { m1: { "2": "cam-x" } } });
    const { Wrapper } = queryWrapper();
    const { result } = renderHook(() => useWallState("w1"), { wrapper: Wrapper });

    await act(async () => {
      await result.current.push("m1", 2, "cam-x");
    });

    expect(push).toHaveBeenCalledWith("w1", {
      monitor_id: "m1",
      cell_index: 2,
      camera_id: "cam-x",
    });
    expect(result.current.state).toEqual({ m1: { "2": "cam-x" } });
  });

  it("clears one cell without touching the rest of the monitor", async () => {
    const clear = vi
      .spyOn(videowall.state, "clear")
      .mockResolvedValue({ wall_id: "w1", state: { m1: { "1": "kept" } } });
    const { Wrapper } = queryWrapper();
    const { result } = renderHook(() => useWallState("w1"), { wrapper: Wrapper });

    await act(async () => {
      await result.current.clearCell("m1", 0);
    });

    expect(clear).toHaveBeenCalledWith("w1", { monitor_id: "m1", cell_index: 0 });
    expect(result.current.state).toEqual({ m1: { "1": "kept" } });
  });

  it("clears a whole monitor by omitting the cell index entirely", async () => {
    const clear = vi.spyOn(videowall.state, "clear").mockResolvedValue({ wall_id: "w1", state: {} });
    const { Wrapper } = queryWrapper();
    const { result } = renderHook(() => useWallState("w1"), { wrapper: Wrapper });

    await act(async () => {
      await result.current.clearMonitor("m1");
    });

    expect(clear).toHaveBeenCalledWith("w1", { monitor_id: "m1" });
  });
});
