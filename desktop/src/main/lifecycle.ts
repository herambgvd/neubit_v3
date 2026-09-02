// Two flags about the app's own state, in their own module.
//
// This exists to break an import cycle rather than because the state is
// interesting. The main window HIDES instead of closing so the app survives in
// the tray (see window.ts), and the tray's Quit item has to be able to say "no,
// really close this time". If the flag lived in index.ts or tray.ts, window.ts
// would import from a module that already imports it, and the bundler would
// resolve one of the two to undefined at the moment it is read — a null-ish check
// that silently makes Quit hide the window forever.

let quitting = false;

/** True once a genuine quit is under way, so close handlers stop intercepting. */
export function isQuitting(): boolean {
  return quitting;
}

/** Mark the app as quitting. Called by the tray's Quit item and by the
 *  before-quit handler, so an OS-initiated shutdown behaves like a real quit
 *  rather than hiding a window nobody will ever see again. */
export function beginQuit(): void {
  quitting = true;
}

let trayActive = false;

export function setTrayActive(on: boolean): void {
  trayActive = on;
}

/** Whether a tray icon is up.
 *
 *  Also the honest answer to "does closing this window quit the app": with no
 *  tray there is nothing left to click, so closing must quit, and the UI must say
 *  so rather than trapping the operator in an app they cannot leave. */
export function isTrayActive(): boolean {
  return trayActive;
}
