"use client";

// The other monitors of this station, as the live wall's Screens menu sees them
// (SCRUM-336) — the desktop shell's screens, or the browser's, behind one shape.
// See liveScreens.ts for the whole picture.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { isLiveAssignment, isWallAssignment, useScreens, type ScreenSlot } from "@/lib/desktop";

import {
  browserScreens,
  forgetScreen,
  openScreenWindow,
  readScreenDetails,
  rememberScreen,
  savedScreens,
  screenAccess,
  watchScreens,
  type BrowserScreen,
  type SavedScreen,
  type ScreenAccess,
  type ScreenDetails,
} from "../liveScreens";

/** One monitor in the menu. */
export interface LiveScreenRow {
  /** The desktop shell's display signature, or a browser screen's key. */
  id: string;
  label: string;
  /** Its resolution, when it is attached. */
  detail: string;
  primary: boolean;
  /** The console itself is on it, so it is not offered a live view. */
  console: boolean;
  /** A live view is up on it right now. */
  live: boolean;
  /** Saved, but its monitor is not there. */
  detached: boolean;
  /** What else it is doing, in words — a video wall monitor. */
  note: string | null;
}

/** How this console reaches the other monitors. "window": a browser without the
 *  Window Management API, so a live view opens in a new window to be moved. */
export type ScreensMode = "desktop" | "browser" | "window";

function desktopNote(s: ScreenSlot): string | null {
  if (isWallAssignment(s.assignment)) return `Video wall · ${s.assignment.monitorLabel}`;
  if (isLiveAssignment(s.assignment) && !s.open) return "Saved — not open";
  return null;
}

function desktopRows(slots: ScreenSlot[]): LiveScreenRow[] {
  return slots
    .filter((s) => s.attached || isLiveAssignment(s.assignment))
    .map((s) => ({
      id: s.signature,
      label: s.label,
      detail: s.resolution,
      primary: s.primary,
      console: s.console,
      live: s.open && isLiveAssignment(s.assignment),
      detached: !s.attached,
      note: desktopNote(s),
    }));
}

function browserRows(screens: BrowserScreen[], saved: SavedScreen[], open: ReadonlySet<string>): LiveScreenRow[] {
  const rows: LiveScreenRow[] = screens.map((s) => ({
    id: s.key,
    label: s.label,
    detail: s.resolution,
    primary: s.primary,
    console: s.current,
    live: open.has(s.key),
    detached: false,
    note: null,
  }));
  for (const s of saved) {
    if (rows.some((r) => r.id === s.key)) continue;
    // A screen this browser opened that is not among the monitors now — or, with
    // no monitor list at all, every window it opened.
    rows.push({
      id: s.key,
      label: s.label,
      detail: "",
      primary: false,
      console: false,
      live: open.has(s.key),
      detached: screens.length > 0 && !open.has(s.key),
      note: null,
    });
  }
  return rows;
}

export function useLiveScreens() {
  const desktop = useScreens();

  // ── browser ───────────────────────────────────────────────────────────────
  const [access, setAccess] = useState<ScreenAccess>("unsupported");
  const [details, setDetails] = useState<ScreenDetails | null>(null);
  // ScreenDetails is live: the same object, its screens changed under it.
  const [rearranged, setRearranged] = useState(0);
  // Read at mount: it is this browser's own record, and nothing renders it until
  // the menu is opened, so the server render (empty) cannot disagree on screen.
  const [saved, setSaved] = useState<SavedScreen[]>(() => (typeof window === "undefined" ? [] : savedScreens()));
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const presence = useRef<ReturnType<typeof watchScreens> | null>(null);

  useEffect(() => {
    if (desktop.available) return undefined;
    presence.current = watchScreens(setOpen);
    let alive = true;
    void screenAccess().then(async (state) => {
      if (!alive) return;
      setAccess(state);
      // Already allowed: list them now, no prompt involved.
      if (state === "granted") {
        const d = await readScreenDetails();
        if (alive) setDetails(d);
      }
    });
    return () => {
      alive = false;
      presence.current?.stop();
      presence.current = null;
    };
  }, [desktop.available]);

  // A monitor plugged in or out while the menu is up.
  useEffect(() => {
    if (!details) return undefined;
    const changed = () => setRearranged((n) => n + 1);
    details.addEventListener("screenschange", changed);
    return () => details.removeEventListener("screenschange", changed);
  }, [details]);

  /** Ask for the monitor list — the browser's permission prompt. */
  const findScreens = useCallback(async () => {
    const d = await readScreenDetails();
    setDetails(d);
    setAccess(await screenAccess());
  }, []);

  let mode: ScreensMode = "window";
  if (desktop.available) mode = "desktop";
  else if (access !== "unsupported") mode = "browser";

  const screens = useMemo(
    () => (details ? browserScreens(details) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `rearranged` is the re-read
    [details, rearranged],
  );

  const rows = useMemo<LiveScreenRow[]>(() => {
    if (desktop.available) return desktopRows(desktop.screens);
    return browserRows(screens, saved, open);
  }, [desktop.available, desktop.screens, screens, saved, open]);

  const openLive = useCallback(
    (row: LiveScreenRow) => {
      if (desktop.available) {
        void desktop.openLive(row.id);
        return;
      }
      const screen: SavedScreen = screens.find((s) => s.key === row.id) ??
        saved.find((s) => s.key === row.id) ?? { key: row.id, label: row.label };
      rememberScreen({ key: screen.key, label: screen.label, left: screen.left, top: screen.top, width: screen.width, height: screen.height });
      setSaved(savedScreens());
      openScreenWindow(screen);
    },
    [desktop, screens, saved],
  );

  const closeLive = useCallback(
    (row: LiveScreenRow) => {
      if (desktop.available) {
        void desktop.clear(row.id);
        return;
      }
      presence.current?.close(row.id);
      forgetScreen(row.id);
      setSaved(savedScreens());
    },
    [desktop],
  );

  /** No monitor list to pick from: a live view in a window of its own. */
  const openWindow = useCallback(() => {
    const taken = new Set(savedScreens().map((s) => s.key));
    let n = 1;
    while (taken.has(`w${n}`)) n += 1;
    const screen: SavedScreen = { key: `w${n}`, label: `Window ${n}` };
    rememberScreen(screen);
    setSaved(savedScreens());
    openScreenWindow(screen);
  }, []);

  return {
    mode,
    /** The browser's answer on listing monitors — "prompt" until asked. */
    access,
    rows,
    busy: desktop.busy,
    liveCount: rows.filter((r) => r.live).length,
    findScreens,
    openLive,
    closeLive,
    openWindow,
    identify: desktop.available ? desktop.identify : null,
  };
}

export default useLiveScreens;
