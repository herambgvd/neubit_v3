"use client";

// LIVE SCREENS — the other monitors of an operator's station, each with a live
// view of its own (SCRUM-336).
//
// A control-room desk has two to six monitors, each watching different cameras.
// Every VMS client does this for itself rather than leaving the operator to drag
// browser tabs about: Milestone sends a view to a secondary display, Genetec runs
// a task per monitor, Nx opens a layout in a new window, HikCentral has auxiliary
// screens. All of them keep those windows LOCAL to the workstation, separate from
// the shared video wall, and put them back at the next sign-in.
//
// One page serves every route there: /live-display/<key>, the full live wall,
// immersive, its grid kept under <key> (Streaming → wallStore). What differs is
// who opens it:
//
//   * the DESKTOP APP puts it on its monitor itself — full screen, frameless,
//     reopened at launch, closed when the panel is unplugged and back when it
//     returns (desktop/src/main/screens.ts). The console names a screen; the shell
//     derives the key and builds the URL.
//   * a BROWSER does it with the Window Management API (Chrome, Edge — and only on
//     a secure origin): it lists the monitors and opens a window placed on one.
//     Without it, a plain new window the operator moves.
//
// The browser cannot reopen anything by itself, so it remembers which screens it
// had (savedScreens) and offers them back.

export const LIVE_DISPLAY_PATH = "/live-display";

const SCREEN_KEY = /^[A-Za-z0-9_-]{1,64}$/;

/** A key safe to put in a path and a storage key. */
export function isScreenKey(value: unknown): value is string {
  return typeof value === "string" && SCREEN_KEY.test(value);
}

/** Where a live screen's window goes. The label is shown as text on its toolbar. */
export function liveDisplayPath(key: string, label: string): string {
  return `${LIVE_DISPLAY_PATH}/${encodeURIComponent(key)}?name=${encodeURIComponent(label)}`;
}

/** A short stable key from a description of a screen. FNV-1a, the same hash the
 *  desktop shell keys its screens with; the prefix keeps a browser's keys apart
 *  from the shell's. */
export function screenKey(prefix: string, text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.codePointAt(i) ?? 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${prefix}${h.toString(16).padStart(8, "0")}`;
}

// ── the browser's own record ────────────────────────────────────────────────

/** A live screen this browser opened, with where it went. */
export interface SavedScreen {
  key: string;
  label: string;
  left?: number;
  top?: number;
  width?: number;
  height?: number;
}

const LS_SCREENS = "neubit.vms.screens";

export function savedScreens(): SavedScreen[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(LS_SCREENS) || "[]");
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (s): s is SavedScreen => !!s && isScreenKey((s as SavedScreen).key) && typeof (s as SavedScreen).label === "string",
    );
  } catch {
    return [];
  }
}

function writeSaved(list: SavedScreen[]): void {
  try {
    localStorage.setItem(LS_SCREENS, JSON.stringify(list));
  } catch {
    /* quota / private mode — the window still opens */
  }
}

export function rememberScreen(screen: SavedScreen): void {
  writeSaved([...savedScreens().filter((s) => s.key !== screen.key), screen]);
}

export function forgetScreen(key: string): void {
  writeSaved(savedScreens().filter((s) => s.key !== key));
}

// ── the Window Management API ───────────────────────────────────────────────
//
// Not in lib.dom yet; declared here to the extent it is used.

interface ScreenDetailed {
  availLeft: number;
  availTop: number;
  availWidth: number;
  availHeight: number;
  width: number;
  height: number;
  left: number;
  top: number;
  isPrimary: boolean;
  label: string;
}

export interface ScreenDetails extends EventTarget {
  readonly screens: readonly ScreenDetailed[];
  readonly currentScreen: ScreenDetailed;
}

type WindowWithScreens = Window & { getScreenDetails?: () => Promise<ScreenDetails> };

/** The browser can list monitors and place a window on one. */
export function windowManagementSupported(): boolean {
  return typeof window !== "undefined" && typeof (window as WindowWithScreens).getScreenDetails === "function";
}

export type ScreenAccess = PermissionState | "unsupported";

/** Whether this site may list the monitors, without asking. */
export async function screenAccess(): Promise<ScreenAccess> {
  if (!windowManagementSupported()) return "unsupported";
  // The permission was renamed; Chrome answers to either, older builds only the
  // first. A browser that knows neither has not decided yet, as far as we can tell.
  for (const name of ["window-management", "window-placement"]) {
    try {
      const status = await navigator.permissions.query({ name: name as PermissionName });
      return status.state;
    } catch {
      /* not this name */
    }
  }
  return "prompt";
}

/** The monitors, asking the operator for access if the site has not got it yet.
 *  Null when refused. */
export async function readScreenDetails(): Promise<ScreenDetails | null> {
  const get = (window as WindowWithScreens).getScreenDetails;
  if (!get) return null;
  try {
    return await get.call(window);
  } catch {
    return null;
  }
}

/** One monitor as the Screens menu shows it. */
export interface BrowserScreen extends Required<SavedScreen> {
  primary: boolean;
  /** This window is on it. */
  current: boolean;
  resolution: string;
}

export function browserScreens(details: ScreenDetails): BrowserScreen[] {
  return details.screens.map((s, i) => {
    const label = s.label?.trim() || `Screen ${i + 1}`;
    return {
      // Name and position: two identical panels sit in different places.
      key: screenKey("b", `${label}|${s.left},${s.top}|${s.width}x${s.height}`),
      label,
      primary: s.isPrimary,
      current: s === details.currentScreen,
      resolution: `${s.width} × ${s.height}`,
      left: s.availLeft,
      top: s.availTop,
      width: s.availWidth,
      height: s.availHeight,
    };
  });
}

/** Open the live window for a screen — or bring it forward: it is named after its
 *  key, so a second click finds the window already there instead of a second one. */
export function openScreenWindow(screen: SavedScreen): Window | null {
  const placed =
    screen.width && screen.height
      ? `left=${screen.left ?? 0},top=${screen.top ?? 0},width=${screen.width},height=${screen.height}`
      : "width=1280,height=800";
  const win = window.open(liveDisplayPath(screen.key, screen.label), `neubit-screen-${screen.key}`, `popup,${placed}`);
  win?.focus();
  return win;
}

// ── which screens are open ──────────────────────────────────────────────────
//
// The windows tell each other over a BroadcastChannel. A Window handle would do
// for the session that opened it and for nothing after a reload of the console,
// which is exactly when the operator wants to see what is still up.

const CHANNEL = "neubit.vms.screens";

type ScreenMessage =
  | { type: "open"; key: string }
  | { type: "closed"; key: string }
  | { type: "who" }
  | { type: "close"; key: string };

function channel(): BroadcastChannel | null {
  return typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(CHANNEL);
}

/** From a live screen's window: say it is up, answer roll-calls, and close when
 *  the console asks. Returns the cleanup. */
export function announceScreen(key: string, onCloseRequest: () => void): () => void {
  const ch = channel();
  if (!ch) return () => undefined;
  const here = () => ch.postMessage({ type: "open", key } satisfies ScreenMessage);
  ch.onmessage = (e: MessageEvent<ScreenMessage>) => {
    if (e.data?.type === "who") here();
    if (e.data?.type === "close" && e.data.key === key) onCloseRequest();
  };
  const bye = () => ch.postMessage({ type: "closed", key } satisfies ScreenMessage);
  window.addEventListener("pagehide", bye);
  here();
  return () => {
    window.removeEventListener("pagehide", bye);
    bye();
    ch.close();
  };
}

/** From the console: follow which live screens are up. */
export function watchScreens(onChange: (open: ReadonlySet<string>) => void) {
  const ch = channel();
  const open = new Set<string>();
  if (ch) {
    ch.onmessage = (e: MessageEvent<ScreenMessage>) => {
      const m = e.data;
      if (m?.type === "open" && !open.has(m.key)) open.add(m.key);
      else if (m?.type === "closed" && open.has(m.key)) open.delete(m.key);
      else return;
      onChange(new Set(open));
    };
    ch.postMessage({ type: "who" } satisfies ScreenMessage);
  }
  return {
    /** Ask a screen's window to close itself. */
    close: (key: string) => ch?.postMessage({ type: "close", key } satisfies ScreenMessage),
    stop: () => ch?.close(),
  };
}
