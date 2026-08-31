import { dialog, session, shell, type DownloadItem, type WebContents } from "electron";
import { existsSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { IPC, type ExportEvent, type ExportPrefs } from "@shared/ipc";
import { allowedOrigins, getExportFolder, setExportFolder } from "./config";
import { getMainWindow } from "./window";
import { log } from "./logger";

// Local export — where a download goes on a workstation that is not a browser.
//
// ══ WHAT THE CONSOLE ALREADY DOES ═══════════════════════════════════════════
//
// Every export in v3 ends the same way. features/vms/components/ExportDialog.jsx
// fetches the clip as an axios blob, calls URL.createObjectURL, and clicks a
// synthetic <a download>. So do the evidence manifest beside it, the user CSV in
// features/core/users/Users.jsx, the camera config backup in DeviceMaintenance,
// and every snapshot button in LivePlayer.
//
// In a browser that lands in the download tray, under whatever name Chrome
// settles on, in whatever folder that machine's Chrome was last pointed at. In a
// control room the answer needs to be "the evidence folder, under the name the
// console chose, and somebody can say where it went".
//
// ══ WHY THIS IS TEN LINES OF POLICY AND NOT A DOWNLOAD MANAGER ══════════════
//
// Electron already has the download machinery; what it does not have is an
// opinion. This supplies exactly one: when the operator has named a folder, skip
// the Save dialog and write there. Everything else — the transfer, the progress,
// the resume, the cancel — is Chromium's, and reimplementing any of it would be
// building a worse copy of something already in the process.
//
// ══ THE DEFAULT IS "ASK" ════════════════════════════════════════════════════
//
// With no folder configured, nothing here intervenes and Electron shows its own
// Save dialog. That is the correct default rather than a missing feature: an
// application that silently starts writing video into a folder nobody chose is an
// application an operator has to go looking for files from.

/** Fires when the operator has NOT set a folder — Electron's own Save dialog
 *  handles the download, and nothing is written anywhere unattended. */
function shouldAutoSave(webContents: WebContents | undefined): string | null {
  const folder = getExportFolder();
  if (!folder) return null;

  // ══ WHY THE PAGE'S ORIGIN AND NOT THE DOWNLOAD'S URL ══════════════════════
  //
  // item.getURL() for these downloads is a blob: URL — `blob:http://localhost/<uuid>`
  // — because the console builds the file in the page from an axios blob rather
  // than linking to it. Parsing an origin out of that is guesswork that varies by
  // URL implementation. The WebContents that started the download is unambiguous
  // and is the thing the check is actually about: whether this came from a console
  // the operator configured, or from some page that ended up in a window.
  const origin = pageOrigin(webContents);
  if (!origin) {
    log.warn("export: a download arrived with no identifiable page; leaving it to the Save dialog");
    return null;
  }
  if (!isTrusted(origin)) {
    log.warn(`export: download from an untrusted origin ${origin}; leaving it to the Save dialog`);
    return null;
  }
  if (!existsSync(folder)) {
    // The folder was on a share that is gone, or a drive that was unplugged.
    // Falling back to the dialog keeps the export possible; silently recreating
    // the path would put evidence somewhere nobody expects it.
    log.warn(`export: folder ${folder} no longer exists; leaving it to the Save dialog`);
    return null;
  }
  return folder;
}

function pageOrigin(webContents: WebContents | undefined): string | null {
  if (!webContents || webContents.isDestroyed()) return null;
  try {
    return new URL(webContents.getURL()).origin;
  } catch {
    return null;
  }
}

function isTrusted(origin: string): boolean {
  if (allowedOrigins().includes(origin)) return true;
  try {
    const host = new URL(origin).hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  } catch {
    return false;
  }
}

/** Reduce whatever the page asked to be called to a plain file name.
 *
 *  The name comes from the `download` attribute, which is to say from a web page.
 *  Chromium sanitises it before we ever see it, and this does it again anyway —
 *  a renderer-supplied string that is about to be joined onto a directory path is
 *  not somewhere to rely on a second layer's diligence. basename() alone stops
 *  the traversal; the rest is Windows refusing to create the file otherwise. */
function safeName(raw: string): string {
  const base = basename(raw || "export").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim();
  const cleaned = base === "" || base === "." || base === ".." ? "export" : base;
  // NTFS caps a component at 255; leave room for the " (12)" a collision adds.
  return cleaned.length > 240 ? cleaned.slice(0, 240) : cleaned;
}

/** A path in `folder` that is not already taken.
 *
 *  Exports repeat — the same camera, the same incident, twice in an afternoon —
 *  and overwriting the first one is the failure that is only noticed later, by
 *  which time it is unrecoverable. "clip (2).mp4" is what every other application
 *  on the machine does, so it needs no explaining to the operator either. */
function uniquePath(folder: string, filename: string): string {
  const name = safeName(filename);
  const first = join(folder, name);
  if (!existsSync(first)) return first;

  const ext = extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  for (let n = 2; n < 1000; n++) {
    const candidate = join(folder, `${stem} (${n})${ext}`);
    if (!existsSync(candidate)) return candidate;
  }
  // A thousand copies of one name is not a case worth a cleverer answer; hand it
  // back to the dialog rather than looping.
  return first;
}

let nextId = 1;

function emit(event: ExportEvent): void {
  const win = getMainWindow();
  if (win && !win.isDestroyed()) win.webContents.send(IPC.exportEvent, event);
}

export function initExports(): void {
  session.defaultSession.on("will-download", (_event, item: DownloadItem, webContents) => {
    const id = nextId++;
    const filename = item.getFilename();
    const folder = shouldAutoSave(webContents);

    let savePath: string | null = null;
    if (folder) {
      savePath = uniquePath(folder, filename);
      // setSavePath is what suppresses the Save dialog. Setting it after the
      // event handler returns is too late — Chromium has already asked.
      item.setSavePath(savePath);
      log.info(`export: ${filename} -> ${savePath}`);
    }

    emit({ state: "started", id, filename, savePath });

    item.on("updated", (_e, state) => {
      if (state !== "progressing" || item.isPaused()) return;
      emit({
        state: "progress",
        id,
        filename,
        received: item.getReceivedBytes(),
        // 0 when the server sent no Content-Length. Passed through as 0 rather
        // than faked, so the console can show a spinner instead of a bar that
        // claims a percentage nobody knows.
        total: item.getTotalBytes(),
      });
    });

    item.once("done", (_e, state) => {
      if (state === "completed") {
        emit({ state: "done", id, filename, savePath: item.getSavePath() });
        log.info(`export finished: ${item.getSavePath()}`);
        return;
      }
      if (state === "cancelled") {
        // Includes the operator dismissing the Save dialog, which is not a fault.
        emit({ state: "cancelled", id, filename });
        log.info(`export cancelled: ${filename}`);
        return;
      }
      emit({ state: "failed", id, filename, reason: state });
      log.warn(`export failed (${state}): ${filename}`);
    });
  });

  log.info("export handler installed");
}

export function exportPrefs(): ExportPrefs {
  return { folder: getExportFolder() };
}

export async function chooseExportFolder(): Promise<ExportPrefs> {
  const win = getMainWindow();
  const result = await (win
    ? dialog.showOpenDialog(win, folderDialogOptions())
    : dialog.showOpenDialog(folderDialogOptions()));

  if (result.canceled || result.filePaths.length === 0) return exportPrefs();
  setExportFolder(result.filePaths[0]);
  log.info(`export folder set: ${result.filePaths[0]}`);
  return exportPrefs();
}

function folderDialogOptions(): Electron.OpenDialogOptions {
  return {
    title: "Where should exports be saved?",
    // createDirectory so an operator can make "Evidence" from inside the dialog
    // rather than being sent to Explorer and back.
    properties: ["openDirectory", "createDirectory"],
    defaultPath: getExportFolder() ?? undefined,
    buttonLabel: "Use this folder",
  };
}

/** Back to asking every time. Not a hidden reset: it is the state the app ships
 *  in, and an operator who has been moved to a different desk wants it. */
export function clearExportFolder(): ExportPrefs {
  setExportFolder(null);
  log.info("export folder cleared — downloads will ask again");
  return exportPrefs();
}

export async function openExportFolder(): Promise<void> {
  const folder = getExportFolder();
  if (!folder) return;
  const problem = await shell.openPath(folder);
  if (problem) log.warn(`could not open the export folder: ${problem}`);
}
