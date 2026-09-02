import { app } from "electron";
import Store from "electron-store";
import {
  normaliseConsoleUrl,
  type AppConfig,
  type ConsoleServer,
  type WallAssignment,
} from "@shared/ipc";

// Persisted shell config (electron-store → a JSON file in userData). This holds
// WHICH console the shell loads and the operator's shell preferences — never a
// backend secret. The console owns its session token, exactly as it does in a
// browser: see the note at the top of shared/ipc.ts.
//
// Defaults come from the environment so a dev run or an OEM image can pre-seed a
// server without anyone visiting the picker.

const DEFAULTS: AppConfig = {
  activeServerId: seedServer() ? "default" : null,
  servers: seedServer() ? [seedServer()!] : [],
  kiosk: process.env.NEUBIT_KIOSK === "1",
  walls: [],
  exportFolder: null,
};

function seedServer(): ConsoleServer | null {
  const raw = process.env.NEUBIT_CONSOLE_URL?.trim();
  if (!raw) return null;
  // Through the same normaliser the picker uses, so an env var pointing at :3000
  // is refused here rather than producing a shell that loads a console whose every
  // API call 404s.
  const check = normaliseConsoleUrl(raw);
  if (!check.ok || !check.url) return null;
  return { id: "default", label: "Default console", url: check.url };
}

// The store is built LAZILY, on first use, and is given an explicit cwd.
//
// Both halves matter and both were learned by the NVR shell refusing to start:
//
//  * electron-store normally derives its directory by walking up to the app's
//    package.json for a project name. electron-vite bundles the main process into
//    a single out/main/index.js, that walk finds nothing, and the underlying conf
//    throws "Please specify the `projectName` option." Supplying cwd removes the
//    need for that inference entirely — app.getPath is the authoritative answer
//    anyway, and it is the same directory the store would have chosen.
//  * app.getPath("userData") is only meaningful once Electron has initialised, so
//    the store cannot be constructed at module scope. In the NVR shell it was,
//    which made the throw happen during import — before any window, any logger or
//    any error handler existed. The process exited with code 1 and no log file,
//    which is how that scaffold sat through four commits looking finished while
//    never once having started.
let cached: Store<AppConfig> | null = null;

function store(): Store<AppConfig> {
  if (!cached) {
    cached = new Store<AppConfig>({
      cwd: app.getPath("userData"),
      name: "neubit-vms",
      defaults: DEFAULTS,
    });
  }
  return cached;
}

export function getConfig(): AppConfig {
  return store().store;
}

export function setActiveServer(id: string | null): AppConfig {
  store().set("activeServerId", id);
  return store().store;
}

export function upsertServer(server: ConsoleServer): AppConfig {
  const servers = store().get("servers").filter((s) => s.id !== server.id);
  servers.push(server);
  store().set("servers", servers);
  return store().store;
}

export function removeServer(id: string): AppConfig {
  store().set(
    "servers",
    store().get("servers").filter((s) => s.id !== id),
  );
  if (store().get("activeServerId") === id) store().set("activeServerId", null);
  return store().store;
}

export function serverById(id: string): ConsoleServer | null {
  return store().get("servers").find((s) => s.id === id) ?? null;
}

/** The URL of the console the operator chose, or null when none is active. */
export function activeServerUrl(): string | null {
  const cfg = store().store;
  if (!cfg.activeServerId) return null;
  return cfg.servers.find((s) => s.id === cfg.activeServerId)?.url ?? null;
}

/** The origin allow-list for the security layer: every configured console URL's
 *  origin, so the navigation guards permit the real consoles and nothing else.
 *  Recomputed from config each time it is asked, so a newly added server is
 *  trusted immediately. */
export function allowedOrigins(): string[] {
  const out = new Set<string>();
  for (const s of store().get("servers")) {
    try {
      out.add(new URL(s.url).origin);
    } catch {
      /* a malformed stored URL simply is not trusted */
    }
  }
  return [...out];
}

/** Full-screen kiosk: on for a wall-mounted or dedicated operator station, off
 *  for an ordinary desktop. Stored rather than passed as a launch flag because
 *  the machines that want it want it on every boot, and nobody is there to pass
 *  an argument.
 *
 *  NEUBIT_KIOSK=1 still seeds the DEFAULT, so an OEM image can ship kiosk-on
 *  without a first-run visit; once the operator touches the setting, their choice
 *  is what persists. */
export function setKiosk(on: boolean): AppConfig {
  store().set("kiosk", on);
  return store().store;
}

// ── the wall layout ────────────────────────────────────────────────────────
//
// Which physical screen shows which wall monitor. Persisted because it is a
// property of THIS WORKSTATION and nothing else knows it: the server knows a wall
// has four monitors, and only this box knows that monitor 3 is the panel on the
// right-hand wall of this particular control room.

export function getWalls(): WallAssignment[] {
  const raw = store().get("walls");
  // Defensive: this file is hand-editable JSON in userData, and a half-written
  // entry must not take the shell down on the startup path that restores walls.
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (a): a is WallAssignment =>
      !!a &&
      typeof a.displaySignature === "string" &&
      typeof a.wallId === "string" &&
      typeof a.monitorId === "string",
  );
}

export function setWalls(walls: WallAssignment[]): AppConfig {
  store().set("walls", walls);
  return store().store;
}

// ── the export folder ──────────────────────────────────────────────────────

export function getExportFolder(): string | null {
  const raw = store().get("exportFolder");
  return typeof raw === "string" && raw.trim() !== "" ? raw : null;
}

export function setExportFolder(folder: string | null): AppConfig {
  store().set("exportFolder", folder);
  return store().store;
}
