"use client";

// The desktop shell bridge — everything the console can do when it is running
// inside the Neubit VMS desktop app rather than in a browser tab.
//
// ══ THE RULE THIS FILE EXISTS TO ENFORCE ═════════════════════════════════════
//
// THERE IS ONE CONSOLE. The same build serves a browser on the LAN and the
// desktop shell on an operator's workstation — `lib/api.js` resolves its API base
// from window.location precisely so that one artifact runs anywhere. Nothing here
// may break that. So every capability below is ADDITIVE and behind a check: in a
// browser `window.neubit` is undefined, `available` is false, and the UI that
// depends on it is simply not rendered. No feature flag, no second build, no
// "desktop version" of a page to keep in step.
//
// If you find yourself wanting to CHANGE existing behaviour based on `available`,
// stop — that is the beginning of two consoles that drift.
//
// The bridge is defined in desktop/src/shared/ipc.ts and exposed by
// desktop/src/preload/index.ts over a contextIsolation bridge. It carries no
// session: the token in localStorage under `vizor.access` is the console's, and
// the shell never reads it. See the note at the top of that file.
import { useCallback, useEffect, useState } from "react";

/** The bridge, or null in a browser.
 *
 *  Guarded on `typeof window` because Next prerenders these pages on the server,
 *  where touching `window` at module scope is a build-time crash rather than a
 *  runtime one. */
export function desktopBridge() {
  if (typeof window === "undefined") return null;
  return window.neubit ?? null;
}

/** Whether the console is running inside the desktop shell.
 *
 *  As a HOOK rather than a bare boolean, because it must be false on the server
 *  render and true after hydration. Read directly during render and React reports
 *  a hydration mismatch: the server produced markup without the desktop controls
 *  and the client produced markup with them. */
export function useIsDesktop() {
  const [isDesktop, setIsDesktop] = useState(false);
  useEffect(() => setIsDesktop(desktopBridge() !== null), []);
  return isDesktop;
}

/** The screens on this workstation and what each is showing.
 *
 *  `layout.screens[].assignment` is the shell's own record of which wall monitor
 *  it put where — it is not read back from the server, because it is a fact about
 *  this desk and no other client's business. */
export function useScreens() {
  const [layout, setLayout] = useState(null);
  const [busy, setBusy] = useState(false);

  const available = useIsDesktop();

  const refresh = useCallback(async () => {
    const bridge = desktopBridge();
    if (!bridge) return;
    setLayout(await bridge.screensLayout());
  }, []);

  useEffect(() => {
    const bridge = desktopBridge();
    if (!bridge) return undefined;
    let alive = true;
    bridge.screensLayout().then((l) => alive && setLayout(l));
    // The shell pushes a new layout when a monitor is plugged in, unplugged or
    // rearranged. The unsubscribe matters: this hook lives in a component that
    // mounts and unmounts with the wall page.
    const off = bridge.onScreensChanged((l) => alive && setLayout(l));
    return () => {
      alive = false;
      off();
    };
  }, []);

  // Every mutation returns the NEW layout, so the state that lands is what the
  // shell actually did rather than what was asked for — a screen that was
  // unplugged between the click and the call reports back as detached instead of
  // showing as assigned to a monitor that is not there.
  const run = useCallback(async (fn) => {
    setBusy(true);
    try {
      setLayout(await fn());
    } finally {
      setBusy(false);
    }
  }, []);

  const assign = useCallback(
    (signature, target) => {
      const bridge = desktopBridge();
      if (!bridge) return undefined;
      return run(() => bridge.assignScreen(signature, target));
    },
    [run],
  );

  const clear = useCallback(
    (signature) => {
      const bridge = desktopBridge();
      if (!bridge) return undefined;
      return run(() => bridge.clearScreen(signature));
    },
    [run],
  );

  const closeAll = useCallback(() => {
    const bridge = desktopBridge();
    if (!bridge) return undefined;
    return run(() => bridge.closeAllWalls());
  }, [run]);

  const identify = useCallback(() => {
    desktopBridge()?.identifyScreens();
  }, []);

  return {
    available,
    layout,
    screens: layout?.screens ?? [],
    busy,
    refresh,
    assign,
    clear,
    closeAll,
    identify,
  };
}
