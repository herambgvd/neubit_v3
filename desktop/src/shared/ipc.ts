// The IPC contract. Imported by BOTH the main process and the preload bridge, so
// the channel names and the payload shapes cannot drift apart.
//
// Deliberately small. The renderer that matters is the v3 console, served over
// HTTP by the gateway, and it is a normal web app: it owns its own session, its
// own routing and its own data. The bridge exists only for what a browser tab
// cannot do — pick which server to load, know about the monitors attached to this
// machine, and tell the operator an update is waiting.
//
// NOT here, on purpose:
//   * anything touching the session. The console stores its JWT in localStorage
//     under `vizor.access` (frontend/src/lib/api.js). The shell must never read,
//     write or forward it — it is the console's, exactly as in a browser, and a
//     shell that handled tokens would become a second thing to get auth wrong in.
//   * the video wall and local export. Those are P3 and want the native decode
//     addon; adding half of their surface now would be a contract to maintain
//     before there is anything behind it.

/** A v3 console this shell can load.
 *
 *  `url` is always a GATEWAY origin — see `normaliseConsoleUrl`. There is no
 *  `kind` field: neubit_nvr and neubit_v3 are separate products with separate
 *  shells, and the union that used to live here was a leftover from when one
 *  shell was meant to serve both. */
export interface ConsoleServer {
  id: string;
  label: string;
  url: string;
}

/** Persisted shell configuration (electron-store → JSON in userData).
 *
 *  Holds WHICH console to load and how this workstation behaves. Never a
 *  credential. */
export interface AppConfig {
  activeServerId: string | null;
  servers: ConsoleServer[];
  kiosk: boolean;
  /** Which physical screen shows which wall monitor. See WallAssignment. */
  walls: WallAssignment[];
  /** Where exports are written without asking. Null → Electron's Save dialog. */
  exportFolder: string | null;
}

/** The shell-owned preferences the renderer may read and change. Separate from
 *  AppConfig because these are the ones with an OS-level truth behind them
 *  (Windows can revoke a startup entry), so the reply reports what the machine
 *  says rather than what was asked for. */
export interface ShellPrefs {
  kiosk: boolean;
  autoStart: boolean;
  autoStartSupported: boolean;
  /** False when the desktop session has no system tray, in which case closing
   *  the window genuinely quits and the UI must say so. */
  trayActive: boolean;
}

/** Whether a console origin is answering, and what it said.
 *
 *  `/health` is served by core and routed by the gateway, so a 200 here means the
 *  whole path the console depends on is up: Traefik is routing, core is running,
 *  and its database is reachable. */
export interface ServerStatus {
  url: string;
  reachable: boolean;
  /** Round-trip in ms for the probe that answered, for the tray tooltip. */
  latencyMs?: number;
  /** Why not, in words an operator can act on. */
  reason?: string;
}

export interface DisplayInfo {
  id: number;
  label: string;
  primary: boolean;
  bounds: { x: number; y: number; width: number; height: number };
  scaleFactor: number;
  /** Stable across reboots in a way `id` is not — see main/displays.ts. */
  signature: string;
}

export type UpdateStatus =
  | { state: "checking" }
  | { state: "none" }
  | { state: "available"; version: string }
  | { state: "downloading"; percent: number }
  | { state: "ready"; version: string }
  | { state: "error"; message: string };

export interface AppInfo {
  version: string;
  electron: string;
  /** `process.platform`. A plain string, not `NodeJS.Platform`: this file is
   *  compiled for the RENDERER as well, where the Node types are deliberately
   *  absent (tsconfig.web.json sets `"types": []`), and reaching for a Node
   *  namespace here fails the web build with "Cannot find namespace 'NodeJS'". */
  platform: string;
  packaged: boolean;
  /** Whether the native decode addon loaded. FALSE in every build shipped so
   *  far, and deliberately surfaced rather than assumed: the console decides
   *  whether to offer a density it cannot actually render. See desktop/native/. */
  nativeWallAvailable: boolean;
}

/** Channel names. String constants rather than an enum so the preload bundle does
 *  not need a runtime enum object shipped across the context bridge. */
export const IPC = {
  configGet: "config:get",
  configSetActiveServer: "config:setActiveServer",
  configUpsertServer: "config:upsertServer",
  configRemoveServer: "config:removeServer",

  shellPrefsGet: "shell:prefs:get",
  shellPrefsSet: "shell:prefs:set",

  serverProbe: "server:probe",
  serverOpen: "server:open",
  serverOpenExternal: "server:openExternal",

  displaysList: "displays:list",

  screensLayout: "screens:layout",
  screensAssign: "screens:assign",
  screensClear: "screens:clear",
  screensCloseAll: "screens:closeAll",
  screensIdentify: "screens:identify",
  screensChangedEvent: "screens:changed",

  exportPrefsGet: "export:prefs:get",
  exportChooseFolder: "export:chooseFolder",
  exportClearFolder: "export:clearFolder",
  exportOpenFolder: "export:openFolder",
  exportEvent: "export:event",

  updateCheck: "update:check",
  updateInstall: "update:install",
  updateStatusEvent: "update:status",

  appInfo: "app:info",
  appRelaunch: "app:relaunch",
} as const;

/** The surface exposed on `window.neubit` in every renderer. */
export interface NeubitBridge {
  getConfig(): Promise<AppConfig>;
  setActiveServer(id: string | null): Promise<AppConfig>;
  upsertServer(server: ConsoleServer): Promise<AppConfig>;
  removeServer(id: string): Promise<AppConfig>;

  shellPrefs(): Promise<ShellPrefs>;
  setShellPrefs(patch: Partial<Pick<ShellPrefs, "kiosk" | "autoStart">>): Promise<ShellPrefs>;

  /** Ask whether an origin is a reachable v3 console, before committing to it. */
  probeServer(url: string): Promise<ServerStatus>;
  /** Make a server active and load it into the main window. */
  openServer(id: string): Promise<void>;
  /** Hand an http(s) URL to the OS browser. */
  openExternal(url: string): Promise<void>;

  listDisplays(): Promise<DisplayInfo[]>;

  /** The screens on this workstation and what each is showing. */
  screensLayout(): Promise<ScreenLayout>;
  /** Put a wall monitor full screen on a physical screen, and remember it. */
  assignScreen(signature: string, target: WallTarget): Promise<ScreenLayout>;
  /** Take a screen back: close its wall window and forget the assignment. */
  clearScreen(signature: string): Promise<ScreenLayout>;
  /** Close every wall window without forgetting anything. */
  closeAllWalls(): Promise<ScreenLayout>;
  /** Flash a big number on each screen, the way Windows' display settings does,
   *  so the operator can tell which physical panel is which before assigning. */
  identifyScreens(): Promise<void>;
  /** Fires when a monitor is plugged in, unplugged or rearranged. */
  onScreensChanged(cb: (layout: ScreenLayout) => void): () => void;

  exportPrefs(): Promise<ExportPrefs>;
  chooseExportFolder(): Promise<ExportPrefs>;
  clearExportFolder(): Promise<ExportPrefs>;
  openExportFolder(): Promise<void>;
  onExportEvent(cb: (event: ExportEvent) => void): () => void;

  checkForUpdates(): Promise<void>;
  installUpdate(): Promise<void>;
  onUpdateStatus(cb: (status: UpdateStatus) => void): () => void;

  appInfo(): Promise<AppInfo>;
  relaunch(): Promise<void>;
}

declare global {
  interface Window {
    neubit: NeubitBridge;
  }
}

/** The port the v3 console is served on: the GATEWAY, port 80, always.
 *
 *  ══ WHY THIS IS A CONSTANT AND NOT A SETTING ════════════════════════════════
 *
 *  The console's API base is same-origin RELATIVE — `frontend/src/lib/api.js`
 *  resolves `baseURL` to "/api/v1" so one build runs on any host with no rebuild
 *  — and only Traefik routes `/api` to core. Load the same console from the Next
 *  server's own port instead and every page renders while every authed call 404s
 *  against Next.js, which reads as a broken backend and is not.
 *
 *  That is not hypothetical. It cost a debugging session: a login on
 *  http://localhost:3000 that answered "Request failed with status code 404"
 *  while the identical credentials succeeded on http://localhost.
 *
 *  So the shell refuses to be pointed at :3000, rather than leaving it as a field
 *  an operator can get wrong at 2am. */
export const CONSOLE_PORT = 80;

/** Ports that serve the console's HTML but not its API. Rejected with an
 *  explanation rather than silently rewritten — someone who typed one has a
 *  mental model worth correcting. */
const NON_GATEWAY_PORTS = new Set(["3000", "8000", "3001"]);

/** Where the OPERATOR CONSOLE starts, appended to a server origin.
 *
 *  ══ WHY NOT JUST THE ORIGIN ═════════════════════════════════════════════════
 *
 *  `/` on a v3 server is the PUBLIC MARKETING PAGE — "Command. Control.
 *  Intelligence.", a Book-a-Demo button, the product tour. Correct for a browser
 *  arriving at the address; absurd for a desktop application whose entire reason
 *  to exist is the console. The first run of this shell opened on it, which is how
 *  it got noticed.
 *
 *  `/login` is the right entry and stays right in both states: signed out it is
 *  the sign-in form, and signed in the console bounces straight past it (see
 *  `frontend/src/features/core/auth/Login.jsx` — "Already signed in → the login
 *  page is a dead end; bounce to the console"). So the shell does not need to know
 *  whether a session exists, which is good, because the session is the console's
 *  and the shell must not read it.
 *
 *  Servers are still STORED as bare origins — that is what the navigation
 *  allow-list is built from, and it must match by origin, not by path. */
export const CONSOLE_ENTRY_PATH = "/login";

/** The URL the shell actually loads for a server origin. */
export function consoleEntryUrl(origin: string): string {
  return `${origin.replace(/\/+$/, "")}${CONSOLE_ENTRY_PATH}`;
}

export interface UrlCheck {
  ok: boolean;
  /** The origin to use, when ok. */
  url?: string;
  reason?: string;
}

/** Normalise what an operator typed into a gateway origin, or explain why not.
 *
 *  Accepts a bare host ("192.168.1.10"), a host:port, or a full URL. Strips any
 *  path — the shell loads an origin and lets the console route itself. */
export function normaliseConsoleUrl(input: string): UrlCheck {
  const raw = input.trim();
  if (raw === "") return { ok: false, reason: "Enter a server address." };

  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false, reason: `"${raw}" is not a valid address.` };
  }

  if (url.hostname === "") return { ok: false, reason: `"${raw}" has no host.` };

  if (url.port !== "" && NON_GATEWAY_PORTS.has(url.port)) {
    return {
      ok: false,
      reason:
        `Port ${url.port} serves the console but not its API — signing in there fails ` +
        `with a 404. Use ${url.hostname} on its own.`,
    };
  }

  return { ok: true, url: url.origin };
}

// ═══════════════════════════════════════════════════════════════════════════
//  P3 — the desktop-only surface
// ═══════════════════════════════════════════════════════════════════════════
//
// Everything above is about WHICH console to load. Everything below is about the
// two things a browser tab structurally cannot do: put a wall on the second
// monitor and keep it there across a restart, and write an export to a folder the
// operator chose rather than into the browser's download tray.
//
// ══ THE WALL ITSELF IS NOT HERE, AND THAT IS THE DESIGN ═════════════════════
//
// v3 already models a video wall SERVER-SIDE. A wall holds monitors; each monitor
// carries its own 1/4/9/16 layout; and the live assignment of cameras to cells is
// one shared JSON blob on the wall row, pushed to every client over SSE
// (backend/vision/app/vms/models/videowall.py — "the one source of truth every
// operator + display-client syncs to"). The console renders a single monitor at
// /wall-display/<wallId>/<monitorId>, deliberately outside the (app) header and
// footer chrome, for exactly this purpose.
//
// So the shell's entire job is to bind a PHYSICAL screen to one of those monitors
// and open that URL full screen on it. The wall's CONTENTS stay the server's —
// shared with every other operator and every other display client — which is what
// makes a video wall a video wall rather than four browser windows. A shell that
// held its own camera-to-cell state would be a second wall that silently
// disagreed with the first.
//
// The corollary is that the shell never lists walls. It cannot: the wall API is
// authed and the session belongs to the console (see the note at the top of this
// file). The CONSOLE picks the monitor, because that is where the data and the
// token already are, and hands the shell two ids.

/** One physical screen on this workstation, bound to one monitor on one wall.
 *
 *  `wallLabel` and `monitorLabel` are stored alongside the ids, which is
 *  redundant right up until it is not: the settings panel has to describe a saved
 *  assignment while the server is down, while the operator is signed out, or
 *  after somebody deleted that monitor — and the shell cannot resolve an id to a
 *  name, because doing so would need the token it must never hold. Two dead
 *  strings beat "monitor 7f3a…" in front of an operator. */
export interface WallAssignment {
  displaySignature: string;
  displayLabel: string;
  wallId: string;
  monitorId: string;
  wallLabel: string;
  monitorLabel: string;
}

/** What the console sends to claim a screen. */
export type WallTarget = Omit<WallAssignment, "displaySignature" | "displayLabel">;

export interface ScreenSlot {
  signature: string;
  label: string;
  primary: boolean;
  /** False for a saved assignment whose monitor is not plugged in right now.
   *  Kept, not discarded — see main/screens.ts. */
  attached: boolean;
  resolution: string;
  /** Whether a wall window is actually up on it at this moment. Separate from
   *  `assignment` because the two genuinely differ: an assignment can be saved
   *  while the screen is unplugged, or while no console is configured to open. */
  open: boolean;
  assignment: WallAssignment | null;
}

export interface ScreenLayout {
  /** The console origin wall windows are opened against, or null when none is
   *  configured — a supported state the panel reports rather than an error. */
  consoleUrl: string | null;
  screens: ScreenSlot[];
}

/** The console's single-monitor kiosk route. */
export const WALL_DISPLAY_PATH = "/wall-display";

/** Wall and monitor ids are `String(36)` UUIDs in the vision service
 *  (`_uuid_str`), but this deliberately validates the SHAPE OF A PATH SEGMENT
 *  rather than a UUID.
 *
 *  The gate matters because these ids arrive from the loaded console — a web page
 *  — and are then interpolated into a URL the shell opens in a window carrying
 *  the preload bridge. `new URL()` would keep a "../.." on the same origin, so
 *  the blast radius is small, but "small" is not the standard for a string that
 *  crosses from a page into window creation. Refusing anything with a slash, a
 *  colon or a percent costs nothing and closes the question.
 *
 *  Not a UUID regex, because that would couple the shell to a column type in
 *  another service: the day vision switches to ULIDs or slugs, a UUID gate turns
 *  the whole video wall off with no error anyone can read. */
const RESOURCE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function isWallResourceId(value: unknown): value is string {
  return typeof value === "string" && RESOURCE_ID.test(value);
}

/** The URL a physical screen loads for one wall monitor, or null when the ids are
 *  not safe to put in a path. */
export function wallDisplayUrl(origin: string, wallId: string, monitorId: string): string | null {
  if (!isWallResourceId(wallId) || !isWallResourceId(monitorId)) return null;
  const base = origin.replace(/\/+$/, "");
  return `${base}${WALL_DISPLAY_PATH}/${encodeURIComponent(wallId)}/${encodeURIComponent(monitorId)}`;
}

// ── local export ───────────────────────────────────────────────────────────
//
// The console already exports: a clip job, an evidence manifest, a user CSV, a
// camera config backup. Every one of them ends the same way in
// features/vms/components/ExportDialog.jsx and its siblings — an axios blob, a
// createObjectURL, and a synthetic `<a download>` click. In a browser that lands
// in the download tray under whatever name Chrome settles on.
//
// A control room wants it in the evidence folder, under the name the console
// chose, with somebody able to say where it went. That is all this is.

export interface ExportPrefs {
  /** Where exports are written without asking. Null means no folder is set and
   *  Electron's own Save dialog handles each download, which is the correct
   *  default: nothing is written anywhere the operator did not name. */
  folder: string | null;
}

/** Progress for one download, forwarded to the console so it can show it in its
 *  own UI rather than in a shell panel nobody is looking at. */
export type ExportEvent =
  | { state: "started"; id: number; filename: string; savePath: string | null }
  | { state: "progress"; id: number; filename: string; received: number; total: number }
  | { state: "done"; id: number; filename: string; savePath: string }
  | { state: "failed"; id: number; filename: string; reason: string }
  | { state: "cancelled"; id: number; filename: string };
