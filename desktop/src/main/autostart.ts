import { app } from "electron";
import { log } from "./logger";

// Launch on login.
//
// ══ WHAT THIS DOES AND, MORE IMPORTANTLY, WHAT IT DOES NOT ═══════════════════
//
// It starts the DESKTOP APP at login. It has nothing to do with whether the box
// runs the VMS. On an appliance install the server is a Windows Service with
// automatic start, so it comes up at boot with nobody logged in at all — that is
// the entire point of the appliance shape, and it is true whether this setting is
// on or off. Confusing the two would be the expensive misunderstanding here: an
// operator who turns this off must not believe they have stopped the VMS.
//
// What it buys is that the console and the tray are THERE when someone sits down
// at the machine, instead of being a shortcut they have to find first.

/** The argument the login entry passes, so a launch at login can come up in the
 *  tray instead of throwing a window at somebody who is still logging in. */
export const HIDDEN_FLAG = "--hidden";

/** True when this process was started by the login entry rather than by a human
 *  double-clicking the icon. */
export function launchedHidden(): boolean {
  return process.argv.includes(HIDDEN_FLAG);
}

/** Whether this build can register a login item at all.
 *
 *  Unpackaged runs are excluded deliberately: process.execPath during `npm run
 *  dev` is node_modules\electron\dist\electron.exe, so honouring the toggle
 *  would register the Electron BINARY to launch at every login on the
 *  developer's machine — with no app, no window and no obvious way to work out
 *  what put it there. */
export function isAutoStartSupported(): boolean {
  return app.isPackaged && (process.platform === "win32" || process.platform === "darwin");
}

/** Whether the OS will actually launch this app at login.
 *
 *  The OS is read as the truth rather than our own stored preference, and the
 *  difference is not academic: Windows Settings › Startup apps can disable an
 *  entry behind the app's back. Reporting our stored intent there would show a
 *  ticked box for something Windows has switched off. executableWillLaunchAtLogin
 *  accounts for that approval state; openAtLogin only reports the Run key. */
export function autoStartEnabled(): boolean {
  if (!isAutoStartSupported()) return false;
  try {
    const settings = app.getLoginItemSettings({ path: process.execPath, args: [HIDDEN_FLAG] });
    if (process.platform === "win32") {
      return settings.executableWillLaunchAtLogin ?? settings.openAtLogin;
    }
    return settings.openAtLogin;
  } catch (e) {
    log.warn("could not read the login-item setting:", (e as Error).message);
    return false;
  }
}

/** Turn launch-at-login on or off. Returns the state the OS reports afterwards,
 *  which is what the UI should show — asking for it and assuming it took is how
 *  a checkbox ends up disagreeing with the machine. */
export function setAutoStartEnabled(on: boolean): boolean {
  if (!isAutoStartSupported()) return false;
  try {
    app.setLoginItemSettings({
      openAtLogin: on,
      path: process.execPath,
      args: [HIDDEN_FLAG],
    });
    log.info(`launch at login ${on ? "enabled" : "disabled"}`);
  } catch (e) {
    log.warn("could not write the login-item setting:", (e as Error).message);
  }
  return autoStartEnabled();
}
