import { app, Menu } from "electron";
import { initLogging, log } from "./logger";
import { installGlobalSecurity } from "./security";
import { registerIpc } from "./ipc";
import { createMainWindow, showLauncher, showMainWindow } from "./window";
import { initUpdater, checkForUpdates } from "./updater";
import { initTray, destroyTray } from "./tray";
import { launchedHidden } from "./autostart";
import { beginQuit, isTrayActive } from "./lifecycle";
import { initExports } from "./exports";
import { restoreWalls, watchDisplays } from "./screens";

// Main entry. Order matters: logging → single-instance lock → security → IPC →
// updater → tray → first window. The shell owns lifecycle only; the actual UI is
// the v3 console loaded over HTTP, or the local launcher when no server has been
// configured yet.
//
// The app is RESIDENT: it lives in the tray, the window is a view onto it, and
// closing the window does not end the process — see tray.ts. It is emphatically
// not the shape of the SERVER, which on an appliance install is a Windows Service
// and runs whether this app is here or not.

initLogging();

// Windows ties toast notifications to an Application User Model ID. Without one
// set explicitly, a notification is attributed to "electron.app.Electron" — or
// does not appear at all. Must match the appId in electron-builder.yml.
if (process.platform === "win32") app.setAppUserModelId("com.geniusvision.neubit.vms");

// One running instance only — a second launch focuses the existing window rather
// than spawning a duplicate operator client.
if (!app.requestSingleInstanceLock()) {
  log.info("second instance refused — focusing the running one");
  app.quit();
} else {
  // A second launch — from the desktop shortcut, or from the login entry racing a
  // session that already has the app — brings the existing window back, including
  // out of the tray where there is no window to focus.
  app.on("second-instance", () => void showMainWindow());

  app.whenReady().then(() => {
    installGlobalSecurity();
    registerIpc();
    // Before any window exists. will-download is a SESSION event, so a download
    // started by the first page load would otherwise arrive with no handler
    // attached and go to the browser default — the one place this feature exists
    // to stop it going.
    initExports();
    initUpdater();
    // Before the window: the window's close handler asks whether a tray exists,
    // and a window created first would briefly answer "no" and quit the app on a
    // close that arrived in that gap.
    initTray();
    // A launch at login comes up in the tray only. Somebody who has just typed
    // their Windows password is not asking for a full-screen console in their
    // face, and the icon is right there when they want it.
    void createMainWindow({ hidden: launchedHidden() });

    installApplicationMenu();

    // ── the wall panels ──────────────────────────────────────────────────────
    //
    // After the main window, deliberately. restoreWalls opens full-screen windows
    // on the other monitors; doing it first would stack them above the console
    // the operator is about to use, and on a single-screen box it would hide it
    // entirely behind a wall panel with no visible way back.
    //
    // Not awaited: a saved layout that cannot open yet (a server still booting on
    // this same machine) must not hold up the rest of startup. Everything inside
    // is best-effort and logs what it skipped.
    watchDisplays();
    void restoreWalls();

    // Kick a first update check shortly after boot (a no-op when unpackaged).
    setTimeout(() => void checkForUpdates(), 5_000);

    // macOS: re-open a window when the dock icon is clicked with none open.
    app.on("activate", () => void showMainWindow());
  });

  // Every window closed. With a tray icon up this is the NORMAL resting state of
  // the app, not the end of it — quitting here would undo the whole point of the
  // icon. With no tray there is nothing left to click, so the old behaviour is
  // still the right one.
  app.on("window-all-closed", () => {
    if (!isTrayActive()) app.quit();
  });

  // Anything that reaches before-quit — the menu's Quit, Windows shutting down, an
  // update installing — is a genuine exit, so the window must stop intercepting
  // its own close.
  app.on("before-quit", () => beginQuit());
  app.on("will-quit", () => destroyTray());
}

/** The application menu. Deliberately minimal: the console supplies its own
 *  navigation, so the menu carries only what the SHELL owns — a way back to the
 *  server picker, a reload for a console that got stuck, and the standard quit. */
function installApplicationMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: "Neubit",
      submenu: [
        {
          label: "Choose server...",
          accelerator: "CommandOrControl+Shift+S",
          click: () => void showLauncher(),
        },
        { type: "separator" },
        { role: "reload" },
        { role: "forceReload" },
        { type: "separator" },
        // Spelled out rather than left as the bare role. On a box that also runs
        // the server, "Quit" is a word people reasonably read as "stop the VMS",
        // and it is not.
        { label: "Quit console (the server keeps running)", role: "quit" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "togglefullscreen" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { role: "resetZoom" },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
