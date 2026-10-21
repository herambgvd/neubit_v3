/**
 * FULL SCREEN, VIDEO ONLY (SCRUM-335).
 *
 * The wall's full-screen button put the wall ELEMENT full screen: the toolbar and
 * the camera rail came with it, and the alarm card, toasts and dialogs — all
 * portalled outside it — could no longer be seen. Every VMS does it the other way:
 * the document goes full screen, the video takes the monitor, and the controls
 * come back on the mouse and leave on their own.
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CHROME_IDLE_MS, useImmersive } from "./useImmersive";

let fullscreenElement: Element | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  fullscreenElement = null;
  Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => fullscreenElement });
  document.documentElement.requestFullscreen = vi.fn(async () => {
    fullscreenElement = document.documentElement;
    document.dispatchEvent(new Event("fullscreenchange"));
  });
  document.exitFullscreen = vi.fn(async () => {
    fullscreenElement = null;
    document.dispatchEvent(new Event("fullscreenchange"));
  });
});

afterEach(() => {
  vi.useRealTimers();
});

const idle = () => act(() => vi.advanceTimersByTime(CHROME_IDLE_MS + 50));
const moveMouse = () => act(() => window.dispatchEvent(new MouseEvent("mousemove")));

describe("full screen", () => {
  it("is the document's, so alarms, toasts and dialogs stay on top of the video", async () => {
    const { result } = renderHook(() => useImmersive());

    await act(async () => result.current.toggle());

    expect(document.documentElement.requestFullscreen).toHaveBeenCalledTimes(1);
    expect(result.current.fullscreen).toBe(true);
    expect(result.current.immersive).toBe(true);
  });

  it("the same control leaves it", async () => {
    const { result } = renderHook(() => useImmersive());
    await act(async () => result.current.toggle());

    await act(async () => result.current.toggle());

    expect(document.exitFullscreen).toHaveBeenCalledTimes(1);
    expect(result.current.immersive).toBe(false);
  });

  it("follows Esc, or anything else that leaves full screen behind its back", async () => {
    const { result } = renderHook(() => useImmersive());
    await act(async () => result.current.enter());

    act(() => {
      fullscreenElement = null;
      document.dispatchEvent(new Event("fullscreenchange"));
    });

    expect(result.current.immersive).toBe(false);
    expect(result.current.chromeShown).toBe(true);
  });
});

describe("the controls in full screen", () => {
  it("leave after a quiet spell, and the mouse brings them back", async () => {
    const { result } = renderHook(() => useImmersive());
    await act(async () => result.current.enter());
    expect(result.current.chromeShown).toBe(true);

    idle();
    expect(result.current.chromeShown).toBe(false);

    moveMouse();
    expect(result.current.chromeShown).toBe(true);
    idle();
    expect(result.current.chromeShown).toBe(false);
  });

  it("stay while the pointer is on them — a menu being read must not vanish", async () => {
    const { result } = renderHook(() => useImmersive());
    await act(async () => result.current.enter());

    act(() => result.current.holdProps.onMouseEnter());
    idle();
    idle();
    expect(result.current.chromeShown).toBe(true);

    act(() => result.current.holdProps.onMouseLeave());
    idle();
    expect(result.current.chromeShown).toBe(false);
  });

  it("are always there outside full screen", () => {
    const { result } = renderHook(() => useImmersive());

    idle();

    expect(result.current.immersive).toBe(false);
    expect(result.current.chromeShown).toBe(true);
  });
});

describe("a live screen's own window", () => {
  it("is immersive without full screen — the desktop app made its window full screen", () => {
    const { result } = renderHook(() => useImmersive({ forced: true }));

    expect(result.current.fullscreen).toBe(false);
    expect(result.current.immersive).toBe(true);
    idle();
    expect(result.current.chromeShown).toBe(false);
  });
});
