import { app, ipcMain, shell } from "electron";
import {
  IPC,
  normaliseConsoleUrl,
  type AppConfig,
  type AppInfo,
  type ConsoleServer,
  type ExportPrefs,
  type ScreenLayout,
  type ServerStatus,
  type ShellPrefs,
  type WallTarget,
} from "@shared/ipc";
import {
  allowedOrigins,
  getConfig,
  removeServer,
  serverById,
  setActiveServer,
  setKiosk,
  upsertServer,
} from "./config";
import { autoStartEnabled, isAutoStartSupported, setAutoStartEnabled } from "./autostart";
import { isTrayActive } from "./lifecycle";
import { listDisplays } from "./displays";
import {
  assignScreen,
  clearScreen,
  closeAllWalls,
  identifyScreens,
  readLayout,
} from "./screens";
import {
  chooseExportFolder,
  clearExportFolder,
  exportPrefs,
  openExportFolder,
} from "./exports";
import { isNativeWallAvailable } from "../../native/loader";
import { log } from "./logger";
import { probe } from "./server";
import { checkForUpdates, installUpdate } from "./updater";
import { refreshTray, syncTrayPrefs } from "./tray";
import { applyKiosk, loadConsole, showLauncher } from "./window";

// Every handler the preload bridge can reach. One place, so the contract in
// shared/ipc.ts and what actually answers cannot drift.
//
// The renderer on the other side of these is the v3 console — a web app served
// over HTTP, which is to say untrusted. Nothing here takes a path, spawns a
// process, or touches a token. The most powerful thing it can do is ask the shell
// to load a URL, and that goes through the same allow-list as every navigation.

function currentPrefs(): ShellPrefs {
  return {
    kiosk: getConfig().kiosk,
    autoStart: autoStartEnabled(),
    autoStartSupported: isAutoStartSupported(),
    trayActive: isTrayActive(),
  };
}

export function registerIpc(): void {
  // ── config ────────────────────────────────────────────────────────────────
  ipcMain.handle(IPC.configGet, (): AppConfig => getConfig());

  ipcMain.handle(IPC.configSetActiveServer, async (_e, id: string | null): Promise<AppConfig> => {
    const cfg = setActiveServer(id);
    void refreshTray();
    return cfg;
  });

  ipcMain.handle(IPC.configUpsertServer, (_e, server: ConsoleServer): AppConfig => {
    // Normalised on the way IN, not on the way out. A stored URL is what the
    // security allow-list is built from, so letting a raw string through would
    // mean the guards and the picker disagreed about what is trusted.
    const check = normaliseConsoleUrl(server.url);
    if (!check.ok || !check.url) {
      log.warn("refused to store a server with an unusable URL:", server.url, check.reason);
      return getConfig();
    }
    const cfg = upsertServer({
      id: server.id,
      label: server.label.trim() || check.url,
      url: check.url,
    });
    void refreshTray();
    return cfg;
  });

  ipcMain.handle(IPC.configRemoveServer, async (_e, id: string): Promise<AppConfig> => {
    const wasActive = getConfig().activeServerId === id;
    const cfg = removeServer(id);
    // A window left sitting on a console that is no longer configured is a window
    // whose next navigation the guards will refuse, which reads as a frozen app.
    if (wasActive) await showLauncher();
    void refreshTray();
    return cfg;
  });

  // ── shell preferences ─────────────────────────────────────────────────────
  ipcMain.handle(IPC.shellPrefsGet, (): ShellPrefs => currentPrefs());

  ipcMain.handle(
    IPC.shellPrefsSet,
    (_e, patch: Partial<Pick<ShellPrefs, "kiosk" | "autoStart">>): ShellPrefs => {
      if (typeof patch.kiosk === "boolean") {
        setKiosk(patch.kiosk);
        applyKiosk(patch.kiosk);
      }
      if (typeof patch.autoStart === "boolean") setAutoStartEnabled(patch.autoStart);
      syncTrayPrefs();
      // The state the OS reports afterwards, not the state that was asked for.
      return currentPrefs();
    },
  );

  // ── servers ───────────────────────────────────────────────────────────────
  ipcMain.handle(IPC.serverProbe, async (_e, url: string): Promise<ServerStatus> => {
    const check = normaliseConsoleUrl(url);
    if (!check.ok || !check.url) {
      return { url, reachable: false, reason: check.reason ?? "Unusable address." };
    }
    return probe(check.url);
  });

  ipcMain.handle(IPC.serverOpen, async (_e, id: string): Promise<void> => {
    const server = serverById(id);
    if (!server) {
      log.warn("open requested for an unknown server id:", id);
      return;
    }
    setActiveServer(id);
    await loadConsole(server.url);
    void refreshTray();
  });

  ipcMain.handle(IPC.serverOpenExternal, async (_e, url: string): Promise<void> => {
    // Only http(s), and only somewhere the shell already trusts. Handing an
    // arbitrary string to the OS handler is how a renderer gets to launch things.
    if (!/^https?:\/\//i.test(url)) {
      log.warn("refused openExternal for a non-http URL:", url);
      return;
    }
    let origin: string;
    try {
      origin = new URL(url).origin;
    } catch {
      return;
    }
    if (!allowedOrigins().includes(origin)) {
      log.warn("refused openExternal for an unconfigured origin:", origin);
      return;
    }
    await shell.openExternal(url);
  });

  // ── displays ──────────────────────────────────────────────────────────────
  ipcMain.handle(IPC.displaysList, () => listDisplays());

  // ── screens: the wall layout ──────────────────────────────────────────────
  //
  // The console sends two ids and a screen. It cannot send a URL or a path: the
  // shell builds the URL itself from the ACTIVE SERVER, so a compromised page
  // cannot use a full-screen window as a way to load somewhere else. See
  // screens.ts on where the structural check ends and the console's own
  // responsibility begins.
  ipcMain.handle(IPC.screensLayout, (): Promise<ScreenLayout> => readLayout());

  ipcMain.handle(
    IPC.screensAssign,
    (_e, signature: string, target: WallTarget): Promise<ScreenLayout> =>
      assignScreen(signature, target),
  );

  ipcMain.handle(IPC.screensClear, (_e, signature: string): Promise<ScreenLayout> =>
    clearScreen(signature),
  );

  ipcMain.handle(IPC.screensCloseAll, (): Promise<ScreenLayout> => closeAllWalls());

  ipcMain.handle(IPC.screensIdentify, (): void => identifyScreens());

  // ── exports ───────────────────────────────────────────────────────────────
  //
  // No path ever crosses this bridge. The renderer can ask for the FOLDER DIALOG
  // and it can ask what the folder currently is, but it cannot name one — a page
  // that could set the download directory could set it to a startup folder.
  ipcMain.handle(IPC.exportPrefsGet, (): ExportPrefs => exportPrefs());
  ipcMain.handle(IPC.exportChooseFolder, (): Promise<ExportPrefs> => chooseExportFolder());
  ipcMain.handle(IPC.exportClearFolder, (): ExportPrefs => clearExportFolder());
  ipcMain.handle(IPC.exportOpenFolder, (): Promise<void> => openExportFolder());

  // ── updates ───────────────────────────────────────────────────────────────
  ipcMain.handle(IPC.updateCheck, () => checkForUpdates());
  ipcMain.handle(IPC.updateInstall, () => installUpdate());

  // ── app ───────────────────────────────────────────────────────────────────
  ipcMain.handle(
    IPC.appInfo,
    (): AppInfo => ({
      version: app.getVersion(),
      electron: process.versions.electron,
      platform: process.platform,
      packaged: app.isPackaged,
      nativeWallAvailable: isNativeWallAvailable(),
    }),
  );

  ipcMain.handle(IPC.appRelaunch, () => {
    app.relaunch();
    app.exit(0);
  });

  log.info("ipc handlers registered");
}
