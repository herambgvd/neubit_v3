import { app, Menu, Tray, nativeImage, shell } from "electron";
import { existsSync } from "node:fs";
import iconPath from "../../build/tray-icon.png?asset";
import { activeServerUrl, getConfig, setKiosk } from "./config";
import { autoStartEnabled, isAutoStartSupported, setAutoStartEnabled } from "./autostart";
import { beginQuit, setTrayActive } from "./lifecycle";
import { log } from "./logger";
import { probe } from "./server";
import { applyKiosk, openWallSignatures, showMainWindow } from "./window";
import { closeAllWalls, identifyScreens } from "./screens";
import { chooseExportFolder, clearExportFolder, exportPrefs, openExportFolder } from "./exports";
import type { ServerStatus } from "@shared/ipc";

// The tray icon.
//
// ══ WHY AN OPERATOR CONSOLE WANTS ONE ════════════════════════════════════════
//
// The console is the thing an operator has open all shift and closes when they
// step away — and closing it must not be the same gesture as leaving the product.
// So the app is resident: the window closes, the icon stays, and the icon carries
// the one fact somebody glancing at the machine wants, which is whether the server
// it is pointed at is answering.
//
// QUITTING FROM HERE DOES NOT STOP THE VMS, and the menu says so in as many words.
// On an appliance install the server is a Windows Service with automatic start; it
// runs before any login and survives every item in this menu. Leaving that implicit
// would be the expensive kind of ambiguity — somebody quits the tray app to "turn
// the system off", walks away, and it records for another month.

let tray: Tray | null = null;
let pollTimer: NodeJS.Timeout | null = null;
let lastStatus: ServerStatus | null = null;

/** How often the tray re-reads the server. Slow on purpose: this runs for the
 *  whole life of the session, and /health is cheap but not free. */
const POLL_MS = 30_000;

/** The tray image.
 *
 *  build/tray-icon.png rather than build/icon.png only because of SIZE: it is a
 *  512px render, so downsampling to the 16px below starts from something close to
 *  the target instead of throwing away a 1024px original. Both come out of
 *  build/make-icons.py in one pass from one definition, so they cannot drift.
 *
 *  electron-vite's ?asset emits the PNG next to the main bundle and rewrites this
 *  import to its runtime path, so it resolves identically in a dev run and inside
 *  the packaged app. */
function trayImage(): Electron.NativeImage {
  if (!existsSync(iconPath)) {
    log.warn("tray icon missing at", iconPath, "- the tray will show a blank slot");
    return nativeImage.createEmpty();
  }
  return nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
}

/** One line summarising the server, for the menu header and the tooltip. */
function summarise(status: ServerStatus | null): string {
  if (!activeServerUrl() && !status) return "No server selected";
  if (!status) return "Server: checking...";
  if (status.reachable) {
    const host = hostOf(status.url);
    return status.latencyMs !== undefined
      ? `Server: ${host} (${status.latencyMs} ms)`
      : `Server: ${host}`;
  }
  // The reason, not just the word. "Not responding" is true of a server whose
  // gateway is up and whose database is gone, and the difference is exactly what
  // this line exists to make visible from the corner of a screen.
  return `Server: NOT RESPONDING — ${status.reason ?? "unknown"}`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function buildMenu(): Menu {
  const cfg = getConfig();
  const active = activeServerUrl();
  const autoSupported = isAutoStartSupported();

  const template: Electron.MenuItemConstructorOptions[] = [
    { label: summarise(lastStatus), enabled: false },
    { type: "separator" },
    { label: "Open console", click: () => void showMainWindow() },
  ];

  if (active) {
    template.push({
      label: "Open console in browser",
      click: () => void shell.openExternal(active),
    });
  }

  template.push(
    { type: "separator" },
    {
      label: "Full screen (kiosk)",
      type: "checkbox",
      checked: cfg.kiosk,
      click: (item) => {
        setKiosk(item.checked);
        applyKiosk(item.checked);
      },
    },
    {
      label: autoSupported
        ? "Start when I sign in"
        : "Start when I sign in (unavailable in this build)",
      type: "checkbox",
      enabled: autoSupported,
      checked: autoStartEnabled(),
      click: (item) => {
        // Rendered from what the OS reports afterwards, not from what was asked
        // for: Windows can refuse or later revoke a startup entry, and a tick that
        // disagrees with Settings is worse than no tick at all.
        item.checked = setAutoStartEnabled(item.checked);
      },
    },
    { type: "separator" },
    ...screensSection(),
    { type: "separator" },
    ...exportsSection(),
    { type: "separator" },
    {
      // Named for what it leaves behind, not only for what it closes.
      label: "Quit console (the server keeps running)",
      click: () => {
        beginQuit();
        app.quit();
      },
    },
  );

  return Menu.buildFromTemplate(template);
}

/** The wall panels.
 *
 *  Assignment is NOT here and cannot be: choosing which wall monitor goes on which
 *  screen needs the wall list, which is behind the authed API, and the shell does
 *  not hold a session. That belongs in the console. What lives here is the pair of
 *  things a shell CAN answer on its own, and that somebody wants when the console
 *  window is not the thing in front of them.
 *
 *  "Close" rather than "clear", deliberately: the assignments survive, so the
 *  panels come back on the next launch. An engineer who needs the screens for half
 *  an hour is not asking to rebuild the layout afterwards. */
function screensSection(): Electron.MenuItemConstructorOptions[] {
  const openCount = openWallSignatures().length;
  return [
    { label: "Identify screens", click: () => identifyScreens() },
    {
      label:
        openCount === 0
          ? "No wall panels open"
          : `Close ${openCount} wall panel${openCount === 1 ? "" : "s"} (layout kept)`,
      enabled: openCount > 0,
      click: () => {
        void closeAllWalls().then(() => applyMenu());
      },
    },
  ];
}

/** Where exports go.
 *
 *  A shell preference, so it belongs to the shell rather than to the console: the
 *  console runs in a browser too, where it has no say in the matter at all. */
function exportsSection(): Electron.MenuItemConstructorOptions[] {
  const { folder } = exportPrefs();
  const items: Electron.MenuItemConstructorOptions[] = [
    {
      label: folder ? `Exports -> ${folder}` : "Exports: ask every time",
      enabled: false,
    },
    {
      label: folder ? "Change the export folder..." : "Save exports to a folder...",
      click: () => {
        void chooseExportFolder().then(() => applyMenu());
      },
    },
  ];
  if (folder) {
    items.push(
      { label: "Open the export folder", click: () => void openExportFolder() },
      {
        label: "Ask every time instead",
        click: () => {
          clearExportFolder();
          applyMenu();
        },
      },
    );
  }
  return items;
}

function applyMenu(): void {
  if (!tray) return;
  tray.setContextMenu(buildMenu());
  tray.setToolTip(`Neubit VMS — ${summarise(lastStatus)}`);
}

/** Re-read the server and rebuild the menu. Safe to call at any time. */
export async function refreshTray(): Promise<void> {
  if (!tray) return;
  const url = activeServerUrl();
  if (!url) {
    lastStatus = null;
    applyMenu();
    return;
  }
  try {
    lastStatus = await probe(url);
  } catch (e) {
    log.warn("tray status read failed:", (e as Error).message);
    lastStatus = null;
  }
  applyMenu();
}

/** Rebuild the menu from what is already known, without a round-trip. Used when a
 *  preference changed elsewhere and the tick marks would otherwise disagree with
 *  the app. */
export function syncTrayPrefs(): void {
  applyMenu();
}

export function initTray(): void {
  if (tray) return;
  try {
    tray = new Tray(trayImage());
  } catch (e) {
    // A desktop session with no system tray (some minimal Linux setups) is not a
    // reason to fail to start. The app keeps the old close-quits behaviour, and
    // isTrayActive() reports that honestly to the window and to the UI.
    log.warn("no system tray available:", (e as Error).message);
    return;
  }

  setTrayActive(true);
  applyMenu();

  // Windows convention: a plain click opens the app, right-click opens the menu
  // (Electron wires the context menu itself). Without this, an operator who closed
  // the window has an icon that only ever answers with a menu.
  tray.on("click", () => void showMainWindow());
  tray.on("double-click", () => void showMainWindow());

  void refreshTray();
  pollTimer = setInterval(() => void refreshTray(), POLL_MS);
  log.info("tray icon installed");
}

export function destroyTray(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (tray) {
    tray.destroy();
    tray = null;
  }
  setTrayActive(false);
}
