# Node Agent core — design spec (Sub-project 1 of 3)

> Status: **DRAFT for review** (no code yet). Product decision **Approach A —
> Node-authoritative federated VMS** is already approved by the owner. This spec
> scopes only **Sub-project 1: Node Agent core** — the foundation that makes each
> Go `nvr` node an autonomous, self-sufficient mini-VMS. The Node Console UI
> (sub-project 2) and the Federation-layer refactor + migration (sub-project 3)
> are separate specs; they are referenced here only where this sub-project must
> define a contract they build against.

Grounds itself in the working code:
- **`backend/nvr/`** — the Go recorder (chi router; `/health` public,
  `/api/v1/nvr/*` JWT-gated with `/whoami` + `/status`; `internal/{streams,
  recording,playback,anr,mediamtx,supervisor}`; `migrations/` on `gokernel/db.Migrate`).
  Today it depends on its own `neubit_nvr` **Postgres** DB (`media_nodes`,
  `stream_shards`, `recording_targets`, `recording_segments`, `anr_jobs`).
- **`backend/vision/app/vms/`** — the Python VMS control plane that **currently
  owns** cameras / media profiles / recording config / storage / PTZ / RAID in
  the `neubit_vision` Postgres DB (`app/vms/models/{camera,nvr,recording,storage,
  ptz,media_node}.py`, `cameras/service.py`, `live/service.py`, `common/media_token.py`).
- **`docs/ARCHITECTURE.md`**, **`docs/VMS_DESIGN.md`** — house terminology
  (control-plane / data-plane split, tenant-scoped, MediaMTX, ForwardAuth
  media-token, NATS `tenant.<id>.vms.*` spine, "build-once schema, logic later").

---

## 1. Overview & problem statement

### 1.1 Where we are

Today a `nvr` node is a **thin data-plane**: it drives MediaMTX and reconciles
recording, but every fact about *what to record* (cameras, media profiles,
recording mode/schedule/retention, storage pools, PTZ presets, motion/privacy
config) lives in **`vision`'s `neubit_vision` Postgres**. The node holds only
transient placement state (`stream_shards`, `recording_targets`) plus a
dedupe ledger — and it holds that in a **second external Postgres** (`neubit_nvr`).

Consequences:
- A node **cannot manage or even fully describe its own estate** without `vision`.
  If central (or the internet, or a dev tunnel) is down, the node keeps recording
  the streams it already knows about, but you can't add a camera, change a
  schedule, fix a bad RTSP URL, or log in to look at the box.
- Every node needs a **reachable Postgres** — a heavy dependency for an appliance
  meant to sit in a rack at a client site (on-prem edition, `ARCHITECTURE.md` §1).
- **Local debuggability is zero.** A field engineer standing at the appliance
  has no local console, no local login, no way to test a stream — everything
  routes back to central.

### 1.2 What we want

Each node must be a **self-sufficient mini-VMS**: it owns its cameras, records and
streams them, and can be fully configured and operated **standalone** — no
external DB, no central, no developer. Central becomes an **optional federation
peer** that aggregates and coordinates across nodes, never a hard dependency for a
single node to run.

The rule (the north star for every ownership call in this doc):

> **Whatever a node needs to keep recording, streaming, and managing its own
> cameras lives ON the node.** Cross-node coordination and PSIM (incidents,
> workflow, access control, video walls, reports) stay central.

### 1.3 Why sub-project 1 first

Sub-project 1 delivers the **substrate**: an embedded store, node ownership of the
estate, a node identity, local auth, and a self-contained migration system. Once a
node is authoritative and configurable via its own API, the Console (SP2) is "just
a UI over these endpoints" and Federation (SP3) is "just a sync protocol over this
truth." Getting the ownership boundary and the local schema right here is what
makes the other two tractable.

---

## 2. Goals / Non-goals

### 2.1 Goals

1. **Embedded, offline-first store.** Replace the node's `neubit_nvr` Postgres
   dependency with an **embedded SQLite** file (WAL mode) on the data volume,
   opened by the Go binary itself. No external DB process; the node boots and runs
   with just its binary + data volume.
2. **Node owns its estate.** Move the node-relevant tables (cameras, media
   profiles, recording config/targets/segment index, storage pools + RAID, PTZ
   presets/patrols, motion/privacy config, ANR jobs) into SQLite; the node becomes
   the **authoritative owner** of these for its own cameras.
3. **Estate-management API.** New `/api/v1/nvr/estate/*` REST endpoints for full
   local CRUD of the estate (cameras, recording config, storage, PTZ, discovery,
   bulk-add) — mirroring the surface `vision/app/vms/cameras/router.py` exposes
   today, so the node can be driven with no control plane.
4. **Node identity + local auth.** A per-node identity, a **local bootstrap admin**
   credential minted at install (standalone console login when central is down),
   local operator accounts, and dual-mode request auth: the node validates both
   **central-issued JWTs** (existing `gokernel/auth`) *and* **its own local
   sessions**.
5. **Self-contained migrations.** A SQLite migration runner following the existing
   `nvr/migrations/` + `gokernel/db.Migrate` pattern (ordered `.sql`, `_migrations`
   ledger, idempotent), so schema evolves without an external migration tool.
6. **Standalone media.** The node **issues its own media tokens** so live/recorded
   viewing works against its co-located MediaMTX even with central down (contract
   only in SP1; the local viewer UI is SP2).
7. **Federation contract, node side.** Define — but not fully implement — the node
   side of enrollment, heartbeat/snapshot publish, override-accept, and the
   offline outbound queue, precisely enough for SP3 to build the central side.

### 2.2 Non-goals (explicitly OUT of sub-project 1)

- **The Node Console web UI** (embedded management/diagnostics/test tools) — that
  is **sub-project 2**. SP1 ships the *API and store* the console will consume.
- **The Federation-layer refactor** (vision registry + aggregation + control proxy
  + override push + media relay + NATS bridge) and the **one-time estate migration
  tool** for the 3 existing projects — that is **sub-project 3**. SP1 defines the
  node-side contracts (§7) and the migration *plan* (§8); it does not build
  central's side.
- **PSIM / access / workflow / incidents / video walls / reports / cross-node
  linkage** — these **stay central** and are never moved onto a node.
- **Changing the live/recording engines** — `streams`, `recording`, `playback`,
  `anr`, `mediamtx`, `supervisor` keep their behaviour; SP1 only repoints their
  persistence from Postgres to SQLite and lets them read desired-state from the
  node's own estate tables.
- **Multi-node WITHIN one appliance** — the node registry (`media_nodes`) stays a
  seam but SP1 assumes **one node = one appliance = one embedded MediaMTX + one
  SQLite**. Fleet aggregation is central's job (SP3).

---

## 3. Architecture

### 3.1 Ownership split (the crux)

| Concern | **NODE owns** (embedded SQLite, in the Go binary) | **CENTRAL owns** (vision + core, Postgres) |
|---|---|---|
| Cameras + media profiles (stream URLs / codecs) | ✅ authoritative | read-cache (aggregate) |
| Recording config + schedules + targets + segment index | ✅ authoritative | read-cache + durable metadata index |
| Storage pools + tiering + RAID health | ✅ authoritative | read-cache |
| PTZ presets / patrols | ✅ authoritative | read-cache |
| Motion zones / privacy masks / motion config | ✅ authoritative | read-cache |
| ANR jobs | ✅ authoritative | read-cache |
| Node identity + local audit log | ✅ authoritative | mirrored in node registry |
| Local operator accounts (standalone console) | ✅ authoritative | — |
| Node registry (which nodes exist) | — | ✅ authoritative |
| Tenants, central users/roles, SSO/LDAP, 2FA policy | — | ✅ authoritative |
| PSIM: incidents / workflow / SOP | — | ✅ authoritative |
| Access control, fire, IoT | — | ✅ authoritative |
| Cross-node linkage, video walls, reports | — | ✅ authoritative |
| **Aggregated read-cache of every node's estate** (unified command) | — | ✅ authoritative |

Node-authoritative rule: **on its own estate the node's config always wins.** A
central "override push" (§7.3) is an explicit, intentful write that the node
*accepts and persists as its new truth* — it is not a silent central-owns-master.
This inverts today's model (vision master, nvr slave).

### 3.2 Where the node sits

```
        ┌──────────────────────── CENTRAL (cloud or on-prem HQ) ────────────────────────┐
        │  core (identity/RBAC/tenants)      vision (federation: registry · aggregate ·   │
        │  Postgres: neubit_core             control-proxy · override-push · media-relay) │
        │                                    Postgres: neubit_vision (read-cache of estate)│
        └───────────────▲───────────────────────────────▲──────────────────────────────┘
                        │ REST (control cmds, override)   │ NATS best-effort
              heartbeat │ + join/enroll                   │ (snapshot, events)     ← SP3 builds central side
        ┌───────────────┴─────────────────────────────────┴──────────────────────────────┐
        │  NODE APPLIANCE (autonomous mini-VMS)                                            │
        │                                                                                  │
        │   ┌──────────── nvr (Go binary) ────────────┐        ┌──────────────┐           │
        │   │ chi router                              │        │  MediaMTX    │  RTSP in  │
        │   │  /health (public)                       │─drive──▶│ (co-located) │◀──cameras │
        │   │  /api/v1/nvr/*    (central-JWT gated)   │  ffmpeg └──────┬───────┘           │
        │   │  /api/v1/nvr/estate/*  (dual auth) ★NEW │  record        │ ForwardAuth       │
        │   │  supervisor · recording · playback · anr│◀───────────────┘ (node-issued      │
        │   │  ★NEW estate store + local auth + ident │   media token, §5.4)               │
        │   └───────────────┬─────────────────────────┘                                    │
        │                   │ embedded (in-process, WAL)                                    │
        │            ┌──────▼───────┐        ┌─────────────────┐                            │
        │            │ SQLite file  │        │ recordings vol  │  (fmp4 segments)           │
        │            │ node.db      │        │ /recordings     │                            │
        │            └──────────────┘        └─────────────────┘                            │
        └──────────────────────────────────────────────────────────────────────────────────┘
```

- **No external DB.** `db.Connect(neubit_nvr Postgres)` in `main.go` is replaced by
  opening the embedded SQLite. Everything the recording/streaming loops need is
  local.
- **Video never transits central** (`ARCHITECTURE.md` §2.3): camera → co-located
  MediaMTX → browser, gated by a **node-issued** media token so standalone viewing
  works.
- **Central is a peer, not a parent.** The REST + NATS links up to central are
  best-effort; their loss degrades *federation* (unified command), never the
  node's own operation.

### 3.3 Relationship to vision/central after SP1

SP1 lands the node changes **without breaking the current vision-master flow**:
during SP1 the node can run *either* legacy-mode (vision still writes via the
existing internal endpoints) *or* authoritative-mode (estate owned locally). SP3's
migration flips each existing project from legacy to authoritative (§8). This lets
SP1 merge and ship on its own.

---

## 4. Data model — embedded SQLite schema

### 4.1 SQLite specifics (apply to every table below)

- **One file**, `node.db`, on the data volume (e.g. `/data/node.db`), opened
  `?_journal_mode=WAL&_busy_timeout=5000&_foreign_keys=on&_synchronous=NORMAL`.
  WAL gives concurrent readers during writes (the recording loop + API + snapshot
  builder all read while config writes happen); `busy_timeout` absorbs brief write
  contention instead of erroring.
- **Types:** SQLite is dynamically typed; we use the affinity set `TEXT`,
  `INTEGER`, `REAL`. Mappings from the Postgres/SQLAlchemy models:
  - `uuid` / `String(36)` PK → **`TEXT`** (UUID stored as its 36-char string, same
    value as Postgres; the models already use `String(36)` + `_uuid_str`, and the
    ORM notes say the models are "portable … works on Postgres AND SQLite").
  - `tenant_id` (`Uuid`, nullable) → **`TEXT NULL`** (stringified UUID; on a
    single-tenant appliance this is the one tenant, or `NULL`/`'platform'`).
  - `Boolean` → **`INTEGER`** (0/1).
  - `Integer` / `BigInteger` → **`INTEGER`** (SQLite INTEGER is 64-bit).
  - `Float` → **`REAL`**.
  - `DateTime(timezone=True)` → **`TEXT`** storing RFC3339 UTC
    (`2026-07-14T10:00:00Z`) — string-comparable for the time-window range scans
    playback/segments need. (`INTEGER` epoch-millis is an alternative; we choose
    RFC3339 for human-readable debugging on the appliance, which is a stated goal.)
  - `JSON` columns → **`TEXT`** holding a JSON document (SQLite `json1` is
    available for server-side queries but the Go side marshals/unmarshals). Empty
    defaults are `'{}'` / `'[]'` exactly as the models declare.
- **Encrypted secrets stay encrypted** (`enc:...` reversible envelope, same as
  `vision/app/vms/common/crypto.py` / the access service). The node holds the
  decrypt key in its identity material (§5.2). Plaintext credentials are never at
  rest, on the appliance no less than in central.
- **PKs** are the same UUID strings as central so a row migrated down keeps its id
  (federation + read-cache coherence, §8).
- **Migrations** run via a SQLite variant of `gokernel/db.Migrate` (§4.13).

Every table below is the **node's authoritative copy**; the column set mirrors the
corresponding `neubit_vision` / `neubit_nvr` model so migration is a straight
column-for-column copy.

### 4.2 `cameras` (from `vision` `camera.Camera`)

Full column parity — the node needs the whole camera record to record/stream/manage
standalone.

```sql
CREATE TABLE cameras (
  id                    TEXT PRIMARY KEY,             -- uuid string
  tenant_id             TEXT,                          -- nullable
  name                  TEXT NOT NULL,
  is_enabled            INTEGER NOT NULL DEFAULT 1,
  status                TEXT NOT NULL DEFAULT 'offline',   -- online|offline|connecting|error
  brand                 TEXT NOT NULL DEFAULT 'onvif',
  driver                TEXT,
  connection_type       TEXT NOT NULL DEFAULT 'onvif',     -- rtsp|onvif|nvr_channel
  network_info          TEXT NOT NULL DEFAULT '{}',        -- JSON {ip,port,rtsp_port,mac}
  -- ONVIF connection (password reversibly encrypted)
  onvif_host            TEXT,
  onvif_port            INTEGER,
  onvif_user            TEXT,
  onvif_enc_pass        TEXT,                              -- enc:...
  onvif_profile_token   TEXT,
  onvif_capabilities    TEXT NOT NULL DEFAULT '{}',        -- JSON
  onvif_events_enabled  INTEGER NOT NULL DEFAULT 0,
  onvif_event_topics    TEXT NOT NULL DEFAULT '[]',        -- JSON
  -- recording config
  recording_mode        TEXT NOT NULL DEFAULT 'continuous',-- continuous|schedule|motion|manual
  recording_schedule    TEXT NOT NULL DEFAULT '{}',        -- JSON
  recording_fps         INTEGER,
  record_substream      INTEGER NOT NULL DEFAULT 0,
  retention_days        INTEGER NOT NULL DEFAULT 30,
  pre_buffer_seconds    INTEGER NOT NULL DEFAULT 5,
  post_buffer_seconds   INTEGER NOT NULL DEFAULT 5,
  anr_enabled           INTEGER NOT NULL DEFAULT 0,
  audio_enabled         INTEGER NOT NULL DEFAULT 0,
  -- advanced config (JSON)
  privacy_masks         TEXT NOT NULL DEFAULT '[]',        -- normalized shapes
  motion_zones          TEXT NOT NULL DEFAULT '[]',
  motion_config         TEXT NOT NULL DEFAULT '{}',
  pos_overlay           TEXT NOT NULL DEFAULT '{}',
  dewarp                TEXT NOT NULL DEFAULT '{}',
  backchannel           TEXT NOT NULL DEFAULT '{}',
  -- PTZ (denormalized flags; presets/patrols also in their own tables)
  ptz_capable           INTEGER NOT NULL DEFAULT 0,
  ptz_presets           TEXT NOT NULL DEFAULT '[]',        -- JSON (legacy inline; canonical = ptz_presets table)
  -- placement refs (geo owned centrally; refs kept for display)
  site_id               TEXT,
  floor_id              TEXT,
  zone_id               TEXT,
  -- NVR-channel linkage
  nvr_id                TEXT,                              -- FK nvrs(id) ON DELETE SET NULL
  nvr_channel_number    INTEGER,
  -- storage + media-node placement
  storage_pool_id       TEXT,
  media_node_id         TEXT,
  -- stream codec policy
  sub_stream_codec      TEXT,
  web_codec_enforced_at TEXT,
  display_order         INTEGER NOT NULL DEFAULT 0,
  thumbnail_path        TEXT,
  last_seen_at          TEXT,
  last_error            TEXT,
  created_by            TEXT,
  updated_by            TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);
CREATE INDEX ix_cameras_tenant_status ON cameras (tenant_id, status);
CREATE INDEX ix_cameras_tenant_name   ON cameras (tenant_id, name);
CREATE INDEX ix_cameras_nvr           ON cameras (nvr_id);
```

### 4.3 `media_profiles` (from `camera.MediaProfile`)

```sql
CREATE TABLE media_profiles (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT,
  camera_id   TEXT NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
  name        TEXT NOT NULL DEFAULT 'main',   -- main|sub|third
  codec       TEXT,
  resolution  TEXT,                            -- "1920x1080"
  fps         INTEGER,
  rtsp_path   TEXT,
  bitrate     INTEGER,                         -- kbps
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX ix_media_profiles_camera ON media_profiles (camera_id);
```

### 4.4 `nvrs` (from `nvr.NVR` — registered NVR/DVR appliances onboarded as channel sources)

```sql
CREATE TABLE nvrs (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT,
  name          TEXT NOT NULL,
  is_enabled    INTEGER NOT NULL DEFAULT 1,
  brand         TEXT NOT NULL DEFAULT 'onvif',
  driver        TEXT,
  host          TEXT NOT NULL,
  port          INTEGER NOT NULL DEFAULT 80,
  username      TEXT NOT NULL DEFAULT '',
  enc_creds     TEXT,                           -- enc:...
  channel_count INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'unknown',
  storage_info  TEXT NOT NULL DEFAULT '{}',     -- JSON
  capabilities  TEXT NOT NULL DEFAULT '{}',     -- JSON
  version_info  TEXT NOT NULL DEFAULT '{}',     -- JSON
  last_seen_at  TEXT,
  last_error    TEXT,
  created_by    TEXT,
  updated_by    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX ix_nvrs_tenant_status ON nvrs (tenant_id, status);
```

### 4.5 `recording_targets` (existing `neubit_nvr` table, unchanged shape)

Desired recording state; the recording-supervisor reconciles it against MediaMTX
each tick. Carries the P6-A resilience columns.

```sql
CREATE TABLE recording_targets (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id         TEXT NOT NULL,
  camera_id         TEXT NOT NULL,
  profile           TEXT NOT NULL DEFAULT 'main',
  node_id           TEXT,
  path_name         TEXT NOT NULL,               -- cameras/<tenant>/<cam>/<profile>
  record_path       TEXT NOT NULL,               -- MediaMTX recordPath template
  active            INTEGER NOT NULL DEFAULT 1,
  trigger_type      TEXT NOT NULL DEFAULT 'continuous',
  redundant         INTEGER NOT NULL DEFAULT 0,
  secondary_node_id TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE (tenant_id, camera_id, profile)
);
CREATE INDEX ix_recording_targets_active ON recording_targets (active);
```

### 4.6 `recording_segments` (existing `neubit_nvr` dedupe ledger)

Emit-once ledger; on a node this is *also* the local playback index for standalone
playback (no vision round-trip). We keep the durable metadata columns from
`vision`'s `recordings` so the node has a complete local index.

```sql
CREATE TABLE recording_segments (
  path             TEXT PRIMARY KEY,             -- absolute segment file path
  tenant_id        TEXT NOT NULL,
  camera_id        TEXT NOT NULL,
  profile          TEXT NOT NULL DEFAULT 'main',
  started_at       TEXT,
  ended_at         TEXT,
  duration         REAL,
  file_size        INTEGER,
  codec            TEXT,
  resolution       TEXT,
  trigger_type     TEXT NOT NULL DEFAULT 'continuous',
  storage_pool_id  TEXT,
  checksum         TEXT,
  integrity_status TEXT NOT NULL DEFAULT 'unchecked',
  locked           INTEGER NOT NULL DEFAULT 0,   -- evidence-lock (retention-exempt)
  locked_by        TEXT,
  locked_at        TEXT,
  has_motion       INTEGER NOT NULL DEFAULT 0,
  event_markers    TEXT NOT NULL DEFAULT '[]',   -- JSON
  emitted          INTEGER NOT NULL DEFAULT 0,   -- has a NATS event been published?
  emitted_at       TEXT
);
CREATE INDEX ix_recording_segments_camera ON recording_segments (camera_id, started_at);
CREATE INDEX ix_recording_segments_locked ON recording_segments (locked);
```

> Note: `emitted`/`emitted_at` replaces the "the row exists ⇒ emitted" semantics
> of the old ledger, because the node now writes a segment row for its own index
> *before* (and independently of) publishing to central — publishing may be queued
> while offline (§7.4).

### 4.7 `storage_pools` (from `storage.StoragePool`)

```sql
CREATE TABLE storage_pools (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT,
  name              TEXT NOT NULL,
  pool_type         TEXT NOT NULL DEFAULT 'local',   -- local|nfs|smb|s3
  path              TEXT,
  priority          INTEGER NOT NULL DEFAULT 0,
  max_size_bytes    INTEGER,
  is_default        INTEGER NOT NULL DEFAULT 0,
  is_active         INTEGER NOT NULL DEFAULT 1,
  nas_server        TEXT,
  nas_share         TEXT,
  nas_protocol      TEXT,
  nas_username      TEXT,
  nas_enc_password  TEXT,                             -- enc:...
  nas_domain        TEXT,
  nas_mount_options TEXT,
  mount_state       TEXT,
  last_mount_error  TEXT,
  s3_endpoint       TEXT,
  s3_bucket         TEXT,
  s3_region         TEXT,
  s3_access_key     TEXT,
  s3_enc_secret_key TEXT,                             -- enc:...
  s3_use_ssl        INTEGER NOT NULL DEFAULT 1,
  reachable         INTEGER,
  raid_level        TEXT,
  raid_device       TEXT,
  created_by        TEXT,
  updated_by        TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE (tenant_id, name)
);
CREATE INDEX ix_storage_pools_tenant_default ON storage_pools (tenant_id, is_default);
```

### 4.8 `storage_tier_rules` (from `storage.TierRule`)

```sql
CREATE TABLE storage_tier_rules (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT,
  name            TEXT NOT NULL,
  source_pool_id  TEXT NOT NULL,
  target_pool_id  TEXT NOT NULL,
  after_age_hours INTEGER NOT NULL,
  enabled         INTEGER NOT NULL DEFAULT 1,
  last_run_at     TEXT,
  created_by      TEXT,
  updated_by      TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (tenant_id, name)
);
CREATE INDEX ix_storage_tier_rules_enabled ON storage_tier_rules (enabled);
```

### 4.9 `raid_arrays` (from `storage.RaidArray` — node-global hardware health)

Not tenant-scoped: physical to the appliance. Upserted by the RAID monitor (which,
after SP1, runs **on the node** off `mdadm`). This is a first-class reason the
table belongs on the node — RAID is node-local hardware.

```sql
CREATE TABLE raid_arrays (
  device            TEXT PRIMARY KEY,             -- /dev/md0
  level             TEXT NOT NULL DEFAULT 'unknown',
  state             TEXT,
  health            TEXT NOT NULL DEFAULT 'unknown',  -- healthy|degraded|rebuilding|failed|unknown
  working_devices   INTEGER NOT NULL DEFAULT 0,
  failed_devices    INTEGER NOT NULL DEFAULT 0,
  total_devices     INTEGER NOT NULL DEFAULT 0,
  rebuild_status    TEXT,
  rebuild_percent   INTEGER,
  first_degraded_at TEXT,
  last_seen_at      TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX ix_raid_arrays_health ON raid_arrays (health);
```

### 4.10 `ptz_presets` + `ptz_patrols` (from `ptz.PtzPreset` / `ptz.PtzPatrol`)

```sql
CREATE TABLE ptz_presets (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT,
  camera_id    TEXT NOT NULL,
  name         TEXT NOT NULL,
  preset_token TEXT,                              -- on-device token
  position     TEXT,                              -- JSON {pan,tilt,zoom} advisory
  created_by   TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX ix_ptz_presets_camera ON ptz_presets (camera_id);

CREATE TABLE ptz_patrols (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT,
  camera_id  TEXT NOT NULL,
  name       TEXT NOT NULL,
  stops      TEXT NOT NULL DEFAULT '[]',          -- JSON [{preset_id,dwell_seconds}]
  speed      REAL NOT NULL DEFAULT 0.5,
  is_active  INTEGER NOT NULL DEFAULT 1,
  is_running INTEGER NOT NULL DEFAULT 0,           -- operator intent; cycler re-arms
  schedule   TEXT,                                 -- JSON advisory
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX ix_ptz_patrols_camera ON ptz_patrols (camera_id);
```

> Motion zones / privacy masks / motion config are **columns on `cameras`** (4.2),
> matching the current model — no separate tables. They move down with the camera row.

### 4.11 `media_nodes` (existing `neubit_nvr` table, single-row on an appliance)

Retained as the placement seam + heartbeat state the supervisor/recording loops
use. On an appliance this holds exactly one local node row.

```sql
CREATE TABLE media_nodes (
  id             TEXT PRIMARY KEY,                 -- e.g. "mediamtx-0"
  api_url        TEXT NOT NULL,
  hls_base       TEXT NOT NULL,
  webrtc_base    TEXT NOT NULL,
  rtsp_base      TEXT NOT NULL,
  healthy        INTEGER NOT NULL DEFAULT 1,
  last_seen_at   TEXT NOT NULL,
  last_heartbeat TEXT NOT NULL,
  dead_since     TEXT,
  created_at     TEXT NOT NULL
);

CREATE TABLE stream_shards (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id  TEXT NOT NULL,
  camera_id  TEXT NOT NULL,
  profile    TEXT NOT NULL DEFAULT 'main',
  node_id    TEXT NOT NULL REFERENCES media_nodes(id),
  path_name  TEXT NOT NULL,
  rtsp_url   TEXT NOT NULL,
  redundant  INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, camera_id, profile)
);
CREATE INDEX ix_stream_shards_node ON stream_shards (node_id);
```

### 4.12 `anr_jobs` (existing `neubit_nvr` table, unchanged)

```sql
CREATE TABLE anr_jobs (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id           TEXT NOT NULL,
  camera_id           TEXT NOT NULL,
  profile             TEXT NOT NULL DEFAULT 'main',
  gap_from            TEXT NOT NULL,
  gap_to              TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'queued',   -- queued|running|done|failed
  backfilled_segments INTEGER NOT NULL DEFAULT 0,
  error               TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  completed_at        TEXT
);
CREATE INDEX ix_anr_jobs_camera  ON anr_jobs (camera_id, created_at);
CREATE INDEX ix_anr_jobs_status  ON anr_jobs (status);
CREATE UNIQUE INDEX ux_anr_jobs_active ON anr_jobs (tenant_id, camera_id, profile, gap_from, gap_to)
  WHERE status IN ('queued','running');
```

### 4.13 Node-only tables (new)

**`node_identity`** — one row; the node's self. Written at enrollment (§5).

```sql
CREATE TABLE node_identity (
  id                TEXT PRIMARY KEY,             -- node uuid (central node registry id)
  name              TEXT NOT NULL,
  tenant_id         TEXT,                          -- owning tenant (on-prem: the one tenant)
  central_base_url  TEXT,                          -- e.g. https://hq.example.com (nullable = never enrolled)
  node_credential   TEXT,                          -- enc: long-lived node token/secret (§5.2)
  enroll_state      TEXT NOT NULL DEFAULT 'standalone', -- standalone|enrolled|revoked
  jwt_public_key    TEXT,                          -- central's JWT verify key/secret material (for validating central JWTs)
  secret_key_enc    TEXT,                          -- node-local key for enc: fields (wrapped; see §5.2)
  enrolled_at       TEXT,
  last_sync_at      TEXT,                          -- last successful heartbeat/snapshot to central
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
```

**`local_users`** — standalone-console accounts. Mirrors the subset of `core`
`auth.User` needed for local login; NO central roles here (local roles are a fixed
small set).

```sql
CREATE TABLE local_users (
  id                 TEXT PRIMARY KEY,
  username           TEXT NOT NULL UNIQUE,
  full_name          TEXT,
  password_hash      TEXT NOT NULL,                -- argon2id, same hasher as core
  role               TEXT NOT NULL DEFAULT 'operator', -- admin|operator|viewer (local, fixed)
  is_active          INTEGER NOT NULL DEFAULT 1,
  is_bootstrap       INTEGER NOT NULL DEFAULT 0,   -- the install-time admin
  failed_login_count INTEGER NOT NULL DEFAULT 0,
  locked_until       TEXT,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  last_login_at      TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
```

**`local_sessions`** — opaque session tokens for standalone login (hash only).

```sql
CREATE TABLE local_sessions (
  id           TEXT PRIMARY KEY,                   -- session id
  user_id      TEXT NOT NULL REFERENCES local_users(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL,                      -- sha256 of the bearer
  expires_at   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  revoked_at   TEXT
);
CREATE INDEX ix_local_sessions_user ON local_sessions (user_id);
```

**`audit_log`** — append-only local trail (config changes, logins, media grants,
override-accepts). Mirrors central's audit shape so SP3 can forward it.

```sql
CREATE TABLE audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         TEXT NOT NULL,
  actor      TEXT,                                 -- local user id | central user id | 'central' | 'system'
  actor_kind TEXT NOT NULL,                        -- local|central|system
  action     TEXT NOT NULL,                        -- camera.create | recording.config | override.accept ...
  target     TEXT,                                 -- entity id
  detail     TEXT NOT NULL DEFAULT '{}',           -- JSON (diff, ip, etc.)
  forwarded  INTEGER NOT NULL DEFAULT 0            -- has this been shipped to central audit?
);
CREATE INDEX ix_audit_log_ts ON audit_log (ts);
```

**`outbound_queue`** — the offline event/snapshot spool (§7.4).

```sql
CREATE TABLE outbound_queue (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL,                       -- snapshot|recording.segment|event|audit|status
  subject     TEXT,                                -- NATS subject (best-effort) / REST route
  payload     TEXT NOT NULL,                       -- JSON envelope
  attempts    INTEGER NOT NULL DEFAULT 0,
  next_try_at TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX ix_outbound_queue_next ON outbound_queue (next_try_at);
```

**`_migrations`** — the ledger, identical role to the Postgres one:

```sql
CREATE TABLE _migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')));
```

### 4.14 Migration runner (SQLite variant of `gokernel/db.Migrate`)

Follow the existing pattern in `backend/gokernel/db/db.go`: embed
`migrations/*.sql`, `ReadDir` + `sort.Strings` for deterministic order, run each
unapplied file in its own transaction, record it in `_migrations`. Differences for
SQLite:

- Open with `modernc.org/sqlite` (pure-Go, **CGO-free** — keeps the appliance build
  simple and cross-compilable) or `mattn/go-sqlite3` (CGO). **Recommend
  `modernc.org/sqlite`** to avoid a CGO toolchain on the appliance image; validate
  it under recording load (§10 risk).
- One connection for writes (SQLite is single-writer); a small read pool is fine
  under WAL. Set `PRAGMA busy_timeout` + `journal_mode=WAL` on open, before
  migrating.
- The `nvr/migrations/` Postgres files (`0001_baseline` … `0004_resilience`) are
  **retired** for the node build; a new `nvr/migrations_sqlite/` set (`0001_estate`
  bootstrapping every table above) is embedded instead. `main.go` picks the store
  by build/config (SQLite = node/appliance mode).

---

## 5. Node identity, enrollment & local auth

### 5.1 Install-time bootstrap (standalone from second zero)

On first boot with an empty `node.db`:

1. Run `migrations_sqlite` → schema exists.
2. Generate `node_identity`: a fresh node **UUID** (provisional until enrollment
   reconciles it with central's registry id), `enroll_state='standalone'`,
   `central_base_url=NULL`.
3. Generate the node-local **secret key** used to wrap `enc:` fields
   (`secret_key_enc`), derived from an install secret (env `VE_NODE_SECRET` or a
   generated value printed once to the install log / sealed file). This is the
   node's own crypto root so encrypted camera/NAS/S3 creds work offline.
4. Create the **bootstrap admin** `local_user` (`role='admin'`, `is_bootstrap=1`,
   `must_change_password=1`). Credentials come from install env
   (`VE_NODE_ADMIN_USER` / `VE_NODE_ADMIN_PASSWORD`) or a generated password
   emitted once to the install log. Password hashed with the **same argon2id
   hasher `core` uses** (reuse the shared kernel hasher).

Result: before any central contact, an engineer can log into the node console
(SP2) with the bootstrap admin and fully configure cameras/recording/storage.

### 5.2 Enrollment (one-time, node ↔ central mutual trust)

Chosen mechanism: **signed join-token → per-node long-lived credential.** (mTLS
considered — see §5.3.)

1. **Central mints a join-token.** In the central console "Add Node", central
   creates a node registry row (id, name, tenant) and issues a **short-lived signed
   join-token**: a JWT signed with central's key, claims
   `{typ:"node-join", node_id, tenant_id, iss, iat, exp (~15 min), jti}`. Central
   stores the `jti` as single-use.
2. **Operator pastes the token on the node** (console field or
   `VE_NODE_JOIN_TOKEN` env at install).
3. **Node calls `POST {central}/api/v1/vms/nodes/enroll`** with the join-token +
   its self-generated node public identity (node UUID, hostname, version,
   MediaMTX endpoints). Central verifies the token signature + `jti` single-use +
   not-expired, binds the node row to the presented identity, and returns:
   - a **long-lived node credential** — a node-scoped bearer (JWT
     `{typ:"node", node_id, tenant_id, permissions:["node.self"]}` with a long/renewable
     TTL, or an opaque secret the node presents as `X-Node-Credential`). The node
     stores it **encrypted** in `node_identity.node_credential`.
   - central's **JWT verification material** (`jwt_public_key` / the shared HS256
     secret handle) so the node can validate *central-user* JWTs that arrive on
     `/api/v1/nvr/*` (§5.4). In the current stack JWTs are HS256 with a shared
     `jwt_secret`; enrollment is where the node receives/derives that trust anchor.
   - the reconciled **registry node id** + owning tenant.
4. Node persists all of it, sets `enroll_state='enrolled'`, `enrolled_at`,
   `central_base_url`, and begins heartbeating (§7).

The join-token is **one-time and expiring**; the durable per-node credential is
what authenticates every subsequent node→central call. Revocation: central flips
the node row → central rejects the node credential → node observes 401 on
heartbeat and can surface "unenrolled" locally (it keeps running standalone).

### 5.3 Why signed join-token + per-node credential (not mTLS)

- **Ergonomics:** a copy-pasteable token is trivial for a field installer; issuing
  + distributing client certs to appliances is heavier operationally.
- **Consistency:** the whole stack already trusts HS256 JWTs on a shared secret
  (`gokernel/auth`, `media_token.py`); a signed join-token + node JWT reuses that
  machinery with zero new verification code paths.
- **Offline-first:** the node credential is a self-contained bearer the node holds
  locally; it does not require a live TLS handshake against a CA to *be* trusted,
  which matches "central is optional."
- **mTLS remains an option** as a transport hardening layer *on top* (Traefik can
  require client certs on the node-facing routes for defence-in-depth), but it is
  **not** the identity mechanism. Recommendation: ship token+credential in SP1;
  offer mTLS as an opt-in deployment hardening in a later phase.

### 5.4 Request authentication on the node (dual-mode)

The node's HTTP surface accepts **three** credential kinds, resolved by one auth
middleware that yields a unified `Caller`:

| Credential | Presented as | Verified by | Used for |
|---|---|---|---|
| **Central user JWT** | `Authorization: Bearer <jwt>` | existing `gokernel/auth` verifier against the enrollment-provided secret | central operators driving the node via federation (control cmds), and the existing `/api/v1/nvr/*` routes |
| **Node credential** | `X-Node-Credential` / Bearer | verify signature + `enroll_state=enrolled` | central→node control-plane calls that act *as the node* (override push, snapshot ack) |
| **Local session** | `Authorization: Bearer <local>` (opaque) | lookup `local_sessions` by `token_hash`, check `expires_at`/`revoked_at` | standalone console login (SP2), local API use with no central |

Route policy:
- `/health` — public (unchanged).
- `/api/v1/nvr/*` (existing streams/recording/playback/anr internal endpoints) —
  **central JWT or node credential** (unchanged behaviour for federation; today
  they are called by vision).
- `/api/v1/nvr/estate/*` (new) — **any of the three** (a local admin, or a central
  operator with `vms.*` permissions, or the node itself replaying an override).
  Permission checks reuse the `vms.*` catalog for central JWTs; local users map to
  the fixed local roles (admin ⊇ operator ⊇ viewer).

Media tokens are a **separate** credential kind (`sub_type:"media"`), not accepted
on the management API — see §5.5.

### 5.5 Node-issued media tokens (standalone viewing)

Today `vision/app/vms/live/service.py` mints the media token and Traefik
ForwardAuth calls **vision** to verify it. For a node to stream standalone, the
**node** must issue and verify media tokens:

- `POST /api/v1/nvr/estate/cameras/{id}/live` (and `/playback`) on the node mints a
  media token — same claim shape as `media_token.py`
  (`{sub_type:"media", tenant_id, camera_id, session_id, mode, iat, exp}`), signed
  with the node's trust anchor (the enrollment-shared HS256 secret, so a
  central-verified and node-verified media token are interchangeable when enrolled;
  when standalone the node signs with its own key and verifies against itself).
- The node exposes a **verify** endpoint the co-located MediaMTX ForwardAuth points
  at (`GET /api/v1/nvr/media/verify`) — a single HMAC verify, no DB hit, mirroring
  vision's hot path. MediaMTX config points ForwardAuth at the local node, not
  central.
- Consequence: live + recorded playback work with central fully offline. The
  cross-federation media-token trust (a central-minted token viewed via a node)
  is an **open question** for SP3 (§10).

---

## 6. API surface

### 6.1 New — `/api/v1/nvr/estate/*` (node-authoritative estate management)

Mirrors the surface `vision/app/vms/cameras/router.py` exposes today, so the node
is fully drivable with no control plane. All are dual-auth (§5.4) and emit
`audit_log` rows.

**Cameras**
- `GET    /api/v1/nvr/estate/cameras` — list (filter by status/name/site/nvr).
- `POST   /api/v1/nvr/estate/cameras` — create (optional device probe → autofill
  profiles, like `cameras/service.create(probe=True)`).
- `GET    /api/v1/nvr/estate/cameras/{id}` — get (with profiles).
- `PATCH  /api/v1/nvr/estate/cameras/{id}` — update.
- `DELETE /api/v1/nvr/estate/cameras/{id}` — delete (cascade profiles/shards).
- `POST   /api/v1/nvr/estate/cameras/bulk` — bulk enable/disable/delete/set-retention.
- `POST   /api/v1/nvr/estate/cameras/reorder` — display order.
- `GET/PUT /api/v1/nvr/estate/cameras/{id}/motion-config | privacy-masks | motion-zones | onvif-events`
  — the advanced-config sections (store-local + best-effort device push).
- `PATCH  /api/v1/nvr/estate/cameras/{id}/imaging | io` — device config.
- `GET    /api/v1/nvr/estate/cameras/{id}/snapshot` — snapshot (device or MediaMTX).
- `POST   /api/v1/nvr/estate/cameras/{id}/apply-stream-policy` — G8 web-codec enforce.

**Discovery / onboarding** (driver-backed, graceful — never 500)
- `POST /api/v1/nvr/estate/discover` — ONVIF WS-Discovery on the node's LAN.
- `POST /api/v1/nvr/estate/probe` — probe host/port/creds → device info.
- `POST /api/v1/nvr/estate/channels` — enumerate NVR channels.
- `POST /api/v1/nvr/estate/bulk-add` — enumerate + add many channels (mirrors
  `cameras/service.bulk_add`).

> Drivers: the node needs the **driver layer** available locally to
> discover/probe/snapshot standalone. Whether the Go node calls out to a
> polyglot driver sidecar (per `ARCHITECTURE.md` §5 driver strategy) or embeds a
> Go ONVIF client is a build decision flagged for SP1 implementation; the *API
> contract* above is driver-agnostic.

**NVRs**
- `GET|POST|GET{id}|PATCH{id}|DELETE{id} /api/v1/nvr/estate/nvrs` — registered
  NVR/DVR appliance CRUD (channel sources).

**Recording config**
- `GET|PUT /api/v1/nvr/estate/cameras/{id}/recording` — mode/schedule/fps/
  substream/retention/buffers/anr/audio (writes `cameras` recording fields →
  recording-supervisor reconciles `recording_targets`).
- `POST /api/v1/nvr/estate/cameras/{id}/recording/start | stop` — manual trigger.

**Storage / RAID**
- `GET|POST|PATCH{id}|DELETE{id} /api/v1/nvr/estate/storage/pools` — pool CRUD
  (local/nfs/smb/s3; secrets encrypted).
- `POST /api/v1/nvr/estate/storage/pools/{id}/test` — reachability/mount test.
- `GET|POST|PATCH{id}|DELETE{id} /api/v1/nvr/estate/storage/tier-rules`.
- `GET /api/v1/nvr/estate/storage/raid` — live `raid_arrays` health.

**PTZ**
- `GET|POST|DELETE /api/v1/nvr/estate/cameras/{id}/ptz/presets` (+ `goto`).
- `GET|POST|PATCH|DELETE /api/v1/nvr/estate/cameras/{id}/ptz/patrols` (+ `start`/`stop`).
- `POST /api/v1/nvr/estate/cameras/{id}/ptz/move` — continuous move/zoom/focus.

**Live / playback (node-issued media)**
- `POST /api/v1/nvr/estate/cameras/{id}/live` — start live session, mint media token
  → gateway-routed HLS/WHEP URLs (§5.5).
- `POST /api/v1/nvr/estate/cameras/{id}/playback` — recorded playback session.
- `GET  /api/v1/nvr/estate/recordings` — local playback index (from
  `recording_segments`), filter by camera + time window.

**Node self**
- `GET /api/v1/nvr/estate/node` — node identity + enroll state + sync status.
- `GET /api/v1/nvr/estate/health` — local diagnostics summary (streams, recording,
  storage, RAID, DB).

**Local auth (standalone console — consumed by SP2)**
- `POST /api/v1/nvr/estate/auth/login` — local user login → local session token.
- `POST /api/v1/nvr/estate/auth/logout`.
- `GET|POST|PATCH|DELETE /api/v1/nvr/estate/local-users` — manage local operators
  (admin only).

**Media verify (MediaMTX ForwardAuth target)**
- `GET /api/v1/nvr/media/verify` — validate a node-issued media token (hot path).

### 6.2 Existing `/api/v1/nvr/*` — kept as-is

- `GET /api/v1/nvr/whoami` — cross-language JWT proof.
- `GET /api/v1/nvr/status` — data-plane status.
- `streams.Mount` — internal stream-orchestration (ensure/idle).
- `recording.Mount` — start/stop/status.
- `playback.Mount` — recorded-range resolution.
- `anr.Mount` — backfill jobs.

These continue to serve **central/federation** callers (control commands). SP1
repoints their persistence to SQLite and lets them read desired-state from the
estate tables, but does not change their contracts.

---

## 7. Federation touchpoints (node side — the contract SP3 builds against)

SP1 implements the **node side** (or stubs it behind a `federation.enabled` flag);
SP3 builds central's side. The contracts:

### 7.1 Enrollment (node → central) — §5.2
`POST {central}/api/v1/vms/nodes/enroll` with join-token + node identity →
`{node_id, node_credential, jwt_anchor, tenant_id}`. Node persists into
`node_identity`.

### 7.2 Heartbeat + estate snapshot (node → central)
- **Heartbeat** (light, frequent, e.g. every 15s): `POST {central}/api/v1/vms/nodes/{id}/heartbeat`
  (or NATS `tenant.<id>.vms.node.heartbeat`) with `{node_id, ts, version, streams_active,
  recording_active, storage_free_bytes, raid_health, db_ok}`. Central updates
  `media_nodes.last_heartbeat` in its registry read-cache.
- **Estate snapshot** (heavier, periodic + on-change): the node's full estate
  (cameras + profiles + recording config + storage + RAID + PTZ counts) as a
  versioned document with a monotonically increasing `snapshot_version` and a
  content hash. Sent on: enrollment, every N minutes, and **on any local estate
  write** (debounced). Central replaces its read-cache partition
  (`WHERE media_node_id = <node>`) with the snapshot (last-writer-wins by
  `snapshot_version`). Transport: REST `PUT {central}/api/v1/vms/nodes/{id}/snapshot`
  primary; NATS `tenant.<id>.vms.node.snapshot` best-effort mirror.
- **Recording segment events** continue on `tenant.<id>.vms.recording.segment`
  (existing) — but now queued offline (§7.4) rather than assumed-delivered.

### 7.3 Override accept (central → node)
Central sets a config field authoritatively (e.g. bump a camera's retention across
the fleet). Contract: `PUT /api/v1/nvr/estate/cameras/{id}` (or a dedicated
`POST /api/v1/nvr/estate/override`) carrying `{fields, origin:"central",
override_id, actor}` authenticated by a central JWT or node credential. The node:
1. **Persists it as its new local truth** (node-authoritative rule: an override is
   an accepted intentful push, not a shadow value).
2. Writes an `audit_log` row `action=override.accept`.
3. Bumps `snapshot_version` and re-publishes the snapshot so central's cache re-converges.

There is **no silent central-master field**: after accept, the node owns the value;
a later local edit wins until the next override.

### 7.4 Offline queue + replay
- Every outbound message (snapshot, segment event, audit forward, status) is
  written to `outbound_queue` first, then a drainer attempts delivery and deletes
  on success; failures back off via `next_try_at`. This makes offline the default
  path, not an error path.
- On reconnect the drainer flushes the queue oldest-first; the node also pushes a
  **fresh full snapshot** so central re-converges regardless of any dropped deltas.
- Inbound control commands that arrive while a prior state is stale are safe because
  the node is authoritative — it applies the override to *current* local truth and
  re-publishes.

### 7.5 What SP1 ships vs stubs
SP1 ships: the outbound queue table + drainer, the snapshot builder, the heartbeat
payload, the enroll client, the override-accept endpoint. SP1 **stubs** the actual
central endpoints (they 404 until SP3) behind `federation.enabled=false` default so
the node runs pure-standalone until a central exists. Nothing in the node's own
operation depends on any of these succeeding.

---

## 8. Migration plan — the 3 existing neubit_v3 projects

Goal: for each existing project, take the central-owned cameras/estate in
`neubit_vision`, **partition by `media_node_id`**, and push each partition **down**
into that node's SQLite, then flip the node to authoritative + central to
federation mode. **Safe + reversible.** (The tool itself is built in **SP3**; SP1
specifies it.)

### 8.1 Preconditions
- Every camera already carries `media_node_id` (present in the model). Cameras with
  `media_node_id = NULL` are assigned to the appropriate node first (a pre-step
  the tool reports and refuses to guess).
- Each target node is enrolled (§5.2) and reachable.

### 8.2 One-time partition-and-push tool (`vms-node-migrate`)
Per node:
1. **Export** from `neubit_vision`: `SELECT ... WHERE media_node_id = <node>` for
   `cameras`, `media_profiles`, `recordings` (→ `recording_segments` index),
   `storage_pools`, `storage_tier_rules`, `ptz_presets`, `ptz_patrols`; plus the
   node's `recording_targets`/`stream_shards`/`anr_jobs` from `neubit_nvr`. Emit a
   signed **migration bundle** (JSON) carrying `source_snapshot_version`.
2. **Dry-run validate**: schema/enc-field/tenant checks; report row counts +
   conflicts. No writes.
3. **Import** into the node via a privileged endpoint
   `POST /api/v1/nvr/estate/import` (node-credential auth): upsert-by-id
   (idempotent), preserving UUID PKs. Encrypted fields are re-wrapped from central's
   key to the node's key (`crypto` re-encrypt).
4. **Verify**: node returns its post-import estate snapshot; the tool diffs it
   against the export (id-for-id). Must match.
5. **Flip**: mark the node `authoritative=true` centrally; central switches those
   cameras to **read-cache mode** (stops writing them, starts consuming the node's
   snapshot). The node begins heartbeating its estate.

### 8.3 Safety + reversibility
- **Nothing is deleted from central during migration.** Central's rows become a
  read-cache seeded from the last authoritative state; the export bundle + a
  central DB snapshot are retained as the rollback source.
- **Reversible flip:** to roll back a node, set `authoritative=false` centrally and
  re-enable central writes for that partition; the central rows are still present
  (they were never dropped) and simply resume being master. The node can keep its
  SQLite copy (harmless) or be reset.
- **Idempotent:** re-running import upserts by id — safe to retry a partial run.
- **Per-node, incremental:** projects migrate one node at a time; a node in
  legacy-mode and a node in authoritative-mode coexist during rollout (§3.3).
- **Round-trip test** gates the flip (§9).

---

## 9. Testing strategy

1. **Offline standalone operation (the headline test).** Boot a node with
   `federation.enabled=false`, empty `node.db`, **no central, no external DB, no
   network**. Verify: migrations apply; bootstrap admin login works; create a
   camera via `/estate/cameras`; recording-supervisor starts recording it against
   the co-located MediaMTX; segments land + index in `recording_segments`; live +
   recorded playback work via node-issued media tokens; storage pool + PTZ preset
   CRUD work. This proves "self-sufficient mini-VMS."
2. **Migration runner.** Fresh `node.db` → all tables + indexes created; re-run =
   no-op (idempotent `_migrations`); a new migration applies once. Concurrency:
   run migrations while WAL readers are open.
3. **Enrollment.** Mock central mints a join-token → node enrolls → persists node
   credential + jwt anchor; expired/replayed join-token rejected; revoked node sees
   401 on heartbeat but keeps running standalone.
4. **Dual auth.** `/estate/*` reachable with (a) local session, (b) central JWT
   with `vms.*` perm, (c) node credential; rejected without any; media token
   rejected on the management API; local viewer/operator/admin role gating.
5. **Override accept.** Central pushes a field → node persists as new truth + audit
   row + snapshot re-publish; a subsequent local edit wins over the stale central
   value.
6. **Offline queue + replay.** Central down → estate edits + segment events spool in
   `outbound_queue`; on reconnect the queue drains oldest-first and a fresh full
   snapshot is pushed; central read-cache converges to the node's truth.
7. **Migration round-trip (the reversibility gate).** Seed `neubit_vision` with a
   node's cameras → export bundle → import into node → node snapshot diff matches
   export id-for-id → flip → central read-cache matches → **roll back** → central
   resumes as master with zero data loss. Encrypted creds decrypt correctly on the
   node after key re-wrap.
8. **SQLite under recording load.** Sustained segment-index writes + config writes +
   snapshot reads concurrently (WAL, `busy_timeout`), at target channel count, with
   no `SQLITE_BUSY` errors surfacing to callers (§10).

---

## 10. Open questions / risks

1. **Media-token trust across federation.** When enrolled, node and central share
   the HS256 anchor so tokens interoperate; **standalone** the node signs with its
   own key. A central-minted token viewed *through* a node (or vice-versa) after a
   key rotation needs a defined trust/rotation story — deferred to **SP3**
   (§5.5). Risk: a viewer holding a central token can't view a node that lost its
   anchor. Mitigation: node always accepts its own-signed tokens; central relay
   (SP3) re-mints as needed.
2. **Gateway routing to per-node MediaMTX.** Today Traefik routes `/media/*` to
   *the* MediaMTX with ForwardAuth → vision. With many autonomous nodes, central's
   gateway must route a viewer to the **correct node's** MediaMTX + that node's
   verify endpoint. On-prem single-node is trivial; multi-node/cloud routing
   (per-node path prefix or node-id in the media path) is an **SP3** design item.
3. **SQLite concurrency under recording load.** Single-writer + WAL should handle a
   recorder that writes one segment-index row per segment per camera plus periodic
   config writes, but this must be **load-validated** at target channel count.
   Mitigations if it bites: batch segment-index inserts, a single serialized writer
   goroutine (Go channel-fed), `busy_timeout`, and keeping hot read paths on WAL
   read connections. Choice of `modernc.org/sqlite` (CGO-free) vs `mattn/go-sqlite3`
   (CGO, historically faster) is part of this validation.
4. **Keeping central's read-cache coherent.** Best-effort NATS + periodic snapshots
   can drift if a snapshot is lost and no edit follows. Mitigation: `snapshot_version`
   + content hash on every heartbeat lets central detect drift and pull a fresh
   snapshot; periodic full snapshots bound staleness. Define the reconcile cadence
   in SP3.
5. **Driver locality.** Discovery/probe/snapshot need a driver on the node. If
   drivers stay a polyglot sidecar (per `ARCHITECTURE.md` §5) the appliance image
   must bundle it; if the Go node embeds an ONVIF client, feature parity with the
   Python drivers must be verified. Decision flagged for SP1 implementation.
6. **Local-user ↔ central-user overlap.** A person may have both a central account
   and a local operator account; SP1 keeps them **separate namespaces** (local
   users never sync to central). Whether central identities should be usable
   offline (cached) is a future question — out of scope for SP1.
7. **Enc-key custody on the appliance.** The node's `secret_key_enc` root protects
   camera/NAS/S3 creds at rest. Where the wrapping key lives (env, sealed file, TPM)
   is a hardening decision; SP1 supports env/sealed-file, TPM is a later option.
8. **Legacy/authoritative coexistence window.** During SP3 rollout a node may be
   mid-flip. The `authoritative` flag must be the single switch that decides who
   writes; a split-brain (both central and node writing the same camera) is the
   thing to prevent — the flip is atomic per node and central stops writing before
   the node starts heartbeating.

---

## Appendix A — decision summary

- **Store:** embedded **SQLite** (`node.db`, WAL, one file), pure-Go
  `modernc.org/sqlite` (CGO-free) recommended; migration runner mirrors
  `gokernel/db.Migrate`.
- **Ownership:** node authoritative for cameras/profiles/recording/storage/RAID/
  PTZ/motion+privacy/ANR/identity/local-users/audit; central authoritative for
  registry/tenants/central-identity/PSIM/cross-node/read-cache.
- **Identity:** signed **join-token → per-node long-lived credential** (mTLS
  optional transport hardening, not the identity mechanism).
- **Auth:** dual-mode — central JWT / node credential / local session; media tokens
  a separate kind, node-issued + node-verified for standalone viewing.
- **API:** new `/api/v1/nvr/estate/*` mirrors `vision`'s camera/recording/storage/
  ptz surface; existing `/api/v1/nvr/*` internal endpoints unchanged.
- **Federation (node side):** heartbeat + versioned estate snapshot + override-accept
  + `outbound_queue` offline spool; central side is SP3, stubbed behind
  `federation.enabled=false` so SP1 runs pure-standalone.
- **Migration:** per-node partition-by-`media_node_id`, export → import (upsert-by-id,
  re-wrap enc) → verify → flip; **nothing deleted from central**, reversible via the
  `authoritative` switch.
- **Scope boundary:** Node Console UI = SP2; Federation refactor + migration tool =
  SP3; PSIM/access stay central.
