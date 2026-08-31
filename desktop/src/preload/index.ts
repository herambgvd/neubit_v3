import { contextBridge, ipcRenderer } from "electron";
import {
  IPC,
  type ExportEvent,
  type NeubitBridge,
  type ScreenLayout,
  type UpdateStatus,
} from "@shared/ipc";

// The ONLY bridge between the renderer and the main process. contextIsolation is
// on and Node is off in the renderer, so the console can reach the exact methods
// enumerated here and nothing else. Each one is a thin ipcRenderer.invoke: no
// logic, no Node objects leaking across the bridge.

/** One subscribe helper for every main -> renderer event.
 *
 *  It returns an UNSUBSCRIBE, and that return value is the whole reason this is a
 *  helper rather than three copies of the same four lines. The console is a React
 *  app whose components mount and unmount constantly; a listener registered in an
 *  effect with nothing to call on cleanup accumulates one entry per mount, and
 *  Electron eventually warns about a possible EventEmitter memory leak — after
 *  the shell has been quietly doing the work N times per event for hours. */
function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: unknown, payload: T) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const bridge: NeubitBridge = {
  getConfig: () => ipcRenderer.invoke(IPC.configGet),
  setActiveServer: (id) => ipcRenderer.invoke(IPC.configSetActiveServer, id),
  upsertServer: (server) => ipcRenderer.invoke(IPC.configUpsertServer, server),
  removeServer: (id) => ipcRenderer.invoke(IPC.configRemoveServer, id),

  shellPrefs: () => ipcRenderer.invoke(IPC.shellPrefsGet),
  setShellPrefs: (patch) => ipcRenderer.invoke(IPC.shellPrefsSet, patch),

  probeServer: (url) => ipcRenderer.invoke(IPC.serverProbe, url),
  openServer: (id) => ipcRenderer.invoke(IPC.serverOpen, id),
  openExternal: (url) => ipcRenderer.invoke(IPC.serverOpenExternal, url),

  listDisplays: () => ipcRenderer.invoke(IPC.displaysList),

  screensLayout: () => ipcRenderer.invoke(IPC.screensLayout),
  assignScreen: (signature, target) => ipcRenderer.invoke(IPC.screensAssign, signature, target),
  clearScreen: (signature) => ipcRenderer.invoke(IPC.screensClear, signature),
  closeAllWalls: () => ipcRenderer.invoke(IPC.screensCloseAll),
  identifyScreens: () => ipcRenderer.invoke(IPC.screensIdentify),
  onScreensChanged: (cb: (layout: ScreenLayout) => void) =>
    subscribe(IPC.screensChangedEvent, cb),

  exportPrefs: () => ipcRenderer.invoke(IPC.exportPrefsGet),
  chooseExportFolder: () => ipcRenderer.invoke(IPC.exportChooseFolder),
  clearExportFolder: () => ipcRenderer.invoke(IPC.exportClearFolder),
  openExportFolder: () => ipcRenderer.invoke(IPC.exportOpenFolder),
  onExportEvent: (cb: (event: ExportEvent) => void) => subscribe(IPC.exportEvent, cb),

  checkForUpdates: () => ipcRenderer.invoke(IPC.updateCheck),
  installUpdate: () => ipcRenderer.invoke(IPC.updateInstall),
  onUpdateStatus: (cb: (s: UpdateStatus) => void) => subscribe(IPC.updateStatusEvent, cb),

  appInfo: () => ipcRenderer.invoke(IPC.appInfo),
  relaunch: () => ipcRenderer.invoke(IPC.appRelaunch),
};

contextBridge.exposeInMainWorld("neubit", bridge);
