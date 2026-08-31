import { autoUpdater } from "electron-updater";
import { app, BrowserWindow } from "electron";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { IPC, type UpdateStatus } from "@shared/ipc";
import { log } from "./logger";

// Auto-update wiring (electron-updater). The feed URL lives in electron-builder.yml
// `publish`. Update state is forwarded to every window on the IPC.updateStatusEvent
// channel so the renderer can show a "restart to update" prompt. Downloads are
// NOT auto-installed — an operator station must not restart itself mid-shift, so the
// install waits for an explicit installUpdate() call.

function broadcast(status: UpdateStatus): void {
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send(IPC.updateStatusEvent, status);
  }
}

export function initUpdater(): void {
  autoUpdater.logger = log;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on("checking-for-update", () => broadcast({ state: "checking" }));
  autoUpdater.on("update-available", (i) =>
    broadcast({ state: "available", version: i.version }),
  );
  autoUpdater.on("update-not-available", () => broadcast({ state: "none" }));
  autoUpdater.on("download-progress", (p) =>
    broadcast({ state: "downloading", percent: Math.round(p.percent) }),
  );
  autoUpdater.on("update-downloaded", (i) =>
    broadcast({ state: "ready", version: i.version }),
  );
  autoUpdater.on("error", (e) =>
    broadcast({ state: "error", message: e?.message ?? "update failed" }),
  );
}

/** Is there a feed to check at all?
 *
 *  electron-builder writes resources/app-update.yml from the `publish` block, and
 *  that block is deliberately absent until P4 — see electron-builder.yml. Without
 *  this guard electron-updater throws ENOENT on that file and logs it AT ERROR
 *  LEVEL through its own logger, before the throw ever reaches the catch below.
 *
 *  That is a red line in the log of every installed copy, on every launch, meaning
 *  "working exactly as designed" — and the first thing anyone looks at when a
 *  machine misbehaves is the log. Checking for the file first costs one stat and
 *  keeps the log honest. */
function hasUpdateFeed(): boolean {
  if (!app.isPackaged) return false;
  return existsSync(join(process.resourcesPath, "app-update.yml"));
}

export async function checkForUpdates(): Promise<void> {
  if (!hasUpdateFeed()) {
    // Not an error, and said once rather than every time: an unpackaged dev run,
    // or a build shipped before the update feed exists.
    log.info("no update feed configured — skipping the update check");
    broadcast({ state: "none" });
    return;
  }
  try {
    await autoUpdater.checkForUpdates();
  } catch (e) {
    log.info("update check skipped:", (e as Error).message);
    broadcast({ state: "none" });
  }
}

export function installUpdate(): void {
  autoUpdater.quitAndInstall();
}
