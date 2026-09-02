import { BrowserWindow, screen } from "electron";
import { IPC, wallDisplayUrl, isWallResourceId } from "@shared/ipc";
import type { ScreenLayout, ScreenSlot, WallAssignment, WallTarget } from "@shared/ipc";
import { getWalls, setWalls } from "./config";
import { displayForSignature, listDisplays } from "./displays";
import { isAllowedConsoleUrl } from "./security";
import {
  closeAllWallWindows,
  closeWallOn,
  getMainWindow,
  openWallOn,
  openWallSignatures,
  resolveConsoleOrigin,
} from "./window";
import { log } from "./logger";

// The multi-monitor split — the reason this application exists on an operator's
// desk rather than in their browser.
//
// ══ WHAT IT DOES ════════════════════════════════════════════════════════════
//
// Binds a PHYSICAL screen on this workstation to a MONITOR on a video wall, and
// opens the console's single-monitor kiosk route full screen on it. Four panels
// on a desk become four monitors of one shared wall, and they come back that way
// after a restart.
//
// ══ WHAT IT DOES NOT DO, AND WHY ════════════════════════════════════════════
//
// It holds no wall content. Which camera is in which cell is the SERVER's, held
// as one JSON blob on the wall row and pushed to every client over SSE, so an
// operator moving a camera on the console moves it on the wall panels a frame
// later — including panels driven by a different workstation entirely. A shell
// that cached that state locally would be a second wall quietly disagreeing with
// the first, and the disagreement would surface as "the wall is showing the wrong
// camera", which is the worst bug this product could have.
//
// It also never lists walls. It cannot: /api/v1/vms/walls is authed and the
// session belongs to the console (shared/ipc.ts explains why the shell must never
// hold the token). The CONSOLE picks — it already has the wall, the monitors and
// the operator's permissions — and hands two ids across the bridge.
//
// ══ THE ONE DOMAIN RULE THAT LIVES ON THE OTHER SIDE ════════════════════════
//
// A wall monitor has a `kind`: browser or decoder. A decoder monitor is a
// hardware decoder output driven over its SDK, so putting a browser on a panel
// that is meant to be fed by hardware is a mistake with no error message. The
// shell cannot check it, because `kind` lives in a record it cannot read, so the
// console does not offer decoder monitors. That split is deliberate and worth
// stating plainly: the shell validates STRUCTURE (see isWallResourceId), the
// console validates MEANING.

/** Guard on what the console sends. Structural only — see the module note. */
function validTarget(target: unknown): target is WallTarget {
  if (!target || typeof target !== "object") return false;
  const t = target as Record<string, unknown>;
  return isWallResourceId(t.wallId) && isWallResourceId(t.monitorId);
}

function labelOf(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
}

export async function readLayout(): Promise<ScreenLayout> {
  const consoleUrl = await resolveConsoleOrigin();
  const assignments = getWalls();
  const openNow = new Set(openWallSignatures());

  const screens: ScreenSlot[] = listDisplays().map((d) => ({
    signature: d.signature,
    label: d.label,
    primary: d.primary,
    attached: true,
    resolution: `${d.bounds.width} × ${d.bounds.height}`,
    open: openNow.has(d.signature),
    assignment: assignments.find((a) => a.displaySignature === d.signature) ?? null,
  }));

  // Assignments whose screen is not plugged in right now are listed too, marked
  // detached. Dropping them would be tidier and wrong: a station gets taken
  // apart, a panel dies, somebody carries the box to a one-screen desk — and an
  // operator who plugs the screen back in expects their wall, not a blank slate
  // to rebuild from memory in the middle of a shift.
  for (const a of assignments) {
    if (screens.some((s) => s.signature === a.displaySignature)) continue;
    screens.push({
      signature: a.displaySignature,
      label: a.displayLabel,
      primary: false,
      attached: false,
      resolution: "",
      open: false,
      assignment: a,
    });
  }

  return { consoleUrl, screens };
}

/** Give a screen a wall monitor. Persists AND applies in the same call.
 *
 *  Splitting the two would let the saved layout and the panels disagree, which is
 *  the exact state that teaches an operator to restart the app to "make it take". */
export async function assignScreen(signature: string, target: WallTarget): Promise<ScreenLayout> {
  if (typeof signature !== "string" || signature.trim() === "") {
    log.warn("assignScreen called without a screen");
    return readLayout();
  }
  if (!validTarget(target)) {
    log.warn("refused a wall assignment with unusable ids:", JSON.stringify(target));
    return readLayout();
  }

  const known = listDisplays().find((d) => d.signature === signature);
  const assignment: WallAssignment = {
    displaySignature: signature,
    displayLabel: known?.label ?? signature.split("|")[0],
    wallId: target.wallId,
    monitorId: target.monitorId,
    wallLabel: labelOf(target.wallLabel, "Wall"),
    monitorLabel: labelOf(target.monitorLabel, "Monitor"),
  };

  setWalls([...getWalls().filter((a) => a.displaySignature !== signature), assignment]);

  await applyAssignment(assignment);
  return readLayout();
}

/** Take a screen back — close its window and forget the assignment. */
export async function clearScreen(signature: string): Promise<ScreenLayout> {
  setWalls(getWalls().filter((a) => a.displaySignature !== signature));
  closeWallOn(signature);
  return readLayout();
}

/** Close every wall window WITHOUT forgetting anything.
 *
 *  Distinct from clearing, and both are wanted: an engineer who needs the panels
 *  back for half an hour is not asking to rebuild the layout afterwards. */
export async function closeAllWalls(): Promise<ScreenLayout> {
  closeAllWallWindows();
  return readLayout();
}

/** Open one assignment, if there is anything to open it on and anything to point
 *  it at.
 *
 *  Both failures are NORMAL STATES, not errors: a detached panel and an
 *  unconfigured console are conditions this product is expected to sit in. They
 *  are logged and reported back through ScreenLayout rather than thrown, so the
 *  panel can say which one it is. */
async function applyAssignment(a: WallAssignment): Promise<void> {
  const display = displayForSignature(a.displaySignature);
  if (!display) {
    log.info(`screen ${a.displaySignature} is assigned ${a.monitorLabel} but is not attached`);
    return;
  }

  const origin = await resolveConsoleOrigin();
  if (!origin) {
    log.info(`screen ${a.displaySignature} is assigned ${a.monitorLabel} but no console is configured`);
    return;
  }

  const url = wallDisplayUrl(origin, a.wallId, a.monitorId);
  if (!url) {
    log.warn(`stored assignment for ${a.displaySignature} has unusable ids; ignored`);
    return;
  }
  // The same allow-list every navigation goes through. A wall window carries the
  // preload bridge, so it gets no weaker a check than the console window does.
  if (!isAllowedConsoleUrl(url)) {
    log.warn("refused to open a wall window outside the allow-list:", url);
    return;
  }

  openWallOn(a.displaySignature, display.bounds, url, `${a.wallLabel} · ${a.monitorLabel}`);
}

/** Reopen the saved layout at startup.
 *
 *  Best effort by design: a detached panel or a server that is not answering yet
 *  must not stop the app coming up. Anything skipped is still saved and one click
 *  away in the panel. */
export async function restoreWalls(): Promise<void> {
  const assignments = getWalls();
  if (assignments.length === 0) return;

  const origin = await resolveConsoleOrigin();
  if (!origin) {
    log.info(`skipping ${assignments.length} saved screen(s): no console to open`);
    return;
  }

  for (const a of assignments) await applyAssignment(a);
}

// ── Reacting to the monitors changing under us ─────────────────────────────
//
// Control-room hardware gets unplugged, KVM-switched and woken from DPMS, and a
// wall window whose panel has gone away is a window stacked invisibly on top of
// another screen. Electron reports all three cases; this reconciles the layout
// with what is actually attached and tells the console, so an open settings panel
// updates instead of describing a machine that no longer exists.
//
// Debounced because one physical change fires several events — Windows emits
// metrics-changed per display as it reflows them — and reopening a wall window
// once per event would flash every panel.

let settle: NodeJS.Timeout | null = null;

function onDisplaysChanged(reason: string): void {
  if (settle) clearTimeout(settle);
  settle = setTimeout(() => {
    settle = null;
    void reconcile(reason);
  }, 750);
}

async function reconcile(reason: string): Promise<void> {
  log.info(`displays changed (${reason}) — reconciling the wall layout`);

  const attached = new Set(listDisplays().map((d) => d.signature));

  // A window on a screen that is gone: close it. The ASSIGNMENT stays, so
  // plugging the panel back in brings the wall back.
  for (const sig of openWallSignatures()) {
    if (!attached.has(sig)) {
      log.info(`screen ${sig} went away; closing its wall window, keeping the assignment`);
      closeWallOn(sig);
    }
  }

  // A screen that came back, or one whose geometry changed under a window that is
  // already up: applyAssignment moves and refits an existing window in place.
  for (const a of getWalls()) {
    if (attached.has(a.displaySignature)) await applyAssignment(a);
  }

  const win = getMainWindow();
  if (win) win.webContents.send(IPC.screensChangedEvent, await readLayout());
}

export function watchDisplays(): void {
  screen.on("display-added", () => onDisplaysChanged("added"));
  screen.on("display-removed", () => onDisplaysChanged("removed"));
  screen.on("display-metrics-changed", () => onDisplaysChanged("metrics"));
  log.info("watching displays for changes");
}

// ── Identify ───────────────────────────────────────────────────────────────
//
// The same gesture Windows' own display settings offers, for the same reason:
// "Display 2" means nothing standing in front of six identical panels, and
// without it the first assignment is a guess followed by a correction — on a wall
// people are watching. Flashes a big label on every screen for a few seconds.

const IDENTIFY_MS = 3_000;

export function identifyScreens(): void {
  for (const d of listDisplays()) {
    const html = identifyMarkup(d.label, `${d.bounds.width} × ${d.bounds.height}`);
    const win = new BrowserWindow({
      x: d.bounds.x,
      y: d.bounds.y,
      width: d.bounds.width,
      height: d.bounds.height,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      focusable: false,
      resizable: false,
      show: false,
      // ══ NO PRELOAD, DELIBERATELY ═════════════════════════════════════════
      //
      // This loads a data: URL. It is our own markup, with no network access and
      // nothing to say, and attaching the bridge would put the shell's entire IPC
      // surface behind a document type none of the navigation guards police.
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    // Clicks go through to whatever is underneath: this is an overlay on a
    // working wall, not a dialog to dismiss.
    win.setIgnoreMouseEvents(true);
    // showInactive, not show: identifying screens must not steal focus from the
    // console the operator is about to click in.
    win.once("ready-to-show", () => win.showInactive());
    void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    setTimeout(() => {
      if (!win.isDestroyed()) win.close();
    }, IDENTIFY_MS);
  }
  log.info("identify: flashed a label on every screen");
}

function identifyMarkup(label: string, resolution: string): string {
  // Escaped because `label` is an OS-supplied display name — a string from a
  // driver rather than from us.
  const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return [
    '<!doctype html><meta charset="utf-8"><style>',
    "html,body{margin:0;height:100%;background:transparent;overflow:hidden;",
    '  font-family:"Segoe UI",system-ui,sans-serif;-webkit-user-select:none}',
    ".card{position:absolute;inset:0;display:flex;flex-direction:column;",
    "  align-items:center;justify-content:center;gap:.35em;",
    "  background:rgba(5,8,15,.82);color:#f2f6ff}",
    ".n{font-size:11vmin;font-weight:700;letter-spacing:-.02em;color:#67e8f9;",
    "  text-shadow:0 0 40px rgba(103,232,249,.35);text-align:center;padding:0 6vmin}",
    ".r{font:500 2.6vmin/1 ui-monospace,Consolas,monospace;color:#9a92c8;",
    "  letter-spacing:.12em}",
    "</style>",
    `<div class="card"><div class="n">${esc(label)}</div>`,
    `<div class="r">${esc(resolution)}</div></div>`,
  ].join("");
}
