"use client";

// FULL SCREEN THE WAY A VMS DOES IT (SCRUM-335).
//
// The wall's full-screen button used to put the wall ELEMENT full screen — the
// toolbar and the camera rail with it — so the monitor filled up with the same
// chrome it had before, a little larger. And because element full screen shows
// only that element's subtree, the alarm card, the toasts and every dialog (all
// portalled to <body>) went invisible: an alarm raised while the wall was full
// screen was never seen.
//
// Every VMS client does the same thing here — Milestone's F11, Genetec, Nx,
// HikCentral: the video takes the monitor, the controls get out of the way, and
// moving the mouse brings back a bar that leaves again on its own. So:
//
//   * the DOCUMENT goes full screen, never an element, so anything the console
//     puts on top (alarms, toasts, dialogs, the PTZ panel) is still on top;
//   * while it is, the wall is IMMERSIVE: its chrome floats over the video and is
//     shown on any pointer or key activity, hidden after CHROME_IDLE_MS of none;
//   * never hidden while the pointer is ON the chrome — a menu being read must not
//     vanish from under the operator;
//   * the pointer itself hides over the video with the chrome.
//
// A live screen on another monitor (SCRUM-336) is immersive whether or not the
// document is full screen: the desktop app makes its WINDOW full screen, which the
// page cannot see, and it is a screen of video by definition.
//
// Shown and hidden instantly. The console does not animate (see the console rule).
import { useCallback, useEffect, useRef, useState } from "react";

/** How long the floating controls stay after the last pointer or key activity. */
export const CHROME_IDLE_MS = 3_000;

/** Activity that brings the chrome back. */
const WAKE_EVENTS = ["mousemove", "mousedown", "wheel", "keydown", "touchstart"] as const;

function documentIsFullscreen(): boolean {
  return typeof document !== "undefined" && !!document.fullscreenElement;
}

export interface UseImmersiveOptions {
  /** Immersive regardless of full screen — a live screen's own window. */
  forced?: boolean;
}

export function useImmersive({ forced = false }: UseImmersiveOptions = {}) {
  const [fullscreen, setFullscreen] = useState(documentIsFullscreen);

  useEffect(() => {
    const sync = () => setFullscreen(documentIsFullscreen());
    sync();
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);

  const enter = useCallback(() => {
    if (documentIsFullscreen()) return;
    // Refused without a user gesture (a deep link's autoplay) or by policy. Nothing
    // to do about either but stay as we are.
    document.documentElement.requestFullscreen?.().catch(() => undefined);
  }, []);

  const exit = useCallback(() => {
    if (!documentIsFullscreen()) return;
    document.exitFullscreen?.().catch(() => undefined);
  }, []);

  const toggle = useCallback(() => (documentIsFullscreen() ? exit() : enter()), [enter, exit]);

  const immersive = forced || fullscreen;

  // ── the chrome: shown on activity, gone after a quiet spell ─────────────────
  const [awake, setAwake] = useState(true);
  const held = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const schedule = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      if (!held.current) setAwake(false);
    }, CHROME_IDLE_MS);
  }, []);

  useEffect(() => {
    // A hold left over from the last time: the chrome it was on may have been
    // taken away without the pointer ever leaving it.
    held.current = false;
    if (!immersive) return undefined;
    const wake = () => {
      setAwake(true);
      schedule();
    };
    wake();
    for (const ev of WAKE_EVENTS) window.addEventListener(ev, wake, { passive: true });
    return () => {
      for (const ev of WAKE_EVENTS) window.removeEventListener(ev, wake);
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [immersive, schedule]);

  /** Spread on each floating piece of chrome: while the pointer is on it, it stays. */
  const holdProps = {
    onMouseEnter: () => {
      held.current = true;
      setAwake(true);
    },
    onMouseLeave: () => {
      held.current = false;
      schedule();
    },
  };

  return {
    /** The document is full screen. */
    fullscreen,
    /** The wall lays its chrome over the video instead of beside it. */
    immersive,
    /** Whether the chrome is on screen. Always, outside immersive mode. */
    chromeShown: !immersive || awake,
    enter,
    exit,
    toggle,
    holdProps,
  };
}

export default useImmersive;
