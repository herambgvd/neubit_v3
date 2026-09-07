/**
 * useLiveSession owns a media session's whole lifecycle, and every failure mode
 * here is expensive in a control room: a leaked session keeps a MediaMTX path
 * (and its upstream RTSP pull) alive forever, and a frozen renew leaves a tile
 * showing a still frame that LOOKS live. So these pin the seam — the session
 * control plane — and never hls.js or WebRTC:
 *
 *   1. unmount releases the session
 *   2. a failed renew restarts rather than freezing on a dead token
 *   3. the scheduleRenew ↔ start ref cycle re-arms exactly once per renew and
 *      does not run away
 *   4. a not-ready source is re-issued, and the poll is capped
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LiveSessionLike, LiveSessionSource } from "../types";
import { useLiveSession } from "./useLiveSession";

/** A session that expires far enough out that renew is scheduled, not immediate. */
function session(id: string, ready = true, expiresInMs = 60_000): LiveSessionLike {
  return {
    session_id: id,
    hls_url: `https://media/${id}.m3u8?token=x`,
    webrtc_url: `https://media/${id}/whep?token=x`,
    ready,
    expires_at: new Date(Date.now() + expiresInMs).toISOString(),
  } as LiveSessionLike;
}

/** A stub control plane with the same shape the real one has. */
function makeSource(overrides: Partial<LiveSessionSource> = {}) {
  const src: LiveSessionSource = {
    start: vi.fn(async () => session("s1")),
    renew: vi.fn(async () => session("s1")),
    release: vi.fn(async () => undefined),
    ...overrides,
  } as LiveSessionSource;
  return src;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Advance fake time by `ms` and let every promise the hook chained settle. */
const tick = (ms = 0) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

describe("session lifecycle", () => {
  it("releases the session when the player unmounts, so the path can be reaped", async () => {
    const src = makeSource();
    const { result, unmount } = renderHook(() => useLiveSession("cam-1", { source: src }));

    await tick();
    expect(result.current.hlsUrl).toContain("s1");

    unmount();

    expect(src.release).toHaveBeenCalledWith("s1");
  });

  it("releases the old session when the tile switches to another camera", async () => {
    const src = makeSource({
      start: vi.fn(async (cameraId: string) => session(`sess-${cameraId}`)),
    });
    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useLiveSession(id, { source: src }),
      { initialProps: { id: "cam-1" } },
    );
    await tick();
    expect(result.current.hlsUrl).toContain("sess-cam-1");

    rerender({ id: "cam-2" });

    await tick();
    expect(src.release).toHaveBeenCalledWith("sess-cam-1");
    await tick();
    expect(result.current.hlsUrl).toContain("sess-cam-2");
  });

  it("mints nothing at all while the tile is disabled or has no camera", async () => {
    const src = makeSource();
    renderHook(() => useLiveSession("cam-1", { source: src, enabled: false }));
    renderHook(() => useLiveSession(null, { source: src }));

    await tick(1_000);

    expect(src.start).not.toHaveBeenCalled();
  });

  it("surfaces a start failure as an error the operator can retry", async () => {
    const src = makeSource({ start: vi.fn(async () => Promise.reject(new Error("boom"))) });
    const { result } = renderHook(() => useLiveSession("cam-1", { source: src }));

    await tick();
    expect(result.current.error).toBeTruthy();
    expect(result.current.loading).toBe(false);

    (src.start as ReturnType<typeof vi.fn>).mockImplementation(async () => session("s2"));
    await act(async () => {
      result.current.retry();
      await vi.advanceTimersByTimeAsync(0);
    });

    await tick();
    expect(result.current.hlsUrl).toContain("s2");
    expect(result.current.error).toBeNull();
  });
});

describe("token renewal", () => {
  it("renews before expiry without re-minting the session", async () => {
    const src = makeSource({ renew: vi.fn(async () => session("s1")) });
    const { result } = renderHook(() => useLiveSession("cam-1", { source: src }));
    await tick();
    expect(result.current.hlsUrl).toBeTruthy();

    await tick(20_000);

    expect(src.renew).toHaveBeenCalledWith("cam-1", "s1");
    expect(src.start).toHaveBeenCalledTimes(1);
  });

  it("re-arms exactly one renew per cycle instead of multiplying timers", async () => {
    const src = makeSource({ renew: vi.fn(async () => session("s1")) });
    const { result } = renderHook(() => useLiveSession("cam-1", { source: src }));
    await tick();
    expect(result.current.hlsUrl).toBeTruthy();

    // Each renewed session expires 60s out and is renewed 45s early, so one
    // renew falls due every 15s. Four windows must produce four renews — not
    // 2, 4, 8, which is what a self-multiplying timer looks like.
    for (let cycle = 1; cycle <= 4; cycle += 1) {
      await tick(15_000);
      expect(src.renew).toHaveBeenCalledTimes(cycle);
    }
  });

  it("starts a fresh session when a renew fails, rather than freezing on a dead token", async () => {
    const src = makeSource({
      // Built lazily: each session's expiry is relative to when it was ISSUED.
      start: vi
        .fn()
        .mockImplementationOnce(async () => session("first"))
        .mockImplementation(async () => session("recovered")),
      renew: vi.fn(async () => Promise.reject(new Error("session reaped"))),
    });
    const { result } = renderHook(() => useLiveSession("cam-1", { source: src }));
    await tick();
    expect(result.current.hlsUrl).toContain("first");

    await tick(20_000);

    await tick();
    expect(result.current.hlsUrl).toContain("recovered");
    expect(src.start).toHaveBeenCalledTimes(2);
  });
});

describe("cold-start warm-up", () => {
  it("re-issues while the upstream source is still warming up, and stops once ready", async () => {
    const src = makeSource({
      start: vi
        .fn()
        .mockImplementationOnce(async () => session("warm", false))
        .mockImplementationOnce(async () => session("warm", false))
        .mockImplementation(async () => session("warm", true)),
    });
    const { result } = renderHook(() => useLiveSession("cam-1", { source: src }));
    await tick();
    expect(result.current.ready).toBe(false);

    await tick(10_000);

    await tick();
    expect(result.current.ready).toBe(true);
    const afterReady = (src.start as ReturnType<typeof vi.fn>).mock.calls.length;

    await tick(10_000);
    expect((src.start as ReturnType<typeof vi.fn>).mock.calls.length).toBe(afterReady);
  });

  it("gives up polling a source that never becomes ready instead of spinning forever", async () => {
    const src = makeSource({ start: vi.fn(async () => session("cold", false, 3_600_000)) });
    renderHook(() => useLiveSession("cam-1", { source: src }));

    await tick(120_000);

    // 1 initial issue + at most the capped number of warm-up polls.
    expect((src.start as ReturnType<typeof vi.fn>).mock.calls.length).toBeLessThanOrEqual(7);
  });
});
