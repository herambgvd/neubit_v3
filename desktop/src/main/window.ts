import { BrowserWindow, nativeImage } from "electron";
import { existsSync } from "node:fs";
import { join } from "node:path";
import iconPath from "../../build/icon.png?asset";
import { consoleEntryUrl } from "@shared/ipc";
import { hardenContents, isAllowedConsoleUrl } from "./security";
import { activeServerUrl, getConfig } from "./config";
import { LOCAL_CONSOLE_URL, probeLocal } from "./server";
import { isQuitting, isTrayActive } from "./lifecycle";
import { log } from "./logger";

// Window factory.
//
// In P1 there is one window: the MAIN window, which loads the active console URL
// or the local launcher (the server picker) when none is configured. P3 adds
// full-screen wall windows on the other monitors; they will use the same hardened
// webPreferences, which is why those live in a function rather than a literal.

const PRELOAD = join(__dirname, "../preload/index.js");

/** The window icon: the taskbar button, Alt-Tab, and the title bar.
 *
 *  == WHY THIS IS SET AT ALL ==================================================
 *
 *  A PACKAGED app takes its taskbar icon from the exe, which electron-builder
 *  stamps from build/icon.ico. A DEV RUN has no such exe -- it is Electron's own
 *  binary -- so without this the window wears the default Electron atom, which is
 *  what "the app is showing the wrong icon" almost always turns out to be.
 *
 *  Setting it explicitly costs nothing in a packaged build and removes the
 *  difference between the two, so what a developer sees is what ships.
 *
 *  icon.png (1024) rather than the .ico: same master, and Electron downsamples a
 *  PNG for every size it needs on all three platforms. The ?asset import is
 *  electron-vite's -- it emits the file next to the main bundle and rewrites this
 *  to its runtime path, so it resolves identically in dev and inside the asar. */
let cachedIcon: Electron.NativeImage | null | undefined;

function windowIcon(): Electron.NativeImage | undefined {
  if (cachedIcon === undefined) {
    if (!existsSync(iconPath)) {
      // Not fatal, and not silent: the app is perfectly usable wearing the wrong
      // icon, and a release that ships without one should leave a line saying so.
      log.warn("window icon missing at", iconPath, "- falling back to Electron's");
      cachedIcon = null;
    } else {
      cachedIcon = nativeImage.createFromPath(iconPath);
    }
  }
  return cachedIcon ?? undefined;
}

// The bundled launcher: the electron-vite dev server in dev, file:// in a build.
const RENDERER_DEV_URL = process.env.ELECTRON_RENDERER_URL;
const RENDERER_FILE = join(__dirname, "../renderer/index.html");

function baseWebPreferences(): Electron.WebPreferences {
  return {
    preload: PRELOAD,
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    webviewTag: false,
    // Hardware-accelerated video decode in the webview (H.264, and HEVC where the
    // OS codec supports it) — the desktop win over Chrome-in-a-browser. The dense
    // HEVC wall is P3's native addon, not this webview.
    backgroundThrottling: false,
  };
}

function loadEntry(win: BrowserWindow, remoteUrl: string | null): void {
  if (remoteUrl) {
    void win.loadURL(remoteUrl);
    return;
  }
  if (RENDERER_DEV_URL) {
    void win.loadURL(RENDERER_DEV_URL);
  } else {
    void win.loadFile(RENDERER_FILE);
  }
}

/** Decide what the main window opens on.
 *
 *  Order matters, and it encodes the product shape:
 *
 *   1. A console the operator explicitly chose wins. Someone who pointed this app
 *      at a particular server meant it, even on a box that runs its own.
 *   2. Otherwise this machine's own server, if it has one. That is the home case
 *      after an appliance install: the VMS is right here on the gateway, so the
 *      shell goes straight in — no picker, no URL to type, nothing for the
 *      operator to know.
 *   3. Otherwise the launcher, so a workstation install can be pointed at a server
 *      on the network.
 *
 *  The local probe is a loopback request with a short timeout, so case 3 on a
 *  machine with no server costs a moment rather than a hang.
 *
 *  The answer is a console ENTRY url, not a bare origin — see consoleEntryUrl. */
export async function resolveStartUrl(): Promise<string | null> {
  const origin = await resolveConsoleOrigin();
  return origin ? consoleEntryUrl(origin) : null;
}

/** The same answer as an ORIGIN, without the console entry path.
 *
 *  Wall windows need this: they open /wall-display/<wall>/<monitor>, not /login,
 *  so they cannot use resolveStartUrl. Both go through here so a wall window and
 *  the console can never end up on different servers. */
export async function resolveConsoleOrigin(): Promise<string | null> {
  const chosen = activeServerUrl();
  if (chosen) return chosen;

  const status = await probeLocal();
  if (status.reachable) return LOCAL_CONSOLE_URL;

  return null;
}

/** The one main window, kept so the tray can bring it back rather than opening a
 *  second copy of the console. */
let mainWindow: BrowserWindow | null = null;

export function getMainWindow(): BrowserWindow | null {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
}

/** `hidden` is used by a launch-at-login start, which must not throw a
 *  full-screen console at somebody who is still signing in to Windows. */
export async function createMainWindow(opts: { hidden?: boolean } = {}): Promise<BrowserWindow> {
  const existing = getMainWindow();
  if (existing) return existing;

  const cfg = getConfig();
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    icon: windowIcon(),
    // Matches the console's own dark ground, so the frame does not flash white
    // between the window appearing and the first paint.
    backgroundColor: "#0b1219",
    autoHideMenuBar: true,
    kiosk: cfg.kiosk,
    webPreferences: baseWebPreferences(),
  });
  mainWindow = win;

  hardenContents(win.webContents);
  win.once("ready-to-show", () => {
    if (!opts.hidden) win.show();
  });

  // ── CLOSE HIDES, IT DOES NOT QUIT ─────────────────────────────────────────
  //
  // With a tray icon up, the window's X behaves the way a resident background
  // application behaves everywhere else: the window goes away, the app stays.
  // Without one there is nothing left to click, so closing genuinely quits, and
  // intercepting it would trap the operator in an app they cannot leave.
  win.on("close", (e) => {
    if (isQuitting() || !isTrayActive()) return;
    e.preventDefault();
    win.hide();
  });

  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });

  const url = await resolveStartUrl();
  log.info(url ? `main window -> console ${url}` : "main window -> local launcher");
  loadEntry(win, url);
  return win;
}

/** Bring the console up: restore it from the tray, un-minimise it, or build it
 *  again if the last one was genuinely destroyed. */
export async function showMainWindow(): Promise<void> {
  const win = getMainWindow();
  if (!win) {
    await createMainWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/** Point the main window at a console. Refuses anything the guards would refuse
 *  anyway, so a bad URL fails here with a log line rather than as a silently
 *  blocked navigation the operator sees as a blank window. */
export async function loadConsole(origin: string): Promise<void> {
  const url = consoleEntryUrl(origin);
  if (!isAllowedConsoleUrl(url)) {
    log.warn("refused to load a console outside the allow-list:", url);
    return;
  }
  const win = await createMainWindow();
  await win.loadURL(url);
  win.show();
  win.focus();
  log.info("console loaded:", url);
}

/** Send the main window back to the launcher — used when the active server is
 *  removed, so the window does not sit on a console that is no longer configured. */
export async function showLauncher(): Promise<void> {
  const win = await createMainWindow();
  loadEntry(win, null);
  win.show();
}

/** Turn kiosk on or off on the live window as well as persisting it.
 *
 *  Applied immediately rather than "on next launch": a station that has just been
 *  set to kiosk is usually being set up by somebody standing in front of it, and a
 *  setting that needs a restart to observe is a setting people get wrong twice. */
export function applyKiosk(on: boolean): void {
  const win = getMainWindow();
  if (!win) return;
  win.setKiosk(on);
  win.setMenuBarVisibility(!on);
  if (on && !win.isVisible()) win.show();
  log.info(`kiosk ${on ? "on" : "off"}`);
}

// ═══════════════════════════════════════════════════════════════════════════
//  Wall windows — P3
// ═══════════════════════════════════════════════════════════════════════════
//
// One full-screen, chromeless window per physical screen that has been given a
// wall monitor. Owned by screens.ts, which decides WHICH monitor goes WHERE; this
// file only knows how to put a window on a display and take it away again.

const wallWindows = new Map<string, BrowserWindow>();

/** Signatures of the screens that actually have a wall window up right now. */
export function openWallSignatures(): string[] {
  return [...wallWindows.entries()]
    .filter(([, w]) => !w.isDestroyed())
    .map(([sig]) => sig);
}

/** Open (or move) the wall window for one screen.
 *
 *  ══ WHY THE BOUNDS COME FIRST AND FULL SCREEN COMES AFTER ═══════════════════
 *
 *  `new BrowserWindow({ fullscreen: true })` goes full screen on the PRIMARY
 *  display, whatever x/y it was given — which on a two-screen station means the
 *  wall lands on top of the console and the second monitor stays empty. The order
 *  that works is: create the window at the target display's bounds so the OS has
 *  already decided which monitor owns it, let it appear, and only then ask for
 *  full screen, which the OS then applies to the monitor the window is on.
 *
 *  Full screen rather than a frameless window merely sized to the display,
 *  because the difference is the taskbar: a chromeless window covering a 1080p
 *  panel still leaves the taskbar over the bottom row of cameras. */
export function openWallOn(
  signature: string,
  bounds: Electron.Rectangle,
  url: string,
  label: string,
): BrowserWindow {
  const existing = wallWindows.get(signature);
  if (existing && !existing.isDestroyed()) {
    // Same screen, new assignment: reuse the window rather than closing and
    // reopening it, which flashes the desktop behind it on a wall people watch.
    if (existing.isFullScreen()) existing.setFullScreen(false);
    existing.setBounds(bounds);
    void existing.loadURL(url).then(() => existing.setFullScreen(true));
    log.info(`wall window on ${signature} -> ${url}`);
    return existing;
  }

  const win = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    show: false,
    frame: false,
    // Pure black, not the console's #0b1219: this is a wall of video and any
    // ground that is not black shows as a seam between cells.
    backgroundColor: "#000000",
    autoHideMenuBar: true,
    icon: windowIcon(),
    title: `Neubit wall — ${label}`,
    // ══ THE SAME SESSION, DELIBERATELY ══════════════════════════════════════
    //
    // No `partition` here. The wall window loads the same origin as the console,
    // in the default session, so it shares the console's localStorage — where the
    // console keeps its JWT under `vizor.access`. That is the whole reason the
    // shell can open a signed-in wall without ever touching a token.
    //
    // Give this window its own partition and every wall screen comes up on the
    // sign-in form instead, with nobody at the panel to type a password.
    webPreferences: baseWebPreferences(),
  });

  wallWindows.set(signature, win);
  hardenContents(win.webContents);

  // ── A WAY OUT ─────────────────────────────────────────────────────────────
  //
  // A frameless full-screen window with no menu bar has no close button, and an
  // engineer standing at a wall panel with no keyboard shortcut has to kill the
  // process. Escape closes the window; the assignment is untouched, so it comes
  // back on the next launch or from the panel.
  win.webContents.on("before-input-event", (_event, input) => {
    if (input.type === "keyDown" && input.key === "Escape") {
      log.info(`wall window on ${signature} closed with Escape`);
      win.close();
    }
  });

  win.once("ready-to-show", () => {
    win.show();
    win.setFullScreen(true);
  });

  win.on("closed", () => {
    if (wallWindows.get(signature) === win) wallWindows.delete(signature);
  });

  void win.loadURL(url);
  log.info(`wall window opened on ${signature} (${label}) -> ${url}`);
  return win;
}

export function closeWallOn(signature: string): void {
  const win = wallWindows.get(signature);
  wallWindows.delete(signature);
  if (win && !win.isDestroyed()) win.close();
}

export function closeAllWallWindows(): void {
  for (const sig of [...wallWindows.keys()]) closeWallOn(sig);
}
