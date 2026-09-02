# Neubit VMS — desktop shell

The Electron shell for the **neubit_v3** operator console. It loads the same web
console a browser loads, in a window this project controls, and adds the things a
browser tab cannot do.

> **This is P1 of [`docs/DESKTOP_APPLIANCE_PLAN.md`](../docs/DESKTOP_APPLIANCE_PLAN.md).**
> The shell only. The installer that also lays down the server is P2; the native
> video wall, multi-monitor assignment and PTZ HID are P3.

`neubit_nvr` has its own separate shell for its own separate product. This one
borrows its patterns — several of the comments here record lessons that cost that
project real time — but the two ship independently, with different `appId`s,
different installers and different licences.

## Run it

```bash
npm install          # once
npm run dev          # electron-vite dev, with HMR on the launcher
```

With the v3 stack up (`cd ../deploy && docker compose up -d`), the shell finds it
on loopback and goes straight into the console. To point a dev run somewhere else:

```bash
NEUBIT_CONSOLE_URL=http://192.168.1.10 npm run dev
```

### If the window never appears

`ELECTRON_RUN_AS_NODE=1` in the environment makes `require("electron")` return the
**binary path as a string** instead of the API, so `app` is `undefined` and the
first line that touches it throws. VS Code and other Electron-based editors export
it into their integrated terminals, so a `npm run dev` started from one inherits it
and dies with:

```
Unhandled TypeError: Cannot read properties of undefined (reading 'setAppUserModelId')
```

Clear it for the run:

```bash
env -u ELECTRON_RUN_AS_NODE npm run dev      # bash
$env:ELECTRON_RUN_AS_NODE=$null; npm run dev # PowerShell
```

Other useful scripts:

| | |
|---|---|
| `npm run typecheck` | `tsc --noEmit` over main/preload/shared and the renderer |
| `npm run build` | typecheck, then bundle to `out/` |
| `npm run package:win` | build, then an NSIS installer + a portable exe in `dist/` |

## The one rule worth knowing

**The shell loads the GATEWAY origin — port 80 — and refuses anything else.**

The console's API base is same-origin *relative*: `frontend/src/lib/api.js` resolves
`baseURL` to `/api/v1` so a single build runs on any host with no rebuild. Only
Traefik routes `/api` to core. Point the shell at the Next server's own port
instead and every page renders while every authenticated call 404s — which reads
as a broken backend and is not.

That is not hypothetical; it cost a debugging session, with a login on
`http://localhost:3000` answering *"Request failed with status code 404"* while
the identical credentials succeeded on `http://localhost`. So `normaliseConsoleUrl`
in [`src/shared/ipc.ts`](src/shared/ipc.ts) rejects `:3000`, `:8000` and `:3001`
with an explanation rather than leaving it a field somebody can get wrong at 2am.

## What the shell does at startup

1. Logging, then a single-instance lock — a second launch focuses the running window.
2. Security guards installed process-wide, before any window exists.
3. IPC, updater, tray.
4. The main window opens on the console's **`/login`** entry, not the bare origin.
   `/` on a v3 server is the public marketing page — "Command. Control.
   Intelligence.", a Book-a-Demo button — which is correct for a browser and absurd
   for an operator application. `/login` is right in both states: signed out it is
   the form, signed in the console bounces straight past it, so the shell never has
   to know whether a session exists.

   Which server, in order:
   - the console the operator explicitly chose, or
   - **this machine's own server**, if `http://localhost/health` answers — the home
     case after an appliance install: no picker, no URL to type, and
     nothing for the operator to know, or
   - the local launcher, so a workstation install can be pointed at a server on
     the network.

## `localhost`, not `127.0.0.1`

They are the same machine and not the same origin, and Next's dev server can tell:

```
Origin http://localhost   -> 200
Origin http://127.0.0.1   -> 403
```

`allowedDevOrigins` in `frontend/next.config.js` gates `/_next/*`, and the loopback
IP was not on the list. The failure is quiet and easy to misread — the SSR HTML
arrives so the login page's branding panel paints, the client bundle 403s so the
page never hydrates, and every mount-animated element including the sign-in card
stays at `opacity: 0`. What you see is half a login screen and no error anywhere.
That is exactly how the first run of this shell looked.

Both are allow-listed now, and `LOCAL_CONSOLE_URL` asks for `localhost` because it
is the name the dev server has always trusted.

## The app is resident

Closing the window does not quit. The tray icon stays, carrying the one fact
somebody glancing at the machine wants — whether the server is answering — plus
kiosk, launch-at-login and a way back to the console.

**Quitting from the tray does not stop the VMS.** On an appliance install the
server is a Windows Service with automatic start; it runs before any login and
survives every item in that menu. The menu says so in as many words, because the
alternative is somebody quitting the tray app to "turn the system off", walking
away, and the system recording for another month.

Where there is no system tray (some minimal Linux sessions), the shell notices and
closing genuinely quits — trapping an operator in an app they cannot leave would be
worse than the inconsistency.

## Security posture

The shell loads a remote web app into a window that looks native, so the posture
matters as much as a browser's. Every guard fails closed.

| | |
|---|---|
| Renderer | `contextIsolation` on, `sandbox` on, `nodeIntegration` off, `<webview>` blocked |
| Navigation | Only loopback and configured console origins. Everything else refused |
| `window.open` | Allowed origins in-app; other http(s) to the OS browser; the rest denied |
| Permissions | Deny-all, with **one** exception: fullscreen, for an already-allowed page |
| Bridge | The methods in `NeubitBridge` and nothing else |

**Not "any private address".** The NVR shell briefly trusted the whole RFC1918
range, which let the loaded console navigate the window *with the preload bridge
attached* to any host on the LAN. A v3 server does need to be reachable at its LAN
address — that is the product requirement — but the operator names that address
when they add the server, and the allow-list covers it exactly. One host, not
sixteen million.

**The shell never touches the session.** The console stores its JWT in
`localStorage` under `vizor.access`, exactly as it does in a browser, and the
bridge has no method that can read or write it. A shell that handled tokens would
be a second place to get authentication wrong.

## Fullscreen, and why it has its own note

`setPermissionRequestHandler` is deny-all *except* fullscreen. Electron routes the
HTML5 Fullscreen API through that handler, so a blanket deny silently swallows
`element.requestFullscreen()` — no error, no console message, just a button that
works in Chrome and does nothing in the app. It is granted only to a page the
shell would have navigated to anyway; fullscreen carries no data and Escape always
leaves.

It is deliberately **not** `setPermissionCheckHandler`. Installing one would
replace Electron's default for every synchronous permission check at once,
clipboard writes included — a much wider change than this needs.

## Layout

```
src/
  main/       Electron main process (Node)
    index.ts       entry — order of startup matters, see the comments
    window.ts      the main window AND the full-screen wall panels
    security.ts    navigation / window-open / permission guards
    config.ts      electron-store; servers + kiosk. Never a credential
    server.ts      "is there a working console at this origin?" (/health)
    tray.ts        the resident tray icon and its menu
    ipc.ts         every handler the bridge can reach, in one place
    displays.ts    monitor list + reboot-stable signatures
    screens.ts     which physical screen shows which wall monitor
    exports.ts     where a download goes on a machine that is not a browser
    autostart.ts   launch at login — the APP, not the server
    updater.ts     electron-updater wiring; the feed is P4
    lifecycle.ts   two flags, in their own module to break an import cycle
  preload/    the contextBridge — the only renderer↔main path
  renderer/   the local launcher (server picker). The real UI is remote
  shared/     the IPC contract, imported by main AND preload
build/        icons (from make-icons.py) + macOS entitlements
native/       the libVLC decode addon: a loader that answers "no", and the design
```

## Icons

`build/source-icon.png` is the brand asset and the only definition of the mark.
Everything else is derived from it:

```bash
cd build && python make-icons.py
```

Writes `icon.png` (1024, the master for macOS and Linux), `tray-icon.png` (512,
downsampled to 16px at runtime) and a multi-resolution `icon.ico` (16 - 256) for
the exe, the installer, the taskbar and the window. Hand-exported icons drift;
this cannot.

**Nothing is cropped or padded.** The source is a square whose lower third is the
UMS wordmark, so any crop to "tighten" the mark takes a bite out of that text.
Windows and macOS scale the square they are given rather than cropping it, so the
whole square goes in at every size.

The one honest limitation: at the 16px tray size the wordmark is not legible, on
any icon. What survives is the silhouette and the colour, which is what a 16px
icon is for. Cropping to the N alone would read better there and would mean two
different marks, so it is not done.

### If the app shows the Electron atom

A packaged app takes its taskbar icon from the exe, which electron-builder stamps
from `build/icon.ico`. **A dev run has no such exe** — it is Electron's own binary
— so `main/window.ts` sets `icon:` on every window explicitly. Without that, `npm
run dev` wears the default atom while the installed build looks correct, which is
a difference worth not having.

## The video wall — what the shell owns and what it must not

The shell binds a **physical screen** to a **monitor on a wall** and opens
`/wall-display/<wallId>/<monitorId>` full screen on it. That is all it does, and
the boundary is the important part.

The wall's *contents* are the server's. Which camera sits in which cell is one
shared JSON blob on the wall row, pushed to every client over SSE, so a camera
dropped on the console appears on every panel — including panels driven by a
different workstation. A shell that cached that locally would be a second wall
quietly disagreeing with the first, and it would surface as "the wall is showing
the wrong camera".

The shell also never lists walls. It cannot: the wall API is authed and the
session belongs to the console. **The console picks** — it has the data, the
permissions and the token — and hands the shell two ids. The shell builds the URL
itself from the active server, so a page cannot use a full-screen window to load
somewhere else, and it refuses any id that is not a plain path segment.

Assignment lives in the wall console's toolbar (`Screens`), which renders nothing
at all in a browser. The tray carries the two things the shell can answer alone:
**Identify screens**, and **close the panels without forgetting the layout**.

Escape closes a panel. It has no title bar, so without that an engineer at a wall
panel has no way out but the tray — verified with a real Windows key event, not
just an injected one, because `before-input-event` is a browser-process hook that
CDP-injected keys bypass entirely.

## Exports

With no folder set, nothing here intervenes: Electron shows its own Save dialog.
Set one from the tray and downloads go straight there, under the name the console
chose, with `name (2).ext` on a collision — exports repeat, and overwriting the
first one is the kind of failure nobody notices until it cannot be undone.

Every export in v3 is an axios blob, a `createObjectURL` and a synthetic
`<a download>` click — `will-download` fires for those, which was verified rather
than assumed.

> **If you test this with Playwright, it will look broken.** Playwright sets
> `Browser.setDownloadBehavior` to its own artifacts directory the moment it
> attaches, so the file never reaches the folder while Electron still reports the
> download as completed with the right `savePath`. Send
> `Browser.setDownloadBehavior { behavior: "default" }` over a CDP session first.

## Joystick / PTZ — nothing to build here

The Gamepad API is present, permitted and in a secure context inside the shell
(`document.featurePolicy.allowsFeature("gamepad")` → true on a console page), and
it is the *same* API in Chrome. So a PTZ joystick belongs in the console, driving
the `/cameras/{id}/ptz/move` continuous mode that already exists — where a browser
operator gets it too.

A native HID module in the shell would buy only one thing, input while the console
window is unfocused, in exchange for a native dependency and a feature that exists
on desktop and not on web. That trade is the wrong way round for this product.

## Not done yet

- **The native libVLC wall.** Not built, and not to be started before the
  measurement in [`native/README.md`](native/README.md) is run on real cameras.
  The recorder's hand-off promised design notes and shipped none; that file is
  the replacement.
- **P4** — code signing and the update feed. Both are shared decisions with
  `neubit_nvr`; see the plan's open decisions.
