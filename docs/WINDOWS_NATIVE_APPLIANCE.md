# Neubit VMS on Windows: the native appliance (Route A)

**Decision, 2026-10-08.** The product owner's requirement was: "the VMS installs
the way the NVR does — one `.exe` that any operator can run on any Windows
server, and it just works." That requirement settles the route, because Route B
(WSL2 + Docker, `deploy/windows/`) fails it in three ways:

| Requirement | Route B (WSL2 + dockerd) | Route A (native service) |
|---|---|---|
| Runs after a reboot with nobody signed in | No. WSL refuses SYSTEM / session 0, so it needs a logon task plus auto-logon, which domain policy often forbids | Yes. A Windows Service, StartAutomatic, with recovery actions |
| Installs on a Windows Server that is itself a VM (VMware, Hyper-V, cloud) | Only with nested virtualization, which is usually off | Yes. Nothing is virtualized |
| Upgrade keeps the database | No. Uninstall with `-KeepData` drops `install-state.json`, and reinstall then replaces the distro | Yes. Data lives outside the install directory and is adopted on reinstall, the way the NVR does it |

Milestone XProtect, Genetec Security Center, Nx Witness and our own NVR all ship
as native Windows services. Route B stays in the repo for the Docker/Linux story;
this document is the Windows installer from now on. Linux packaging comes later,
under the same supervisor (`neubitvms-svc run` under systemd).

This supersedes §4 "why we start with B" of
[DESKTOP_APPLIANCE_PLAN.md](DESKTOP_APPLIANCE_PLAN.md). Its Electron-shell
sections (P1, P3) still hold.

---

## 1. What the operator gets

One installer, `Neubit VMS Setup <ver>.exe`, built with electron-builder (NSIS,
per-machine) exactly like the NVR's `Neubit Console Setup`:

1. **The server**: Windows Service `NeubitVMS`, auto-start, under the virtual
   account `NT SERVICE\NeubitVMS`. It runs with nobody signed in.
2. **The web console** at `http://<server>/` (port 80 by default) for every
   browser on the LAN.
3. **The desktop app** "Neubit VMS". It is the same console in an Electron
   window, plus the tray, the service panel, multi-monitor walls and the export
   folder.

Both front doors show one console from one build. Nothing in the web UI forks
for the desktop. The app only adds things a browser cannot do, through
`window.neubit` (see `frontend/src/lib/desktop.ts`).

Two variants come from CI, as for the NVR:

- **Online** (~250 MB): third-party runtimes are downloaded at install time from
  a SHA-256-pinned manifest.
- **Offline** (~700 MB): the same runtimes are baked in, for air-gapped sites.

Map tiles (3.7 GB at z10) and the geocoder index (GBs) are never in the
installer. The service provisions them in the background after install, as the
Docker stack does today. The map works without them; it just has no basemap and
no place search until then.

---

## 2. Process model

`neubitvms-svc.exe` is a Go supervisor and the only thing the SCM starts. It
follows the NVR's `neubitsvc` pattern:

- a dependency graph;
- per-process health checks;
- restart with backoff;
- a critical/non-critical flag (a critical process that cannot stay up makes the
  service report degraded);
- CTRL_BREAK for graceful child shutdown;
- a job object, so no child outlives the service.

The code lives in `appliance/` in this repo. It is not a copy of the NVR's
module; the NVR repo is not touched.

```
neubitvms-svc (Windows Service NeubitVMS)
├── postgres      PG 17 + TimescaleDB 2.17.2 (shared_preload_libraries)   127.0.0.1:15432  critical
├── nats          nats-server 2.10, JetStream on <data>\nats             127.0.0.1:14222  critical
├── migrate       one-shot, in order: core, ingest, workflow, access, vision, reporting
├── core          uvicorn app.main:app                                    127.0.0.1:18000  critical
├── ingest        uvicorn                                                 127.0.0.1:18001
├── workflow      uvicorn, VE_WORKFLOW_SCHEDULER=inline (no Celery)       127.0.0.1:18002
├── access        uvicorn                                                 127.0.0.1:18003
├── vision        uvicorn (never --workers/--reload on Windows)           127.0.0.1:18004  critical
├── reading-writer uvicorn                                                127.0.0.1:18005
├── frontend      node server.js (Next standalone)                        127.0.0.1:13000  critical
├── admin         node server.js (Next standalone)                        127.0.0.1:13001
├── tiles         built into the supervisor: static Range server          127.0.0.1:18080
├── geocoder      java -jar photon.jar (only once its index is present)   127.0.0.1:12322
└── gateway       traefik (file provider, rendered routes)                0.0.0.0:80       critical
control API       built into the supervisor                               127.0.0.1:18079
```

All internal ports are loopback-only. The 18xxx/13xxx block is chosen so it does
not collide with a co-installed NVR (8000, 8080, 5432, 8554/8888/8889/9996/9997,
8189, 8079). The gateway port (80) and every internal port can be overridden with
`-Ports "ui=8090,…"`, which is persisted in `config.json`.

### What changes in the backend (behind configuration; Docker is unchanged)

| Docker | Native | Change |
|---|---|---|
| Redis | none | core: `VE_RATE_LIMIT_BACKEND=memory`, and readiness skips Redis when `VE_REDIS_URL` is empty. Redis has no first-party Windows build, and nothing else in core uses it |
| Celery worker + beat (4 periodic sweeps) | `VE_WORKFLOW_SCHEDULER=inline` | The workflow API runs the same four task functions on the same cadence in its lifespan, as core, ingest and access already run theirs. Celery's prefork pool does not work on Windows anyway. Nothing calls `.delay()` on the workflow app |
| `migrate.sh` (bash) | `python -m kernel.migrate` | Same fresh-vs-existing decision, in Python, so both shapes share it |
| ops-agent (Docker socket) | supervisor control API | Same JSON as `/containers`, `/host`, `/db/*`, so `core/app/infra` and `system/router.py` do not change. "Containers" are processes; `pg_dump.exe`/`psql.exe` run natively |
| `db-init` / `corefiles-init` | supervisor provisioning | `initdb`, timescale preload, the database list from `deploy/postgres/init-service-dbs.sh`, and ACLs instead of chown |
| nginx (tiles) | supervisor | The same headers: Range, `Accept-Ranges`, `Cache-Control: public, max-age=86400`, `/tiles-health` |
| `172.19.0.0/16` trusted proxy | `127.0.0.1/32` | Configuration only |
| SIGTERM | CTRL_BREAK → SIGBREAK | core's shutdown hook also listens for SIGBREAK |

### Data

The data root is `%ProgramData%\Neubit\VMS`. If the program is installed on a
drive other than the Windows drive, the data root becomes `<drive>:\NeubitVMS`
instead (the NVR's rule: footage follows the big disk). It is recorded in
`HKLM\SOFTWARE\Neubit\VMS\DataRoot`.

```
<data>\
  config\    config.json (ports, options), secrets.env (generated once, ACL'd), control.json
  pgdata\    Postgres cluster
  nats\      JetStream store
  storage\   core files (VE_STORAGE_LOCAL_DIR)
  downloads\ vision exports
  tiles\     planet.pmtiles (provisioned)
  geocoder\  photon index (provisioned)
  logs\      neubitvms-svc.log + one log per process, rotated
```

The DACL on the data root grants SYSTEM, Administrators and
`NT SERVICE\NeubitVMS`, and nobody else. Secrets (JWT, secrets key, the seven NATS
passwords, the DB password, the ops token) are generated once with a CSPRNG at
first provision. Upgrades never regenerate them.

---

## 3. Payload

```
resources\server\
  neubitvms-svc.exe
  python\              python-build-standalone 3.11 + every service's
                       dependencies (one site-packages, from a Windows lock)
  services\<name>\     each service's source (runs with cwd = its dir)
  web\frontend\, web\admin\    Next standalone output, built for win32
  config\              traefik.yml, routes template, nats.conf template
  scripts\             install/uninstall/backup/restore PowerShell
  binaries.json        pinned runtimes (url, sha256, size)
  bin\                 offline variant only
```

The services cannot share one site-packages as installed packages, because every
one of them is a package called `app`. So the third-party dependencies, `kernel`
and `reporting` are installed into the interpreter, and each service runs from
its own source directory.

The runtimes listed in `appliance/windows/binaries.json` are verified before
they are extracted:

- PostgreSQL 17 (EDB binaries) and TimescaleDB 2.17.2 `postgresql-17-windows-amd64`
- nats-server 2.10
- traefik 3.1
- node 22
- ffmpeg (LGPL shared)
- poppler
- the VC++ runtime (its Authenticode signature is verified)
- optionally a Temurin 21 JRE plus photon 0.7.4

**PostgreSQL 17, not the Docker image's 16.** 17 adds the builtin `C.UTF-8`
locale provider, which sorts identically on Windows and Linux. It is also the
exact pin the NVR ships, so a server running both products holds one verified
copy. TimescaleDB stays at 2.17.2, the Docker image's version, built for PG 17.
A Docker dump (PG 16) restores into it; the reverse direction is not a supported
path.

### Building it

```
powershell -ExecutionPolicy Bypass -File appliance\windows\build-native-appliance.ps1 [-Offline]
cd desktop; npm run package:win
```

- `build-native-appliance.ps1` stages `dist\vms-server`. It builds the Go
  supervisor with the version stamped. It installs a SHA-256-verified uv and
  CPython 3.11 (`appliance/windows/build-tools.json`). It writes
  `requirements.in` from the services' own `pyproject.toml`
  (`appliance/build/requirements.py`) and turns it into a hash-pinned Windows
  lock. It copies the service sources without tests or `.env` files, runs
  `npm ci` and `next build` for both web apps, and copies the repo's gateway,
  NATS and database-list files as templates.
- `npm run package:win` produces `Neubit VMS Setup <ver>-x64.exe` with the
  payload as `resources\server`. It also produces the client-only Portable exe,
  without the payload (`electron-builder.portable.yml`).

---

## 4. Installer (NSIS hooks, the NVR's proven shape)

- `customInit`: stop `NeubitVMS` before extraction, because the service holds
  its binaries open.
- `customInstall` calls the idempotent `install-appliance.ps1`, which does this
  in order:
  1. Admin check.
  2. Port conflicts. Each fallback is printed, never silent.
  3. `neubitvms-svc provision`: data root, secrets, initdb, config.
  4. Fetch or copy the runtimes and verify their hashes.
  5. `neubitvms-svc install`: register the service and its recovery actions, and
     set the ACLs.
  6. Add firewall rules for the UI port only.
  7. Start the service and wait for `/v1/status` to report ready.
  8. Write `DataRoot` (64-bit registry view).
  9. Print the local and LAN URLs and where the first admin password was written.
     There is no default administrator and no password file. The first time the
     console opens on this computer, core's first-run setup (`/setup`) asks the
     operator to create the administrator. That administrator is the platform
     super-admin, the same account `VE_BOOTSTRAP_ADMIN_*` produces.
     `VE_SETUP_LOCAL_ONLY=true` restricts setup to this computer: the console
     already answers on the LAN, and without the restriction whoever reached
     `/setup` first would own the system. A LAN browser is told to finish setup
     on the server instead. An unattended install can still pass `-admin-email`
     (and `-admin-password`). Provision refuses any address core's email
     validator would (`.local`, `.test`, `localhost`, ...), before it writes
     anything.
- `customUnInstall` is skipped on `--updated` (upgrades). Otherwise it asks
  whether to delete the database and files. The default, and silent mode, is
  **keep**.
- An upgrade is simply running the new installer: the service stops, the files
  are replaced, provisioning reconciles, migrations run, and the service starts.

---

## 5. Desktop shell changes

- Find the local server through the control API: `<data>\config\control.json`,
  then the registry, then `127.0.0.1:18079`. The shell then loads the UI URL from
  `/v1/status`. This fixes the Route B bug where the shell probed `:80` and found
  nothing.
- A **service panel**, the NVR's `#panel`: process states, start/stop/restart
  (elevated, with a declined UAC reported as "cancelled"), open logs, and reset
  the admin password.
- Tray status line: "Server: healthy (12/12)".
- The updater stays off while the feed host is a placeholder, and for portable
  and unpackaged builds.

---

## 6. Phases

| Phase | Scope | Done when |
|---|---|---|
| **P0** | This document; Jira | Approved |
| **P1** | Backend portability behind config: Redis-optional core, inline workflow scheduler, `kernel.migrate`, SIGBREAK, data-dir-aware disk metrics | Docker suite green; the native toggles have unit tests |
| **P2** | `neubitvms-svc`: service verbs, supervisor, provisioning, control API (status, logs, ops-agent JSON), tiles server | Brings the full stack up on this machine from a staged payload |
| **P3** | `build-native-appliance.ps1`: Python + lock, web builds, pinned manifest, online/offline staging | A reproducible `dist\vms-server\` |
| **P4** | electron-builder + NSIS hooks + install/uninstall scripts; shell discovery, service panel, tray | Setup.exe installs, upgrades and uninstalls (keeping data) |
| **P5** | Clean Windows Server 2022 VM: install, reboot with nobody signed in, upgrade, uninstall-keep, reinstall-adopt; docs | Recorded in this file |

---

## 7. Verification log

**2026-10-08, dev machine (Windows 11, not elevated, console mode).** A fresh
data root was provisioned from a staged `dist\vms-server` (437 MB) with the
console on 8095, then run with `neubitvms-svc run`.

- The stack reached `ready` on the first attempt with 0 restarts: Postgres 17 +
  TimescaleDB, NATS, every migration and reporting one-shot, all six APIs, both
  Next apps, tiles and Traefik. The geocoder was held back, as designed, because
  no JRE is installed.
- Browser sign-in worked through the gateway. System Health lists the native
  processes with their memory, and Redis reads "not used".
- Stopping the supervisor left no orphan processes, so the job object works. A
  restart on the same data root re-ran the migrations as no-ops.

Defects that this run found and fixed:

- ingest `0006` failed on any fresh database, Docker included. It is now guarded
  like `0003`-`0005`.
- The default admin `admin@neubit.local` was refused by core, which then
  crash-looped.
- TimescaleDB had no background worker slots. The overlay now sets them.

Still open: the Windows Service run itself (needs elevation), the
install/upgrade/uninstall cycle of Setup.exe (P4), and P5.
