# Neubit v3 — Desktop Appliance Plan

> Status: **P0–P3 done (2026-08-27).** Route B proven, four defects found and fixed, the
> Electron shell signs in, the installer builds, and the wall now spans the monitors on an
> operator's desk. Only P4 — code signing and the update feed — is open. See
> [P0 status](#p0-status-2026-08-27) at the end of §5.
> Companion: `neubit_nvr/docs/DESKTOP_APPLIANCE_PLAN.md` — the same problem solved
> for the recorder, shipped and installed. This plan reuses its topology and its
> tooling, and diverges only where v3's runtime genuinely differs.

---

## 0. The requirement

One installer, run once on a Windows server, must produce:

1. **The v3 server**, supervised, auto-starting, running with no user logged in.
2. **The web console**, reachable from any LAN browser at `http://<host>`.
3. **The desktop app**, on that machine or any operator workstation, showing the
   *same* console.

And the binding constraint, stated by the product owner:

> "abhi jo bhi functionality neubit_v3 localhost pe run ho raha, waise hi desktop
> application mein run hoga."

Feature parity between web and desktop is not negotiable and not a workstream —
see §2, where it falls out of the topology for free.

**neubit_nvr and neubit_v3 are separate products.** Separate installers, separate
`appId`, separate update feeds, separate licences. The NVR is a recorder; v3 is
the VMS. This plan borrows the NVR's *patterns and scripts*, never its identity.

---

## 1. Decision

| | |
|---|---|
| Shell | **Electron** (`electron-vite` + `electron-builder` + `electron-updater`) |
| Server payload | **Bundled container runtime** (Route B, §4) for v1; native supervisor (Route A) kept open for hardened/OEM builds |
| Location | New `neubit_v3/desktop/` — its own product |

### Electron, not Wails — and the docs must be corrected

[`docs/ARCHITECTURE.md` §15](ARCHITECTURE.md) still recommends **Wails**, with
Electron as "the fallback", and [`README.md`](../README.md) calls `frontend/`
"also the Wails desktop UI". Both predate the working Electron shell in
`neubit_nvr/desktop`. The decision inverts, for one reason that §15 itself
anticipates:

> "**Caveat:** a very dense local video wall (many simultaneous GPU-decoded
> streams) can stress a webview. […] if a heavy native video wall is later
> required, add a native video-render layer behind the same UI."

That native video-render layer is now **required** in v3 — the NVR's own roadmap
records the hand-off:

> "Moved to the VMS (`neubit_v3`) […]: the native `libVLC` decode addon, the dense
> video wall and joystick/PTZ HID."

Wails renders in the OS webview (WebView2 / WKWebView). It has no native-addon
surface to hang a GPU decode path off. Electron has N-API + `cmake-js`, which is
exactly how `neubit_nvr/desktop/native/` is scaffolded. The requirement that §15
listed as hypothetical has arrived, so §15's own conditional resolves to Electron.

**Action: done (2026-08-27).** `ARCHITECTURE.md` §15, its decision table, decision 5 and
`README.md`'s tree now say Electron. §15 keeps the old caveat visible and records what
reversed it, rather than quietly editing it away, so nobody re-opens the question from the
old text.

---

## 2. Target architecture

```
Windows host
|
+-- Neubit VMS Service          (auto-start, no login required)
|   |   supervisor  --  the docker-compose replacement
|   +-- gateway      :80          Traefik   -- /api -> core, / -> frontend
|   +-- postgres     127.0.0.1:5432
|   +-- redis        127.0.0.1:6379          Celery broker
|   +-- nats         127.0.0.1:4222          JetStream event spine
|   +-- core         127.0.0.1:8000          control plane
|   +-- ingest / vision / access / workflow  satellites
|   +-- workflow-worker + workflow-beat      Celery
|   +-- ops-agent
|   +-- frontend        node server.js       Next standalone
|   +-- admin-frontend  node server.js       Next standalone
|   +-- tiles                                offline pmtiles
|
+-- Neubit VMS.exe              (Electron -- optional, per-user)
|   +-- loads http://127.0.0.1   + a desktop-only service panel
|
+-- Any LAN browser  ->  http://<host-lan-ip>   <- same console, same sessions
```

### Why parity is free

`frontend/src/lib/api.js:12` resolves its API base as:

```js
const BASE = process.env.NEXT_PUBLIC_API_URL || "";   // -> baseURL "/api/v1"
```

Same-origin and relative, deliberately — the comment in that file says one build
must run "on ANY IP/host with no rebuild". Traefik then routes `/api` to core and
`/` to the frontend.

So the Electron window pointed at `http://127.0.0.1` and a LAN browser pointed at
`http://192.168.1.x` load **byte-identical JavaScript that resolves its own API
base from `window.location`**. There is no desktop build of the UI, no desktop API
base, no feature flag. Parity cannot drift because there is only one artifact.

> This is also why login failed on `http://localhost:3000` and worked on
> `http://localhost` — `:3000` bypasses the gateway, so `/api/v1/*` hits Next.js,
> which has no such route, and every authed call 404s. **The shell must always
> load the gateway origin, never the Next port.** Hard-code that; do not let it
> become an operator-configurable field.

### Why a service, not an Electron child process

The event spine, the recorders' health polling, workflow schedules and Celery beat
must keep running when the operator closes the window, logs out, or never logs in.
Compose gave us `restart: unless-stopped` and health-gated ordering; a Windows
Service plus a supervisor gives the same guarantees. The Electron app is a **client
of localhost that can also start, stop and diagnose the service** — that panel is
the only reason the desktop app has a job on the server box itself.

---

## 3. Evidence — what v3 actually needs to run

Checked against the working tree and the running stack, not assumed.

### Already appliance-ready

| Fact | Evidence |
|---|---|
| Both Next apps build to a standalone Node server | `output: "standalone"` in `frontend/next.config.js` and `admin-frontend/next.config.js` |
| The UI is host-agnostic — no hostname is ever baked in | `frontend/src/lib/api.js:12` |
| **TimescaleDB is NOT load-bearing** | `create_hypertable` is defined in `backend/core/app/db/timeseries.py` and called by **no** migration. Stock Postgres suffices; the `timescale/timescaledb` image is currently belt-and-braces |
| Gateway is a single static Go binary | `traefik:v3.1`, official `windows_amd64` release |
| Event spine is a single static Go binary | `nats:2.10-alpine`, official Windows release; JetStream is `-js -sd <dir>` either way |
| Python deps are all pure-python or have Windows wheels | `asyncpg`, `cryptography`, `argon2-cffi`, `lxml`, `onvif-zeep`, `reportlab`, `boto3`, `Pillow` — no source builds needed |
| The NVR's appliance tooling is reusable as-is | `neubit_nvr/deploy/windows/` — `binaries.json`, `fetch-binaries.ps1`, `install-appliance.ps1`, `uninstall-appliance.ps1`; already fetches Postgres 17 portable binaries and `node.exe` |

### Needs work — the real friction

| Area | Problem | Way out |
|---|---|---|
| **Redis** | No official Windows build. It is load-bearing: `backend/workflow/app/worker.py` runs Celery on `VE_REDIS_URL` | Valkey's Windows port, or Memurai (commercial licence), or move the broker to Postgres/NATS JetStream. **Decide in P0** |
| **Celery on Windows** | The `prefork` pool does not work on Windows; `workflow-worker` would need `--pool=solo` or `threads`, changing concurrency behaviour | Route B avoids this entirely (worker stays on Linux). Route A must re-validate worker throughput |
| **Five Python services** | No system Python on a customer server | Embeddable CPython + one shared venv per service, or PyInstaller one-dirs. Adds ~1.2 GB and a per-release freeze step |
| **`tiles`** | nginx image serving `planet.pmtiles` | Trivial: Traefik can serve the file, or a small Go static server |
| **Data directory** | Compose uses named volumes (`pgdata`, `recordings`, `corefiles`) | Must become real paths under the install drive. The NVR solved this — see its "Where the data lives — it follows the install drive" section |

---

## 4. The payload: two routes, and why we start with B

The Electron shell is the easy half — it is a known, shipped quantity. The hard
half is **what the installer lays down as the server**, because v3 is 15 processes
where the NVR was one Go binary.

### Route A — native supervisor (what the NVR did)

Every service becomes a Windows-native process under our own supervisor. No
container runtime on the customer's machine.

- **For:** smallest install, no virtualization dependency, works on hardened and
  air-gapped servers, no third-party licence surface, fastest cold start.
- **Against:** all fifteen services must be ported and then *kept* ported. Two
  deployment shapes (compose on Linux, supervisor on Windows) drift; a change that
  works in dev can break the appliance silently. Redis and Celery-on-Windows are
  unsolved. Realistically a quarter of work before the first install.

### Route B — bundled container runtime  ← **recommended for v1**

The installer ships a private WSL2 distro with a container engine inside it, and
runs **the same `deploy/docker-compose.yml` that runs today**.

- **For:** the requirement in §0 is satisfied *by construction* — the appliance
  runs the identical images, so "jo localhost pe chal raha hai" is not a parity
  goal, it is literally the same artifact. Redis, Celery and the Python services
  need zero porting. First install in weeks, not a quarter.
- **Against:** requires WSL2 (Windows 10 2004+ / Server 2022, virtualization enabled
  in BIOS); a WSL layer to diagnose when something breaks. Size is **measured, not
  feared**: 1420 MB of images (gzip) + 3674 MB of offline basemap + 80 MB rootfs
  ≈ **5.3 GB**, or **~1.6 GB with the basemap made optional**. Cold boot to
  `/health` green: **93 s** on a spinning disk.
- **Licence note:** ship a **private distro running `dockerd` or Podman**, never
  Docker Desktop — Docker Desktop needs a paid subscription for a company our size
  and may not be redistributed. The engine must be invisible to the operator.

### Recommendation

**Ship B, keep A on the roadmap.** B gets a real product in front of customers this
quarter with parity guaranteed rather than maintained. A becomes the hardened/OEM
build later, and by then the NVR's supervisor, `binaries.json` fetcher and
install/uninstall scripts will have another year of field use behind them.

If a specific customer forbids WSL2, that is the trigger to fund A — not a reason
to start with it.

---

## 5. Phases

### P0 — Prove the payload · size S · **do this first**

A spike, not a product. Answers the questions that change everything downstream.

1. Stand up the full compose stack inside a **private WSL2 distro** (no Docker
   Desktop) on a clean Windows box. Measure: image set size, cold-boot time to
   `/health` green, idle RAM.
2. Register that as a **Windows Service** and confirm it survives logout + reboot
   with no user session.
3. Decide the **Redis question** — needed for both routes eventually.
4. Confirm a LAN browser reaches `http://<host>` and can log in.

**Exit:** a Windows box where the stack auto-starts on boot and the console works
from another machine's browser. No installer, no Electron yet.

### P1 — The Electron shell · size M

New `neubit_v3/desktop/`. Reuse from `neubit_nvr/desktop/` — as a **reference to
port, not a dependency to share**:

| Take | File(s) | Note |
|---|---|---|
| ✅ | `main/window.ts`, `lifecycle.ts`, `logger.ts`, `displays.ts` | product-agnostic |
| ✅ | `main/security.ts` | navigation + new-window origin allow-list |
| ✅ | `main/config.ts` | `electron-store`; **keep the lazy-init + explicit `cwd`** — that file's own comment records the four commits it cost to learn |
| ✅ | `main/tray.ts`, `autostart.ts`, `updater.ts` | |
| ✅ | `electron.vite.config.ts`, `electron-builder.yml`, `build/` | rebrand appId / product / icons |
| ❌ | `main/appliance.ts` | NVR-specific: supervises `neubitsvc.exe` via the SCM. v3 needs its own, against the v3 supervisor |
| ❌ | `kind: "nvr" \| "command-center"` in `shared/ipc.ts` | leftover from when one shell was to serve both products. v3's shell serves v3 |

New in v3:

- **Server picker** defaulting to `http://127.0.0.1` when the local service is
  present; otherwise first run asks for the server address. Gateway origin only.
- **Session hand-off** — the console stores its JWT in `localStorage` under
  `vizor.access` (`frontend/src/lib/api.js:14`). The shell must not touch it; the
  web console owns the session exactly as in a browser.

**Exit:** `npm run dev` opens a window on the running stack and the operator can log
in and use every screen that works in Chrome today.

#### P1 status (2026-08-27) ✅

`neubit_v3/desktop/` exists and works. `npm run start` opens a window, finds the
server on loopback, loads the console and an operator signs in — the phase's exit
criterion, verified by driving the real window rather than by reasoning about it.

Ported from `neubit_nvr/desktop/` as planned: window, lifecycle, logger, displays,
security, config, tray, autostart, updater, and the whole electron-vite /
electron-builder setup. Dropped as planned: `appliance.ts` and the
`kind: "nvr" | "command-center"` union. New for v3: `server.ts` (a `/health` probe
standing in for the NVR's service supervision until P2 registers something to
supervise), the server picker, and `normaliseConsoleUrl`.

**Three things the build found that reasoning had not:**

1. **`/` is the marketing page.** The first run opened on "Command. Control.
   Intelligence." with a Book-a-Demo button — correct for a browser arriving at the
   address, absurd for an operator application. The shell now loads `/login`, which
   is right in both states: signed out it is the form, signed in the console bounces
   straight past it, so the shell never has to know whether a session exists.
2. **`localhost` and `127.0.0.1` are not interchangeable.** Next's dev server gates
   `/_next/*` on `allowedDevOrigins`, and the loopback IP was not listed:
   `Origin: http://localhost` → 200, `Origin: http://127.0.0.1` → **403**. The
   failure is quiet — SSR HTML arrives so the branding panel paints, the client
   bundle 403s so the page never hydrates, and the mount-animated sign-in card stays
   at `opacity: 0`. Half a login screen, no error anywhere. `frontend/next.config.js`
   now allow-lists both; the shell asks for `localhost`.
3. **`ELECTRON_RUN_AS_NODE=1` is inherited from VS Code.** In that mode
   `require("electron")` returns the binary path as a string rather than the API, so
   `app` is undefined and startup throws on the first line that touches it. Anyone
   running `npm run dev` from an editor terminal hits it; the README says how to
   clear it.

**Deferred to P3 with the video wall, as planned:** `screens.ts` (per-monitor wall
assignment) and `exports.ts`. `displays.ts` is already in place and provides the
reboot-stable monitor signatures those will key off.

**Not wired, deliberately:** `electron-builder.yml` carries no `publish` block. The
NVR's still points at `updates.example.com` and has never worked; an absent feed
makes `checkForUpdates` report "no feed" honestly instead of failing against a host
that does not exist. Filling it in is P4, and it is one decision for both products.

---

### P2 — The installer · size L

One `.exe` that does §0.1–§0.3.

- Stage the payload (Route B: the distro tarball + image set) — mirrors the NVR's
  `build-appliance.ps1` → `dist/appliance/` → `electron-builder` `extraResources`.
- `install-appliance.ps1` equivalent: register the service, generate config, create
  the data directory **on the install drive**, open the firewall for `:80`.
- **First-run setup**: bootstrap admin, and a recovery path. The NVR's
  `deploy/windows/install-appliance.ps1` and its "first-run setup" section are the
  template.
- Uninstall that actually removes the service, the distro and (on confirmation) the
  data.
- Upgrade path. The NVR hit two hard walls here — "The in-place upgrade could not
  work" and "Every upgrade failed on Access is denied". **Read those two sections
  before writing a line of the upgrade code.**

**Exit:** clean Windows VM, run the exe, reboot, browse from another machine, log in.

#### P2 status (2026-08-27) ✅ — with one thing deliberately not built

`deploy/windows/` holds the server half; `desktop/build/installer.nsh` wires it into
the same installer as the shell. `npm run package:win` produces **Neubit VMS Setup
0.1.0-x64.exe** (82 MB) and **Neubit VMS Portable 0.1.0-x64.exe**.

| | |
|---|---|
| `build-appliance.ps1` | build machine — bakes the distro tarball, engine and every release image already inside |
| `install-appliance.ps1` | customer machine, elevated — imports as SYSTEM, wires storage, opens the firewall, registers the boot task |
| `uninstall-appliance.ps1` | undoes it; keeps the data unless told otherwise |
| `probe-system-wsl.ps1` | verifies a candidate box **before** installing on it |
| `appliance/wsl.conf`, `boot.sh`, `docker-compose.appliance.yml` | what lives inside the distro |

### The design, and what forced it

**Windows does exactly one thing: start the distro at boot.** `/etc/wsl.conf`'s
`[boot] command=` runs `boot.sh` inside the distro, which starts the engine and the
stack. So there is no long-running Windows-side process to supervise, which is why
this is a scheduled task rather than a service — a service wrapper would be an
executable to write, sign and maintain for the sake of one command.

**Everything runs as SYSTEM.** WSL distros are registered per-user under
`HKCU\...\Lxss`, so a distro imported by the administrator running the installer is
invisible to SYSTEM — the account a boot task runs under. Get that wrong and the
appliance works beautifully until the first reboot and then never starts again with
nobody signed in, which is precisely the property the product is sold on. The import,
the boot task and the `.wslconfig` therefore all live in SYSTEM's context, via a
throwaway scheduled task (built in; no PsExec to redistribute).

**One dockerd launcher, used at bake time and at run time.** P0's nastiest finding
was an engine reporting `images=0` with 8.1 GB in `/var/lib/docker`, because a bare
`dockerd` and systemd's `docker.service` bring up different containerd instances and
therefore different image stores. `wsl.conf` sets `systemd=false` and `boot.sh` is
the only place `dockerd` starts — and `build-appliance.ps1` bakes the images by
calling that same script, so the store the pipeline writes to *is* the store the
appliance reads from.

**Both firewall gates.** Mirrored networking is necessary and not sufficient:
`Get-NetFirewallHyperVVMSetting` defaults to `DefaultInboundAction: Block`, which
presents as a server that is up and unreachable with nothing in any log mentioning a
firewall. The installer opens the Hyper-V rule and the ordinary Windows Firewall rule.

**The NVR's upgrade post-mortems, applied before they could repeat.** `Stop-Appliance`
runs first, before the port check and before anything is written, so the appliance
cannot report itself as the port conflict; and `customInit` — which runs in
`.onInit`, before NSIS extracts a byte — stops it again. Neither is redundant: a
hand-run upgrade never goes through NSIS at all.

### Verified, not assumed

* All four PowerShell scripts parse. They needed a **UTF-8 BOM** to do it: Windows
  PowerShell 5.1 reads a BOM-less `.ps1` as ANSI, and an em-dash inside a
  double-quoted string then decodes to bytes that close the string early. Two scripts
  failed to parse until the BOM was added.
* The appliance overlay merges cleanly: no `build:` survives, every image is
  version-pinned, and **only `:80` is published**.
* The installer builds, and the client-only path works — electron-builder logged
  `file source doesn't exist from=...\distppliance` and carried on, which is the
  supported shape for an operator workstation.

> **Superseded 2026-08-27 by building the payload for real.** The appliance was
> `extraResources` in `electron-builder.yml` — embedded in the exe — and that
> **cannot work at this size**. `makensis` is 32-bit and memory-maps the blob it
> embeds; a 2.9 GB payload fails with `File: failed creating mmap`, at the last step,
> after 172 s of work. The payload now travels **beside** the installer and
> `build/installer.nsh` looks for `$EXEDIRppliance\`. The one-installer-two-shapes
> property is unchanged, and beside-the-installer suits air-gapped delivery better
> than embedding did.
* `installer.nsh` really is compiled in. Proven by deliberately breaking it and
  watching the build fail with `!include: error in script: ...installer.nsh`, rather
  than by assuming an included file is an executed one.

### A defect the build found in the config

`artifactName` at the `win:` level looked right and **silently lost a build**: nsis
and portable both emit `.exe`, so they resolved to the same filename and the second
one written won. The first run produced exactly one file in `dist/` — the portable,
wearing the installer's name. Now set per target.

### Not built, and said plainly

**In-place upgrade.** The database lives in named volumes *inside* the distro's
virtual disk, so replacing the distro discards it. The export/import dance that would
preserve it has not been written or tested, and the NVR's two post-mortems are the
argument for not guessing. The installer refuses an upgrade with a message saying so
and pointing at `uninstall-appliance.ps1 -KeepData`.

**The offline basemap is not in the payload.** At 3.7 GB it is larger than every
container image combined. It ships as a separate optional download into
`<BulkDir>\tiles\`.

> **Sizes corrected 2026-08-27**, when the payload was built for the first time.
> The figures above came from P0's *image* measurement and were the wrong artifact:
> `docker save` produces 1,367 MB, but the distro stores those layers **extracted**,
> so the exported filesystem is **5,728 MB** and the gzipped payload is
> **2,927 MB** — a release is 3.0 GB, not 1.6 GB. See the P3 build notes.

### Still open

**A real reboot.** Every mechanism is verified except the last mile: that the boot
task fires after a restart with nobody signed in. Only a reboot proves that, and it
was not performed on the developer's machine. `probe-system-wsl.ps1` answers
everything up to that point on any candidate box, elevated, and says in its own
output what it cannot prove.

---

### P3 — Desktop-only capabilities · size M

The reason a desktop app exists at all. A browser cannot do these.

1. **Native video wall** — `native/` addon, libVLC via `cmake-js`, GPU decode
   composited over the webview, bypassing Chromium. Straight from the NVR hand-off.
2. **Multi-monitor wall assignment** — the NVR's `screens.ts` / `WallAssignment`
   model ports directly; v3's `frontend/src/features/videowall/` is the UI side.
3. **Joystick / PTZ HID** — the other half of the hand-off.
4. **Local export** to a chosen folder, kiosk mode, launch-at-login — all ported.

#### P3 status (2026-08-27) — 2 and 4 built and driven; 3 answered; 1 designed, not built

**The wall now spans the monitors on a desk.** `desktop/src/main/screens.ts` binds a physical
screen to a monitor on a wall and opens the console's own kiosk route full screen on it;
`exports.ts` sends downloads to a folder the operator chose. Both were verified by driving
the real shell over CDP, not by reasoning about them.

##### The design decision that made item 2 smaller and better than planned

The NVR's `screens.ts` assigns a **path** (`/live`, `/playback`, `/events`) to a monitor,
because the recorder has no server-side notion of a wall. v3 does: a wall holds monitors,
each monitor carries its own 1/4/9/16 layout, and the live camera-to-cell assignment is a
single shared blob pushed to every client over SSE
(`backend/vision/app/vms/models/videowall.py`). The console already renders one monitor at
`/wall-display/<wallId>/<monitorId>`, deliberately outside the `(app)` chrome, for exactly
this purpose.

So v3 binds a screen to a **wall monitor**, not to a path — and the wall's contents stay the
server's, shared with every other operator and every other display client. A shell holding
its own camera-to-cell state would be a second wall quietly disagreeing with the first.

The corollary is the security split, and it is the part worth reading twice. **The shell
never lists walls** — it cannot, because the wall API is authed and the session belongs to
the console. The console picks (it has the data, the permissions and the token) and hands the
shell two ids. **The shell builds the URL itself from the active server**, so a page cannot
use a full-screen window to load somewhere else, and it refuses any id that is not a plain
path segment. The one domain rule the shell cannot enforce — that a `decoder` monitor is fed
by hardware and must never be put on a desk panel — lives in the console, where `kind` is
readable. Structure is the shell's; meaning is the console's.

##### Verified by driving the real shell

Two real monitors on the dev box: the laptop panel (1536×864 @1.25) and a BenQ GW2490
(1920×1080 @1, at x=1536, y=-216).

| | |
|---|---|
| Panel opened on the intended glass | `screenX=1536 screenY=-216 1920×1080` — **exact match**, taskbar covered |
| Session inherited by the panel | **the same `vizor.access` token** as the console window, with the shell never touching it |
| Layout survives a restart | **both panels reopened** on relaunch, on the right screens |
| Escape closes a panel, keeps the layout | yes — see the note below on how that had to be tested |
| `clearScreen` | closes the panel *and* forgets it; distinct from closing, and both are wanted |
| A traversal id (`../../evil`) | **refused**, existing assignment untouched |
| Export to a chosen folder | written under the console's own name, spaces and hyphen intact |
| A repeat export | `North gate-3f9a (2).mp4` — the collision path, exercised |
| `nativeWallAvailable` | `false`, honestly |

##### Two things the driving found that reasoning would not have

1. **Playwright eats downloads.** The export folder stayed empty while Electron logged
   `export finished` with the right path, on two different drives. Playwright sets
   `Browser.setDownloadBehavior` to its own artifacts directory the moment it attaches, so
   the bytes never reached the folder — the product was correct and the harness was lying.
   Send `Browser.setDownloadBehavior { behavior: "default" }` first and the file appears.
2. **CDP-injected keys never reach `before-input-event`.** Playwright's `keyboard.press`
   dispatches into the renderer; `before-input-event` is a browser-process hook. Escape
   looked broken and was not. Proving it needed a real Windows key event —
   `WindowFromPoint` at the centre of the panel, `SetForegroundWindow`, `SendKeys {ESC}` —
   after which the panel closed and the assignment stayed. Worth remembering for anything
   else in the shell that hangs off a native input hook.

##### Item 3 — joystick / PTZ: nothing to build in the shell

Measured inside the shell, on a console page: `navigator.getGamepads` is present,
`document.featurePolicy.allowsFeature("gamepad")` is **true**, and the page is a secure
context. It is the same API in Chrome.

So a PTZ joystick belongs in the **console**, driving the continuous-mode
`POST /cameras/{id}/ptz/move` that already exists — where a browser operator gets it too. A
native HID module in the shell would buy exactly one thing, input while the console window is
unfocused, in exchange for a native dependency and a capability that exists on desktop and
not on web. For a product whose central property is that there is one console, that trade is
the wrong way round.

**Not written, deliberately:** the console-side hook. There is no joystick on this machine,
and shipping an untested PTZ driver into the live operator console is worse than shipping
nothing. It is a small, self-contained piece of work for whoever has the hardware.

##### Item 1 — the native wall: designed, not built, and the hand-off was empty

`desktop/native/README.md` is the design. It had to be written from v3's own code, because
the recorder's hand-off promised design notes it does not contain: its `native/README.md`
says "the design notes below are kept verbatim as the starting point for whoever implements
it in `neubit_v3`" and then simply ends.

The design's three findings:

* **The strongest argument for the addon is a SERVER cost, not a client one.** LivePlayer is
  WHEP-first, and MediaMTX **returns 400 for HEVC over WHEP**, so the console retries against
  a `/h264` variant that MediaMTX produces by **running ffmpeg on demand**. Every HEVC camera
  a Chromium client watches is a transcode on the recorder — the server's CPU scales with the
  number of people watching. libVLC decodes HEVC directly, on the client GPU.
* **Compose a whole PANEL natively, not tiles over the DOM.** A native child HWND per tile is
  always on top of the web content and is not clipped by DOM stacking, so every overlay the
  console draws over a cell would vanish behind the video. But a wall panel *has* no overlays
  — it is read-only by design — and `screens.ts` already produces exactly the right
  container. Frames back into the renderer as WebGL textures is the tidy answer that does not
  survive arithmetic: 16 tiles of 1080p30 in NV12 is roughly 1.5 GB/s of memcpy.
* **The measurement has not been run, and must come first.** The dev stack has **zero
  cameras**, so there was nothing to measure. The tile count at which Chromium starts
  dropping frames on the customer's real streams is the whole decision. If it sits
  comfortably above the densest panel anyone buys, the addon is not worth its maintenance and
  that file should say so.

There is also a way to make the addon unnecessary: transcode HEVC **once at ingest** in
`neubit_nvr` instead of once per watching client. That costs storage or a second recorded
profile, and it is worth costing before committing to a C++ addon here.

##### A serious defect found on the way — in the DEV STACK only

**Every route inside a parenthesised route group 404s on the frontend dev server.** `/home`,
`/streaming`, `/map`, `/events`, `/wall/<id>` — all 404, in ~100 ms with application code
running, and no error in any log. Top-level routes (`/`, `/login`, `/impersonate`) are fine.

The source is not at fault: the same tree built into the **production image serves every one
of them with 200** — verified by running `neubit-v3-frontend:latest` as a throwaway container
on the compose network. It is Next 16 + Turbopack on the Windows bind mount;
`WATCHPACK_POLLING` in the dev override is a webpack knob and Turbopack ignores it.

Not a P3 problem and not caused by P3, but it means **the authenticated console cannot be
opened in dev at all**, which is worth fixing before the next piece of UI work.

##### What the operator actually sees

* **In the wall console's toolbar: `Screens`.** This workstation's monitors, what each is
  showing, and a per-screen picker of this wall's monitors. `Identify` flashes a label on
  every panel the way Windows' display settings does — "Display 2" means nothing standing in
  front of six identical screens. Screens that are not plugged in are listed as such rather
  than dropped, because stations get taken apart and an operator who plugs a panel back in
  expects their wall, not a blank slate.
* **In a browser: nothing.** `frontend/src/lib/desktop.js` gates the whole surface on
  `window.neubit` and carries the rule in its header — every desktop capability is
  *additive*, never a change to existing behaviour, because the moment behaviour forks there
  are two consoles to keep in step.
* **In the tray:** where exports go, and the two wall things the shell can answer without a
  session — identify, and close the panels while keeping the layout.

### P4 — Release engineering · size M

- **Code signing — DEFERRED (product owner, 2026-08-27).** Builds ship unsigned for
  now. Nothing in `electron-builder.yml` changes when a certificate arrives — it is
  read from `CSC_LINK` / `CSC_KEY_PASSWORD` in the environment — so this is a purchase
  and a CI change, not a code change. Two consequences are live from today, and are
  written down where they will be found rather than in a decision log:
  - **SmartScreen.** The installer asks for elevation, so a customer sees "Windows
    protected your PC" and must click *More info → Run anyway*. The exact click path,
    and the managed-environment case where that button is removed by policy, are in
    `deploy/windows/README.md`.
  - **Auto-update will refuse to install.** `nsis.verifyUpdateCodeSignature` defaults
    to **true**, and electron-updater checks the downloaded update's publisher name
    against its signature before running it — which cannot pass for an unsigned build.
    The update downloads and then does nothing, silently. Harmless today, because there
    is no publish block and nothing checks. It becomes a blocker the day the feed is
    turned on: signed builds by then, or `verifyUpdateCodeSignature: false` as a
    deliberate choice over HTTPS to a host we control. **Settle it before the feed,
    not after.**
  - Still **shared with the NVR**, whose P5 is open for the same reason. One
    certificate covers both products whenever it is bought.
- **Update feed.** `neubit_nvr/desktop/electron-builder.yml` still points
  `publish.url` at `updates.example.com`. Decide the host once, for both.
- **CI** — build + sign + publish on tag.

---

## P0 status (2026-08-27)

Run on Windows 11 26100, 16 GB RAM, distro imported to a spinning HDD.

**Route B is proven.** A private `neubit-vms` WSL2 distro, `docker-ce` 29.7.2 started
directly (no systemd, no Docker Desktop), the unmodified `deploy/docker-compose.yml`,
a database that did not exist an hour earlier — and the console served the real login
page from the production standalone runner, with the bootstrap admin logging in
through the gateway and `/auth/me` returning 200.

Full log: `D:
eubit-p0\P0-FINDINGS.md`.

### Measured

| | |
|---|---|
| Image payload, gzip | **1420 MB** |
| `planet.pmtiles` | **3674 MB** — larger than every image combined |
| Ubuntu rootfs (self-built) | 80 MB |
| Cold boot to `/health` 200 | **93 s** (12 s for compose to return) |
| Idle RAM, production images | **1.69 GiB** — vs 4.11 GiB for the dev stack |
| `docker load` of the payload, on HDD | 6 m 20 s |

### Four defects, none of which can appear on a developer's machine — all now fixed

1. **The frontend production image does not exist.** `docker-compose.override.yml`
   builds `target: deps` into the *same tag* the base compose builds `runner` into.
   The override auto-merges on every `up`, so `neubit-v3-frontend:latest` is the deps
   stage wearing the production tag — `CMD=[node]`, exits 0, console never starts.
   Same for `admin-frontend`. **An image payload saved from a developer's machine
   ships a console that cannot boot.** The runner stage itself is fine: built
   explicitly it produces a working 325 MB image (vs 1.72 GB for the deps image).
2. **Postgres's healthcheck passes before Postgres is usable.**
   `pg_isready -U $POSTGRES_USER` returns 0 during the entrypoint's temporary
   init server, so `depends_on: service_healthy` gates on nothing. On the first boot
   against an empty volume, core / ingest / vision / access / workflow all exited 1
   with `ConnectionRefusedError`. Second boot was clean. **This fires on exactly the
   install a customer performs.** Fix: probe a database the init scripts create.
3. **The datastores are published to the LAN.** `docker-compose.yml` binds postgres
   5432, redis 6379 and nats 4222/8222 on `0.0.0.0`. The appliance must publish the
   gateway and nothing else; dropping all three changed nothing about the run.
4. **`vision`'s migration chain is broken on a fresh database.**
   `DuplicateColumnError: column "credential" of relation "media_nodes" already
   exists` during `alembic upgrade head`. Invisible on an existing DB, fatal on every
   new one — every customer install would lose the VMS service.

### The fixes, and the proof

All four are fixed in `deploy/` and verified by wiping the appliance's volumes and
doing a genuinely fresh first install.

| | Before | After |
|---|---|---|
| Fresh first boot | core, ingest, vision, access, workflow **exited 1** | **all 12 services up** |
| Time to `/health` 200 | never got there | **142 s** |
| Login through the gateway | n/a | **token issued, `/auth/me` 200** |
| Published ports | postgres, redis, nats on `0.0.0.0` | **gateway only** |

1. **Tag collision** — the override builds `deps` into `neubit-v3-frontend:dev`, so
   it can no longer overwrite the production tag. `:latest` rebuilt from the base
   file is now 325 MB with `CMD=[node server.js]`, against 1.72 GB for `:dev`.
2. **Healthcheck** — `pg_isready -h 127.0.0.1 …` (the init server sets
   `listen_addresses=''`, so `-h` forces a real answer) **and** a `psql` against
   `neubit_nvr`, the last database `init-service-dbs.sh` creates, so its existence
   proves the init scripts finished. Plus `start_period: 60s` for initdb on a slow
   disk.
3. **Ports** — postgres, redis, nats, core's `:8000`, the frontend's `:3000` and the
   Traefik dashboard all moved to the dev override. The base file publishes the
   gateway alone. This also retires the `:3000` foot-gun that produced the
   "Request failed with status code 404" login.
4. **Migrations** — new `deploy/migrate.sh`, wired into core, ingest, access and
   vision. The cause was never revision 0025: all three of ingest/access/vision use
   the "v3 baseline" pattern where 0001 builds the schema from **live ORM
   metadata**, so on a fresh database the baseline already *is* head and every later
   revision fails — **14 of vision's 28 revisions carry such an operation.**
   `migrate.sh` branches on whether `alembic_version` is populated: fresh → baseline
   then `stamp head`; existing → `upgrade head`.

   It also retires a defect that had been documented as accepted: core ran
   `alembic upgrade 0001 && alembic stamp head` *unconditionally* — "Existing DBs
   upgrading from an older schema are out of scope here" — which stamps new
   revisions as applied without running them, so an existing database never receives
   a new column and the API 500s on the missing field. Core branches now too.

### Decisions the run forced

- **Build the distro tarball in CI, with dockerd and every image already inside.**
  `docker load` alone took 6 m 20 s on a spinning disk, apt needs internet, and an
  interrupted apt leaves a half-configured dpkg no customer can recover. The
  installer should do nothing but `wsl --import`.
- **Ubuntu no longer publishes a WSL rootfs** — `cloud-images.ubuntu.com/wsl/` has
  only manifests. Build it with `docker export` instead: 80 MB, reproducible,
  offline, version-pinned.
- **Ask for two paths, not one.** `pgdata` and the container layers want SSD;
  `recordings` and the basemap want the cheap spinning disk. This box made the case
  by itself — apt on the HDD spent minutes in `jbd2_log_wait_commit`.
- **Set `appendWindowsPath=false` in the distro's `wsl.conf`.** Left at the default,
  `which docker` inside the distro resolved to *Docker Desktop's* Windows CLI. On any
  machine with Docker Desktop, appliance scripts would silently drive the wrong engine.
- **All WSL2 distros share one VM network namespace.** A private appliance distro and
  a Docker Desktop stack collide on every published port. Fine at a customer site,
  a real obstacle on a developer's box.

### Networking — the desktop app is free, the LAN console is not

| From | Result |
|---|---|
| `http://localhost:18080/login` on the box | **200** |
| `http://<lan-ip>:18080/login` from the LAN | **refused** |

WSL2's `localhostForwarding` binds loopback only. So **the Electron shell needs no
networking work whatsoever** — it reaches `http://127.0.0.1` today. The LAN web console
needs an explicit step.

**`networkingMode=mirrored` was then tested and it works.** With it set, the distro sees
the host's LAN address as one of its own interfaces, and from *inside* the distro
`http://192.168.1.10:18080/login` returns **200** against a socket bound `0.0.0.0:18080`.
From Windows the same URL is refused — and the reason is not WSL:

```
Get-NetFirewallHyperVVMSetting → DefaultInboundAction: Block
```

The **Hyper-V firewall** blocks inbound to WSL by default. The installer, which already
runs elevated to register a service, adds one rule:

```powershell
New-NetFirewallHyperVRule -Name Neubit-VMS-Console -DisplayName "Neubit VMS console" `
  -Direction Inbound -VMCreatorId '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}' `
  -Protocol TCP -LocalPorts 80 -Action Allow
```

Mirrored mode is machine-wide, and Docker Desktop kept working under it — its engine
came back and the developer's stack served the console on both loopback and the LAN
address. **Adopt mirrored + one Hyper-V firewall rule; drop the portproxy option**,
whose NAT IP churn would have needed refreshing at every boot.

### Still open from P0

- **Windows Service registration surviving logout and reboot** — the one item not
  reached. Everything else in P0 is answered.
- **Redis on Windows** — deliberately deferred; it only matters for Route A.

---

## 6. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| WSL2 unavailable or forbidden on a customer server | Route B dead for that customer | P0 measures how common this is. Route A is the escape hatch; do not start it speculatively |
| Installer size ~5.3 GB, of which 3.7 GB is `planet.pmtiles` | Slow distribution, awkward air-gapped delivery | **Make the offline basemap an optional payload** — that alone takes the installer to ~1.6 GB. `TILES_MAXZOOM` is already an env knob, so a reduced-zoom planet file is a supported configuration, not new work |
| Two deployment shapes drift (if Route A is ever taken) | Appliance breaks in ways dev never sees | CI must build and smoke-test the appliance on every release, not on demand |
| Redis has no clean Windows story | Blocks Route A; a licence cost under Memurai | Decide in P0. Moving the Celery broker to JetStream would remove Redis from the estate entirely — worth costing |
| Electron + native libVLC addon is genuinely hard | P3 slips | It is a separate phase behind a shipped product; the shell is useful without it |
| Unsigned installer | Customers cannot install it | Start the cert purchase in parallel with P0 |

---

## 7. Explicitly not doing

- One shell serving both NVR and v3. They are separate products; a shared installer
  couples two release trains and two licences.
- A separate desktop build of the UI. There is one `frontend/`, and §2 explains why
  that is a property worth defending.
- Tauri. It reintroduces Rust, which we are retiring, and has the same
  no-native-video-layer problem as Wails.
- macOS/Linux desktop builds in v1. `electron-builder` already has the targets
  configured; turn them on when a customer asks.

---

## 8. Open decisions

1. ~~**Code signing certificate**~~ — **DECIDED: skip for now** (product owner,
   2026-08-27). Ship unsigned; revisit when a customer or a reseller makes SmartScreen
   the blocker. P4 carries the two consequences that are now live — one of which,
   auto-update refusing to install an unsigned build, has to be settled *before* the
   update feed is switched on rather than after.
2. **Update feed host** — one decision covering both products.
3. **Redis** — Valkey-on-Windows, Memurai (paid), or migrate the Celery broker to
   JetStream and delete Redis from the estate?
4. **Target platforms for v1** — Windows only, or Linux/macOS from day one?
5. **Minimum Windows version** — Route B's WSL2 requirement sets a floor. Server
   2019 without WSL2 would force Route A.
