# VMS — Video Wall (enterprise control-room display wall)

The gap: `/streaming` is a **single operator's** browser live-grid. Enterprise VMS
(Milestone Smart Wall / Genetec / CP-Plus) also offers a **shared, centrally-managed
control-room Video Wall** — a grid of physical monitors that operators drive from their
workstation, with shared state, alarm-driven auto-display, and (hardware) decoder push.
This is a committed E-tier feature. Scope confirmed 2026-07-09: **software shared wall +
hardware decoder push** (Hik/Dahua/CP-Plus) — software first, decoder phased + `# LIVE-VALIDATE`.

## Concept

- **Video Wall** = a named, tenant-scoped, shared display surface for a control room. It is a
  grid of **monitors** (physical screens). Its LIVE state (what's showing right now) is shared:
  every operator and every display-client sees the same wall in real time.
- **Monitor** = one screen in the wall. Two kinds:
  - `browser` — a fullscreen kiosk browser (any PC+screen) opens the display-client route and
    renders only its assigned content, live via MediaMTX (reuses the P2 media-token flow).
  - `decoder` — a hardware video decoder output (Hik/Dahua/CP-Plus) driven over its SDK; the
    backend pushes the camera's RTSP to that decoder channel.
  Each monitor is itself a mini-grid (1/4/9/16) of **cells**, each cell shows a camera.
- **Preset** = a saved snapshot of the whole wall (which cameras on which monitor cells) — recall
  in one click. **Tour/Salvo** = a named sequence of presets cycled on a dwell interval.
- **Alarm-driven auto-display** = a linkage rule action (`wall_display`): on an event, show camera
  X on wall W / monitor M / cell C for N seconds (spot-monitor), then revert.

## Architecture (reuse existing seams)

- Owned by the **vision** service (VMS video domain) — new domain `app/vms/videowall/`.
- **Shared live state** kept server-side; every mutation publishes NATS
  `tenant.<id>.vms.wall.<wall_id>.state` → **core SSE bridge** (mirror `realtime_vms.py` →
  `realtime_wall.py`, `GET /api/v1/realtime/wall-events`) → all operator UIs + display-clients.
- **Media**: display-client browser plays each cell direct from MediaMTX, token-gated via the
  existing `/media/verify` Traefik ForwardAuth. No new media path.
- **Decoders**: a driver abstraction mirroring `app/vms/drivers/` (camera factory) —
  `DecoderDriver` ABC + factory + HikvisionDecoder / Dahua(CpPlus)Decoder. Methods:
  `set_layout(monitor, grid)`, `display(monitor, cell, rtsp_uri)`, `clear(monitor)`, `tour(...)`.
- **Alarm-driven**: extend P5-B linkage — add `wall_display` to `linkage/schemas.py ACTION_TYPES`
  + `linkage/actions.py ACTION_HANDLERS` (reuses the whole rule engine).
- **RBAC**: reuse core perms — add `vms.wall.view` + `vms.wall.control` (+ `vms.wall.manage` for
  wall/decoder CRUD) to `core/app/auth/permissions.py`.

## Data model (vision, new migration 0012_video_wall)

- `video_wall` — id, tenant_id, name, description, site_id?, rows, cols, is_active, created_*.
- `wall_monitor` — id, wall_id, tenant_id, position (row,col / index), name, kind
  (`browser`|`decoder`), decoder_id?, decoder_channel?, layout (grid key), created_*.
- `wall_cell_state` (or a JSON `state` on the monitor / a `wall_live_state` row per wall) — the
  CURRENT camera per (monitor, cell). Keep it a single `wall_state` JSON row per wall for simple
  atomic broadcast + recall.
- `wall_preset` — id, wall_id, tenant_id, name, state (JSON snapshot), is_default, created_*.
- `wall_tour` — id, wall_id, tenant_id, name, preset_ids (ordered), dwell_seconds, created_*.
- `video_decoder` — id, tenant_id, name, brand (`hikvision`|`dahua_cpplus`), host, port, username,
  enc_password, channel_count, is_enabled, created_* (mirror camera creds-at-rest).

Register every model in BOTH `models/__init__` + `0001_vision_baseline _tables()` + `env.py`
(silent-drop gotcha).

## Phases

### VW-A — backend foundation (vision + core)
video_wall/wall_monitor/wall_state/wall_preset/wall_tour models + migration; `videowall/`
domain (schemas/service/router): wall CRUD, monitor CRUD, get/set live state (push a camera to a
monitor cell, clear, apply preset, save preset, start/stop tour), tenant-scoped + perm-gated.
Every state mutation → NATS `tenant.<id>.vms.wall.<id>.state`. Core `realtime_wall.py` SSE bridge
+ `vms.wall.*` perms in core. Verify: CRUD + state push + SSE emits + tests.

### VW-B — hardware decoder push (vision)
`video_decoder` model + CRUD; `DecoderDriver` ABC + factory + HikvisionDecoder (ISAPI/SDK) +
DahuaCpPlusDecoder; when a monitor.kind==decoder, wall-state mutations call the driver to push the
camera RTSP (our MediaMTX URL) to that decoder channel/cell. Lazy-import SDK, graceful degrade.
Verify: driver request-build + factory + tenant scope tests; real push = `# LIVE-VALIDATE`.

### VW-C — alarm-driven auto-display (vision linkage)
Add `wall_display` action: config `{wall_id, monitor, cell, camera_source, hold_seconds}` → sets
the wall cell (via videowall service) for hold_seconds then reverts (spot-monitor). Add to
ACTION_TYPES + ACTION_HANDLERS. Verify: rule fires → wall state changes → reverts; test.

### VW-D — frontend
- **Wall management** (Config → Video Wall, enable the disabled tab): list/create walls, define
  monitor grid, register decoders, presets/tours.
- **Wall operator console** (`/wall/<id>` or a Streaming surface): the cockpit — see monitors as
  tiles, drag cameras onto monitor cells, save/recall presets, start tours, live shared state via
  the wall SSE. Multiple operators stay in sync.
- **Display-client** (`/wall/<id>/monitor/<mid>` fullscreen kiosk, minimal chrome): renders only
  that monitor's cells, live via MediaMTX, auto-syncs to shared state. This is what each physical
  screen opens.
Verify: routes compile + 200; console pushes a camera → SSE → another client updates (synthetic).

## Done when
Shared wall CRUD + live shared-state + real-time sync across clients + presets/tours +
alarm-driven auto-display + decoder-push (structured, hardware `# LIVE-VALIDATE`) + the three
frontend surfaces are built + Docker-verified. **True enterprise Video Wall — CP-Plus/Milestone/
Genetec parity.**
