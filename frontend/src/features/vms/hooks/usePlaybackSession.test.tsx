/**
 * usePlaybackSession — a RECORDED session pinned to a [from, to] window. Seeking
 * outside the window means issuing a NEW session, so the properties that matter
 * are about which request wins and what the operator is shown when one fails:
 *
 *   1. a failed load shows an error and NO session — never a stale player still
 *      pointed at the previous window
 *   2. a slow earlier seek must not overwrite the later one the operator made
 *   3. the renew re-issues the SAME window, once per cycle (the scheduleRenew
 *      self-reference is held in a ref; a cycle there would run away)
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { IsoWindow, PlayableSession } from "../types";
import { usePlaybackSession } from "./usePlaybackSession";

const WINDOW: IsoWindow = { from: "2026-01-01T00:00:00Z", to: "2026-01-01T01:00:00Z" };
const LATER: IsoWindow = { from: "2026-01-01T02:00:00Z", to: "2026-01-01T03:00:00Z" };

function session(id: string, win: IsoWindow = WINDOW): PlayableSession {
  return {
    session_id: id,
    hls_url: `https://media/${id}.m3u8?token=x`,
    from: win.from,
    to: win.to,
    ranges: [{ start: win.from, end: win.to }],
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  } as unknown as PlayableSession;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const tick = (ms = 0) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

describe("loading a window", () => {
  it("issues the session against the window the scrub bar asked for", async () => {
    const sourceFn = vi.fn(async (win: IsoWindow) => session("s1", win));
    const { result } = renderHook(() => usePlaybackSession("cam-1", { sourceFn }));

    await act(async () => {
      await result.current.load(WINDOW);
    });

    expect(sourceFn).toHaveBeenCalledWith(WINDOW);
    expect(result.current.hlsUrl).toContain("s1");
    expect(result.current.ranges).toHaveLength(1);
  });

  it("shows the failure and no player, rather than leaving the last window on screen", async () => {
    const sourceFn = vi
      .fn()
      .mockImplementationOnce(async () => session("good"))
      .mockImplementation(async () => Promise.reject(new Error("no footage")));
    const { result } = renderHook(() => usePlaybackSession("cam-1", { sourceFn }));

    await act(async () => {
      await result.current.load(WINDOW);
    });
    expect(result.current.hlsUrl).toContain("good");

    await act(async () => {
      await result.current.load(LATER);
    });

    expect(result.current.error).toBeTruthy();
    expect(result.current.hlsUrl).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it("ignores nonsense windows instead of asking the backend for them", async () => {
    const sourceFn = vi.fn(async () => session("s1"));
    const { result } = renderHook(() => usePlaybackSession("cam-1", { sourceFn }));

    await act(async () => {
      await result.current.load(null);
      await result.current.load({ from: "", to: "" } as IsoWindow);
    });

    expect(sourceFn).not.toHaveBeenCalled();
  });

  it("lets the operator's latest seek win when an earlier one resolves late", async () => {
    let releaseFirst: (() => void) | null = null;
    const sourceFn = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<PlayableSession>((resolve) => {
            releaseFirst = () => resolve(session("stale-seek", WINDOW));
          }),
      )
      .mockImplementation(async () => session("latest-seek", LATER));
    const { result } = renderHook(() => usePlaybackSession("cam-1", { sourceFn }));

    act(() => {
      void result.current.load(WINDOW);
    });
    await act(async () => {
      await result.current.load(LATER);
    });
    // The abandoned request now comes back — it must not win.
    await act(async () => {
      releaseFirst?.();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(result.current.hlsUrl).toContain("latest-seek");
  });

  it("forgets the session entirely when the caller clears it", async () => {
    const sourceFn = vi.fn(async () => session("s1"));
    const { result } = renderHook(() => usePlaybackSession("cam-1", { sourceFn }));
    await act(async () => {
      await result.current.load(WINDOW);
    });

    await act(async () => {
      result.current.clear();
    });

    expect(result.current.hlsUrl).toBeNull();
    expect(result.current.from).toBeNull();
    expect(result.current.error).toBeNull();
  });
});

describe("keeping a long scrub alive", () => {
  it("re-issues the SAME window before the media token expires", async () => {
    const sourceFn = vi.fn(async (win: IsoWindow) => session("s1", win));
    const { result } = renderHook(() => usePlaybackSession("cam-1", { sourceFn }));
    await act(async () => {
      await result.current.load(WINDOW);
    });

    await tick(15_000);

    expect(sourceFn).toHaveBeenCalledTimes(2);
    expect(sourceFn).toHaveBeenLastCalledWith(WINDOW);
  });

  it("re-arms one renew per cycle instead of multiplying timers", async () => {
    const sourceFn = vi.fn(async (win: IsoWindow) => session("s1", win));
    const { result } = renderHook(() => usePlaybackSession("cam-1", { sourceFn }));
    await act(async () => {
      await result.current.load(WINDOW);
    });

    // 60s TTL renewed 45s early = one re-issue every 15s.
    for (let cycle = 1; cycle <= 4; cycle += 1) {
      await tick(15_000);
      expect(sourceFn).toHaveBeenCalledTimes(cycle + 1);
    }
  });

  it("stops renewing once the player unmounts", async () => {
    const sourceFn = vi.fn(async (win: IsoWindow) => session("s1", win));
    const { result, unmount } = renderHook(() => usePlaybackSession("cam-1", { sourceFn }));
    await act(async () => {
      await result.current.load(WINDOW);
    });
    const before = sourceFn.mock.calls.length;

    unmount();
    await tick(60_000);

    expect(sourceFn).toHaveBeenCalledTimes(before);
  });
});

describe("a window the recorder has no footage for", () => {
  /**
   * The recorder answers 200 with an empty `playback_url` and `ranges: []` — a
   * normal reply, not a failure. It used to land as "success with no url", and
   * every consumer reads "no url yet" as STILL LOADING, so a camera with nothing
   * recorded showed a spinner that never resolved. On an estate where nothing was
   * recording, that was every tile on the page.
   */
  it("is reported as empty, not as still loading and not as an error", async () => {
    const sourceFn = vi.fn(async (win: IsoWindow) =>
      ({ session_id: "s-empty", hls_url: "", from: win.from, to: win.to, ranges: [] }) as unknown as PlayableSession,
    );
    const { result } = renderHook(() => usePlaybackSession("cam-1", { sourceFn }));

    await act(async () => {
      await result.current.load(WINDOW);
    });

    expect(result.current.empty).toBe(true);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.hlsUrl).toBeNull();
  });

  it("is not claimed for a session that plays over WebRTC only", async () => {
    // NVR footage often arrives as a WHEP url with no HLS at all; that IS playable.
    const sourceFn = vi.fn(async (win: IsoWindow) =>
      ({ session_id: "s-whep", hls_url: "", webrtc_url: "https://media/whep", from: win.from, to: win.to, ranges: [] }) as unknown as PlayableSession,
    );
    const { result } = renderHook(() => usePlaybackSession("cam-1", { sourceFn }));

    await act(async () => {
      await result.current.load(WINDOW);
    });

    expect(result.current.empty).toBe(false);
  });

  it("is not claimed while a load is still in flight", async () => {
    // Otherwise the tile flashes "no footage" on every seek before the answer lands.
    let release: (s: PlayableSession) => void = () => {};
    const sourceFn = vi.fn(() => new Promise<PlayableSession>((res) => (release = res)));
    const { result } = renderHook(() => usePlaybackSession("cam-1", { sourceFn }));

    act(() => {
      void result.current.load(WINDOW);
    });
    expect(result.current.loading).toBe(true);
    expect(result.current.empty).toBe(false);

    await act(async () => {
      release(session("s1"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.empty).toBe(false);
  });
});
