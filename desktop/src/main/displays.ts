import { screen } from "electron";
import type { DisplayInfo } from "@shared/ipc";

// The multi-monitor surface. An operator station drives 2–6 monitors, and P3's
// video wall opens a full-screen window on each chosen one. This module is the
// only place that touches Electron's screen API, so the mapping to the shared
// DisplayInfo shape stays in one spot.

/** A name for a monitor that survives a reboot.
 *
 *  ══ WHY NOT display.id ══════════════════════════════════════════════════════
 *
 *  Electron's display.id is stable for the life of a SESSION and no longer. On
 *  Windows it is derived from the device path and reassigned freely across a
 *  reboot, a driver update or an unplug — so a per-display layout keyed on it
 *  comes back after a restart pointing at the wrong monitor, or at no monitor,
 *  which for a two-screen station means the wall opens on top of the console.
 *
 *  The signature is the OS device name plus the resolution and scale. It is not a
 *  serial number and does not pretend to be: two identical monitors on
 *  \\.\DISPLAY1 and \\.\DISPLAY2 are told apart by the device name, and if
 *  somebody swaps the cables the layout follows the port rather than the panel.
 *  That is what an operator means by "the left-hand screen", and being
 *  occasionally wrong costs one click to move a window. */
export function displaySignature(d: Electron.Display, index: number): string {
  const name = d.label && d.label.trim() !== "" ? d.label.trim() : `display-${index + 1}`;
  return `${name}|${d.bounds.width}x${d.bounds.height}@${d.scaleFactor}`;
}

export function listDisplays(): DisplayInfo[] {
  const primaryId = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((d, i) => ({
    id: d.id,
    label: d.label && d.label.trim() !== "" ? d.label : `Display ${i + 1}`,
    primary: d.id === primaryId,
    bounds: d.bounds,
    scaleFactor: d.scaleFactor,
    signature: displaySignature(d, i),
  }));
}

/** The display a saved assignment refers to, or null when that monitor is not
 *  currently attached. Null is a normal answer, not an error: stations get taken
 *  apart, monitors die, somebody carries the box to a desk with one screen. The
 *  assignment is KEPT in that case, so plugging the screen back in restores the
 *  layout instead of silently discarding it. */
export function displayForSignature(signature: string): Electron.Display | null {
  const all = screen.getAllDisplays();
  return all.find((d, i) => displaySignature(d, i) === signature) ?? null;
}
