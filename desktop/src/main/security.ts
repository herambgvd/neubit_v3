import { app, session, shell, type WebContents } from "electron";
import { URL } from "node:url";
import { allowedOrigins } from "./config";
import { log } from "./logger";

// The shell loads a REMOTE web console into a window that looks like a native
// application, so the security posture matters as much as it does for a browser.
// Every guard here fails closed: only loopback and the operator's own configured
// console origins may be navigated to or opened; everything else is refused and,
// if it is an external http(s) link, handed to the OS browser instead.
//
// Combined with the BrowserWindow webPreferences in window.ts — contextIsolation
// on, sandbox on, nodeIntegration off — this keeps the loaded web app from ever
// touching Node or the file system.

/** Hosts that are this machine talking to itself. An appliance install serves its
 *  console on loopback, so these must be trusted or the shell would refuse to load
 *  the very server the installer just put here. */
function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1";
}

function isAllowed(targetUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(targetUrl);
  } catch {
    return false;
  }

  // The bundled local renderer (the launcher) is always allowed.
  if (url.protocol === "file:") return true;

  // A console the operator configured.
  if (allowedOrigins().includes(url.origin)) return true;

  // This machine's own server.
  //
  // ══ WHY LOOPBACK AND NOT "ANY PRIVATE ADDRESS" ══════════════════════════════
  //
  // The NVR shell briefly trusted the whole RFC1918 range and that was a mistake
  // worth inheriting the lesson from rather than repeating. Trusting every private
  // address let the loaded console navigate this window — the window with the
  // preload bridge attached — to ANY host on the LAN. A link in the console, or an
  // open redirect, would then load a stranger's page inside the application frame,
  // wearing the application's chrome.
  //
  // A v3 server does need to be reachable at its LAN address as well as at
  // loopback; that is the entire product requirement. But the operator names that
  // address when they add the server, and allowedOrigins() covers it exactly. One
  // host, not sixteen million.
  if (url.protocol === "http:" || url.protocol === "https:") {
    if (isLoopbackHost(url.hostname)) return true;
  }

  return false;
}

/** Whether the shell may load this URL into one of its own windows. Exported so
 *  callers that OPEN windows use the same answer as the guards that police
 *  navigation — two allow-lists is one too many. */
export function isAllowedConsoleUrl(targetUrl: string): boolean {
  return isAllowed(targetUrl);
}

/** Attach navigation and window-open guards to a WebContents. Applied to every
 *  window the shell creates. */
export function hardenContents(contents: WebContents): void {
  // Block in-page navigation away from an allowed origin.
  contents.on("will-navigate", (event, targetUrl) => {
    if (!isAllowed(targetUrl)) {
      event.preventDefault();
      log.warn("blocked navigation to disallowed origin:", targetUrl);
    }
  });

  // window.open / target=_blank: allowed console origins open in-app; any other
  // http(s) link opens in the OS browser; everything else is denied.
  contents.setWindowOpenHandler(({ url }) => {
    if (isAllowed(url)) return { action: "allow" };
    if (/^https?:\/\//i.test(url)) {
      void shell.openExternal(url);
    } else {
      log.warn("denied window.open for:", url);
    }
    return { action: "deny" };
  });

  // Never allow a loaded page to attach a <webview>.
  contents.on("will-attach-webview", (event) => {
    event.preventDefault();
    log.warn("blocked <webview> attach");
  });

  // Deny permission requests by default — camera, microphone, geolocation and the
  // rest. The media the console renders is HTTP(S) video, which needs none of them.
  //
  // FULLSCREEN IS THE EXCEPTION, and leaving it out is a bug the browser makes
  // obvious: the console's full-screen button works in Chrome and does nothing at
  // all inside the app. Electron routes the HTML5 Fullscreen API through this same
  // handler, so a blanket deny silently swallows element.requestFullscreen() — no
  // error, no console message, just a button that does not respond. On a video wall
  // that is not a small thing.
  //
  // It is granted only to a page the shell would have navigated to anyway, which is
  // the same allow-list every other guard here uses. Fullscreen carries no data: it
  // cannot read anything, and the operator can always leave with Escape.
  contents.session.setPermissionRequestHandler((wc, permission, cb) => {
    if (permission === "fullscreen" && isAllowed(wc.getURL())) {
      cb(true);
      return;
    }
    log.info("permission denied:", permission);
    cb(false);
  });

  // NOT setPermissionCheckHandler. Installing one to add fullscreen there too would
  // replace Electron's default for EVERY synchronous permission check at once —
  // clipboard writes among them — and a deny-all with one exception is a much wider
  // change than this calls for. requestFullscreen() goes through the request handler
  // above; if a path is found that does not, it gets its own narrow allowance rather
  // than a blanket replacement.
}

/** Process-wide hardening, called once at startup before any window opens. */
export function installGlobalSecurity(): void {
  // A conservative CSP for the LOCAL renderer only. The v3 console ships its own
  // security headers from next.config.js and the gateway, and overriding them here
  // would be the shell second-guessing the app it is hosting.
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    if (details.url.startsWith("file://")) {
      cb({
        responseHeaders: {
          ...details.responseHeaders,
          "Content-Security-Policy": [
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
          ],
        },
      });
      return;
    }
    cb({ responseHeaders: details.responseHeaders });
  });

  // Blocks remote-debug ports unless a developer explicitly opts in.
  if (!app.commandLine.hasSwitch("remote-debugging-port")) {
    app.commandLine.appendSwitch("disable-features", "AutomationControlled");
  }
}
