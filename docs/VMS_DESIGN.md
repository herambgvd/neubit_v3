# neubit_v3 — VMS (Video Management System) design spec

Status: **DRAFT for review** (no code yet). Owner decisions locked so far: media server = **MediaMTX**; approach = **spec-first**; scale = **scale-first (1000 cameras, 2×500 real orders)**.

This spec grounds the VMS in two existing, working codebases:
- **gvd_nvr** (`/Users/snowden/office/side_project/gvd_nvr`) — a full, de-AI'd FastAPI+React NVR. The **feature + port base** (cameras, ONVIF, recording, storage, playback, events, PTZ/imaging/IO/audio, ANR). Currently single-tenant + go2rtc.
- **neubit_v2** (`.../neubit_v2/backend/{platform,vision}`) — the production PSIM's camera architecture. Already **MediaMTX-based**, with a clean master/streaming split + a Kafka event contract we mirror onto NATS. The **architecture reference**.

---

## 1. Goals & non-goals

**Goals**
- A multi-tenant VMS that onboards RTSP/ONVIF cameras + NVRs, streams live to the browser, records + retains video, plays back, and feeds camera events into the existing workflow correlation engine → incidents.
- **Scale-first**: designed for 1000 cameras/tenant from day one (media-node sharding, event aggregation, segment/storage strategy that survives the file-count + poll-count blowups gvd_nvr hits at scale).
- Reuse gvd_nvr feature-for-feature; adapt to v3 conventions (kernel, NATS spine, shared-JWT, multi-tenant, Traefik gateway, Next.js feature-folder dark UI).
- Light up what's already waiting on cameras in v3: **Events alarm-monitor** (live video on incident cards + Map camera markers) and **Devices → Cameras/NVR** + **Streaming** nav sections (currently "Soon").

**Non-goals (explicitly OUT)**
- AI/analytics (face/ANPR/object/behaviour) — that's Vizor.ai / `octosense` / `vision`-AI, a separate track. VMS only carries *device* events (motion/tamper/IO/line/zone from ONVIF) + health/recording events. AI detections plug in later as just another event source.
- fire / access — already shipped.

---

## 2. Service topology (scale-first)

v2's proven split, mapped to v3:

```
                         NATS JetStream spine (tenant.<id>.vms.* , tenant.<id>.device.camera.*)
                                      ▲                       │
   ┌──────────────┐   camera CRUD     │  vms.* events         ▼  consume
   │   core       │  (device master)  │                 ┌───────────┐
   │ sites/floors │──device.camera.*──┘                 │ workflow  │→ incidents (alarm monitor)
   │ DevicePlace  │◀───────────────────────────────────▶│correlation│
   └──────────────┘                                     └───────────┘
        ▲ site/floor/zone
        │
   ┌────┴───────────────────────────────────────────────────────────────┐
   │  vms service  (FastAPI + kernel, DB neubit_vms, multi-tenant)        │
   │  • cameras + NVR master + config + groups + linkage + health         │
   │  • ONVIF discovery/probe/channels + PullPoint event ingestion        │
   │  • stream-supervisor: assigns cameras → media nodes (sharding)       │
   │  • playback session issuer (live + recorded + export)                │
   └───────┬───────────────────────────┬─────────────────────────────────┘
           │ upsert path / record        │ enqueue record/retention jobs
           ▼                             ▼
   ┌───────────────┐  N nodes    ┌────────────────────┐
   │  MediaMTX #k   │◀──RTSP/──── │ recording/retention│  ffmpeg segmenter + tiering + ANR
   │ (media node)   │   ONVIF     │  worker pool        │
   │ WebRTC/HLS out │─cameras     └─────────┬──────────┘
   └──────┬─────────┘                        ▼
          │ browser plays DIRECT        storage: local / NFS/SMB / S3(MinIO), per-tenant, tiered
          ▼  (WebRTC/HLS, token via Traefik ForwardAuth)
       operator UI
```

**Components**
1. **`vms` service** (new `backend/vms/`, Python FastAPI + kernel + own DB `neubit_vms`). Owns camera/NVR master records, config (recording/PTZ/imaging/IO/motion/privacy), groups, linkage rules, ONVIF discovery + event ingestion, health, and the **stream-supervisor** (camera→media-node assignment). Publishes `tenant.<id>.vms.*`; also emits/consumes `tenant.<id>.device.camera.*` so `core`/sites and the Events map stay in sync.
   - *Open decision D1:* camera master in `core` (like other device registries) vs owned by `vms`. Recommendation: **`vms` owns the master** (cameras are a heavy, self-contained domain; core just holds DevicePlacement + site tree). `vms` emits `device.camera.*` for cross-service consumers.
2. **MediaMTX media nodes** (1..N containers). RTSP ingest → WebRTC/HLS/RTSP out + on-server recording. Path = `cameras/<tenant>/<camera_id>/<profile>`. Browser plays **directly** from MediaMTX (never proxied through the API); auth via a short-lived token validated at Traefik (ForwardAuth) per playback session. Scale = add nodes; the stream-supervisor shards cameras across nodes (by NVR-group / consistent hash) and keeps a `camera → node` routing table.
3. **recording/retention worker(s)** (Celery, like workflow) — ffmpeg segmenter, retention/tiering sweeps, ANR gap-backfill, integrity/checksum, export jobs. Throttled spawn (max K ffmpeg starts/sec) so a 500-camera bulk-start doesn't thundering-herd the box.
4. **camera/NVR drivers** (`backend/drivers/camera`, `drivers/nvr-estate`) — reuse the **brand-connector pattern** we built for access (ControllerConnector → DDSConnector). ONVIF is the default driver; brand SDKs (Hik/Dahua/etc.) drop in as connectors. Motion/analytics events arrive through the driver → normalized → NATS.

---

## 3. Scale-first decisions (the 1000-camera specifics)

gvd_nvr works but breaks at fleet scale; the map flagged exactly where. Scale-first answers each:

| Bottleneck (gvd_nvr) | Scale-first design |
|---|---|
| One global go2rtc instance, no isolation | **N MediaMTX nodes**, cameras sharded across nodes by a stream-supervisor; per-tenant path namespace + auth |
| 1 ONVIF PullPoint task/camera, poll every 2s (= ~500 PullMessages/s @1000 cams) | **Event-ingestion worker pool** with bounded concurrency; batch PullMessages; subscription renew scheduler; per-node aggregation, not 1000 asyncio tasks in one process |
| 60s MP4 segments = 1.44M files/day @1000 cams (fs index pressure) | **HLS segments + m3u8** (configurable 5–15 min), or MediaMTX-native recording; **inotify** for segment tracking (not stderr parsing); manifest-per-camera-per-day |
| Watchdog probes every camera every ~60s (O(N) RTSP) | Health from **MediaMTX read state + per-node agents**; bounded sweep pool; health rows **auto-purged** (retention) |
| Single storage root | **per-tenant storage** (bucket/prefix); pool tiering warm→cold (local→NFS/S3); retention per-camera/global |
| No tenant_id anywhere; globally-unique group/pool names | **tenant_id on every table**; names unique per (tenant); per-tenant discovery network config |
| Recording/events tables unbounded | time-partitioned recordings/events (partition by tenant+month or Timescale-style); composite indexes (camera_id, start_time)/(camera_id, triggered_at) |
| Bulk start spawns N ffmpeg at once | **throttled job queue** (rate-limited spawns), backpressure |

**Sharding model:** stream-supervisor keeps `MediaNode` + `StreamShard` (camera_id → node_id, profile). Assignment by NVR-group affinity (a 16-ch NVR's cameras land on one node) + load balance. On node loss, shards reassign. This mirrors v2's "cameras group by nvr_id/channel" + a real placement table.

---

## 4. Data model (tenant-scoped; ported from gvd_nvr + v2)

Every table carries `tenant_id`. Master records live in `vms`; DevicePlacement stays in `core/sites/device` (already built).

- **Camera** — id, tenant_id, name, is_enabled, status; streams (main/sub/detect RTSP), codec/res/fps/bitrate; ONVIF (host/port/enc-creds/profile_token/events_enabled/topics/ptz_capable/presets); recording (mode continuous|schedule|motion|manual, schedule JSON, fps, record_substream, retention_days, pre/post-buffer, anr_enabled); advanced (privacy_masks, motion_config, pos_overlay, dewarp, backchannel); placement refs (site_id/floor_id/zone_id — mirror to core DevicePlacement); nvr_id + nvr_channel_number; storage_pool_id; media_node_id (shard); health cache; display_order; thumbnail.
- **NVR** — id, tenant_id, name, brand/driver, host/creds, channel_count, status, storage config; channels ↔ cameras.
- **MediaProfile** — per camera: name (main/sub), codec, resolution, fps, rtsp_path.
- **Recording** — id, tenant_id, camera_id, file/manifest path, start/end, duration, size, resolution/fps/codec, stream_type, trigger_type (continuous|motion|event|manual), locked/locked_by, checksum, integrity_status, has_motion, event_markers[], storage_pool_id, redundant_path. **Partitioned by (tenant, month).**
- **StoragePool** — id, tenant_id, name, path/bucket, type (local|nfs|smb|s3), max_size, priority, NAS fields, raid_level, is_default. **TierRule** — source→target pool after age.
- **CameraGroup** — tenant-scoped (name unique per tenant), color, cameras, user ACL.
- **Event** — id, tenant_id, camera_id?, event_type, severity, title/desc, source_service, dedup_key, triggered_at; ack fields; snapshot_path/recording_id; (AI fields optional for later). **LinkageRule** — trigger + filter + camera scope + actions[] (start_recording, notify, webhook, trigger_output) + cooldown/schedule.
- **PlaybackSession** — id, tenant_id, camera_id, kind (LIVE|RECORDED|EXPORT), mediamtx_path, hls_url, webrtc_url, rtsp_url, recording_window, token, expires_at.
- **CameraHealth** — camera_id, bitrate/fps/packet_loss/latency/status, captured_at. **Retention-purged.**
- **MediaNode / StreamShard** — node registry + camera→node assignment (sharding).
- **Snapshot**, **Bookmark**, **ANRJob** — as in gvd_nvr.

---

## 5. API surface (`/api/v1/vms`, tenant-scoped)

Media is **never** proxied through the API — the API issues playback sessions and the browser hits MediaMTX directly.

- **Cameras**: CRUD; `onvif/discover|probe|channels|snapshot|bulk-add`; `{id}/stream-urls` (issues PlaybackSession → HLS/WebRTC URLs); `{id}/test-connection`; `{id}/snapshot|thumbnail`; PTZ/imaging/io/system/audio/credentials sub-routers; `{id}/motion-config`, `{id}/privacy-masks`, `{id}/onvif-events`; groups CRUD + ACL; bulk (enable/disable/record/move/retention/delete, cap 200) + reorder; `health/latest`; `{id}/anr/*`.
- **NVR**: CRUD; discovery; channel enumeration/mapping; storage config; status.
- **Playback**: `POST /playback/sessions` (live|recorded|export → URLs); `GET /recordings/timeline/{camera_id}?day=`; `GET /recordings/playback/{camera_id}?from=&to=` (continuous HLS); `recordings` list/lock/delete/download; bookmarks; clip export (ffmpeg concat → mp4, token download).
- **Events**: list/get/ack/false-alarm/note; stats; `timeline/{camera_id}`; linkage-rules CRUD; SSE/WS live (reuse core realtime-bridge pattern → `tenant.<id>.vms.>`).
- **Storage**: pools CRUD (local/NFS/SMB/S3); tier-rules; retention config; usage.
- **Media nodes / shards**: node registry, shard assignments (admin).

---

## 6. Media pipeline (MediaMTX)

- **Path**: `cameras/<tenant_id>/<camera_id>/<profile>`; `MediaMTXClient.upsert_path(path, source=rtsp://…)` (source may include enc-creds). Live prefers **sub-stream** for bandwidth.
- **Live**: browser gets `webrtc_url` (WHEP, ~sub-second) with **HLS fallback** (`/index.m3u8`, native `<video>`). No MSE dependence (v2 dropped it). Multi-cam wall reuses gvd_nvr `videoWall.js` layout math.
- **Recording**: MediaMTX-native record (or ffmpeg pull from the node's RTSP out) → HLS segments + manifest to the camera's storage pool; privacy-mask/POS overlay only re-encode when set (else `-c copy`).
- **Auth**: playback session mints a short-lived token; **Traefik ForwardAuth** validates it before proxying to the MediaMTX node (per-tenant, per-session). No creds in the browser.
- **Snapshot/export**: ffmpeg single-frame + concat-remux for clips.

---

## 7. Events → correlation (the payoff)

Camera event sources → `vms` normalizes → persists Event → publishes NATS. Subjects (mirroring v2 Kafka → v3 spine; workflow already subscribes `tenant.*.vms.>`):

- `tenant.<id>.vms.camera.motion` `{camera_id, zone, confidence}` (ONVIF PullPoint MotionAlarm / analytics)
- `tenant.<id>.vms.camera.tamper|video_loss|online|offline` `{camera_id, reason}`
- `tenant.<id>.vms.camera.line_crossing|zone_intrusion|io_input|audio` (ONVIF RuleEngine/IO/audio)
- `tenant.<id>.vms.recording.started|stopped` `{camera_id, profile}`
- `tenant.<id>.vms.storage.low|disk_full`, `tenant.<id>.device.nvr.status`
- Master mutations: `tenant.<id>.device.camera.registered|updated|deregistered` (core/sites + Events map consume)

→ **workflow correlation** matches triggers/alert-formats → creates incidents. The **Events alarm monitor** (already built) then shows: live camera thumbnail/video on the incident card, and the camera's marker on the **Map** (we already have DevicePlacement + FOV rendering; VMS supplies the camera inventory + live snapshot). This closes the loop the current Map is waiting on.

ONVIF topic→event mapping is already fully worked out in gvd_nvr (`onvif_event_service.py`) — port verbatim.

---

## 8. Frontend (v3 dark theme, feature-folders)

- **Devices → Cameras** (nav tab already stubbed "Soon"): list/grid, health column, status, ONVIF discovery dialog + multi-channel bulk-add, camera form (all config tabs: Live/Recording/ONVIF/Imaging/IO/Audio/Advanced), bulk actions, drag-reorder, live preview. Port gvd_nvr `Cameras.js` + `Settings.js` tabs → `features/vms/`.
- **Devices → NVR**: estate list, channels, storage.
- **Streaming** (nav section, "Soon"): multi-camera **video wall** (1/4/9/16, tours), WebRTC/HLS tiles, per-tile record/snapshot/fullscreen. Port gvd_nvr `LiveStream.js` + `videoWall.js`.
- **Playback**: timeline (segments/gaps/motion markers), continuous HLS playback, multi-cam sync, bookmarks, clip export. Port `Playback.js`.
- **Events integration**: camera thumbnail + live on alarm cards; camera markers (FOV cones) on the Events **Map** (reuse `cameraRenderer.js` — glyphs already there); floor-plan device palette gains cameras (deviceInventory already structured for it).
- **Settings**: storage pools/tiering/retention, linkage rules, notification channels.

---

## 9. gvd_nvr → v3 port map

| gvd_nvr module | v3 target | Key adaptations |
|---|---|---|
| `cameras/` (models, router, sub-routers) | `vms/app/cameras/` | +tenant_id, +media_node_id, ACL→tenant rows, groups per-tenant |
| `onvif_service`, `onvif_event_service` | `vms/app/onvif/` + `drivers/camera` | event pull → **worker pool + NATS publish** (not 1/camera tasks) |
| `services/go2rtc_manager` | `vms/app/media/mediamtx.py` | **go2rtc → MediaMTX** (upsert_path, WHEP/HLS, per-tenant paths, node routing) |
| `services/ffmpeg_manager`, `recordings/`, `storage/` | `recording-worker` + `vms/app/recordings` | HLS segments + inotify + throttle; per-tenant S3/local; partitioned tables |
| `services/camera_monitor`, `monitoring/` | `vms/app/health` + node agents | health from MediaMTX/node; auto-purge |
| `events/` (linkage_service) | `vms/app/events` | events → NATS → **workflow correlation** (v2 had only linkage; v3 gets the full SOP engine) |
| frontend `Cameras/LiveStream/Playback/Recordings/Events/Settings` | `features/vms/*` | dark theme, feature-folders, WebRTC/HLS players, wire into Events monitor + Map |

---

## 10. Phased roadmap (scale-first, each phase reviewable)

- **P1 — Camera core + placement (no video):** `vms` service scaffold (kernel/NATS/multi-tenant/DB `neubit_vms` + Celery worker + MediaMTX+node registry in compose) · Camera + NVR + MediaProfile + Group models · ONVIF discovery/probe/channels/bulk-add · camera CRUD + config · camera↔site/floor/zone placement emitting `device.camera.*`. → **Devices→Cameras + Events Map light up** (markers, no live yet).
- **P2 — Live streaming:** MediaMTX integration + stream-supervisor sharding + PlaybackSession + Traefik ForwardAuth token · WebRTC/HLS live · Streaming video-wall UI · camera thumbnail/live on Events cards + Map.
- **P3 — Recording + storage:** recording modes + HLS segmenter (throttled, inotify) + storage pools (local/NFS/SMB/S3) + tiering + retention + integrity/lock + ANR.
- **P4 — Playback:** timeline + continuous HLS + multi-cam sync + clip export + bookmarks + snapshots.
- **P5 — Events + estate + scale hardening:** ONVIF PullPoint ingestion (worker pool) → NATS → correlation → incidents w/ live video · NVR estate + channel mapping + health · multi-node MediaMTX sharding/HA · DB partitioning + health-purge · 1000-cam load validation.

---

## 11. Decisions — LOCKED (2026-07-08)

- **D1 — camera master:** owned by the **`vms` service** (heavy self-contained domain). Core stays the identity/RBAC/config management plane + holds DevicePlacement/site tree; `vms` emits `device.camera.*` for cross-service consumers.
- **D2 — service name:** **`vms`** (`backend/vms/`). Subject namespace `tenant.<id>.vms.*`.
- **D3 — storage:** **BOTH local (RAID/NFS/SMB) AND S3/MinIO** — must-have. Pools + **tiering** (hot local → cold S3). Not either/or.
- **D4 — segment format:** **HLS** (m3u8 + segments) for record + playback (browser-native seek, scale-friendly).
- **D5 — sharding:** **dynamic stream-supervisor** (camera→node, NVR-affinity + rebalance + N+1 failover).
- **D6 — drivers:** brand connectors are **IN SCOPE now** (order needs multi-brand NVR playback + client feature-parity). Driver set: **ONVIF (Profile S/G/T) base + Hikvision (ISAPI) + CP-Plus + Lumina** — the 3 brands the owner has API access to. Same connector pattern as access (DDS/ESSL).
- **D7 — management plane / RBAC:** **REUSE neubit_v3 core** — no new users/roles/RBAC in VMS. Core JWT (`permissions` claim) verified locally; add `vms.*` permissions to core's catalog; VMS owns ONLY the per-camera ACL (keyed on core user/role/group IDs); audit → core's single trail. Core = the "management server"; `vms` is a domain service like access/workflow.
- **D8 — ⭐ LANGUAGE / PLANE SPLIT (polyglot-by-plane, per the owner's locked stack decision):** VMS is NOT one Python service. It splits by plane:
  - **`vision` (Python)** = VMS **control plane** — camera/NVR master records, onboarding, ONVIF discovery orchestration, config (recording/PTZ/imaging/motion/privacy), playback-session issuer, health aggregation, per-camera ACL. Reuses core RBAC; matches the existing Python control-plane services (core/gates/workflow/ingest/access). Moderate load.
  - **`nvr` (Go)** = VMS **data plane** — the recording/media engine (gvd_nvr's logic reimplemented in Go): supervises RTSP pulls, drives **MediaMTX + ffmpeg** for record/segment, **stream-supervisor sharding** (goroutine-per-camera, 200→1000ch), connection-dense **ONVIF PullPoint event ingestion** → NATS `tenant.<id>.vms.*`. This is where Python's GC/memory bit at 512ch scale; the gvd_nvr→Go port is the highest-value Go piece.
  - The two interop over **NATS + REST only** (language-independent boundary — the whole point of the event-driven design). **MediaMTX (itself Go) does the media heavy-lifting; the Go `nvr` is an orchestrator/supervisor, not a codec reimplementation → lean codebase.** (This supersedes the single-`vms`-service framing in §2/§13–17: read "`vms`" there as the `vision`+`nvr` pair; `tenant.<id>.vms.*` subject namespace unchanged.)
  - **RESOLVED — Option A (Go `nvr` from the start).** Owner: has time before delivery, wants enterprise-grade from day one, **no double-engineering** later, and a mobile app is coming. So the Go data-plane is built once, correctly, from P1 — NOT Python-first-then-migrate (that IS double-engineering). Control plane stays Python (`vision`, reuses core).
- **Scope — E-tier committed:** the owner wants **full enterprise parity** (Indian clients compare hard: failover, LDAP/SSO/2FA, ANR/redundant recording, tamper-proof signed export, reporting, mobile, PTZ tours, video-wall output). E is a committed deliverable (P6), not "maybe later". Roadmap still sequences by dependency, but E ships.

---

## 12. Dependencies already in place (nothing to rebuild)
- NATS spine + `tenant.<id>.*` subjects + workflow correlation already consuming `tenant.*.vms.>`.
- kernel (config/JWT/DB/NATS/events) + shared-JWT + Traefik gateway + multi-tenant scoping (`scoped()/assert_owned()`).
- `core/sites` floor-plans + zones + **DevicePlacement** (camera markers/FOV) + Events **Map** + alarm-monitor cards + SSE realtime-bridge pattern.
- Devices nav section + Streaming nav stub + `deviceInventory.js` already structured to add cameras.
- The **brand-connector pattern** (access) to reuse for camera/NVR drivers.

---
---

# PART B — Enterprise VMS spec (competitive with CP-Plus / Sparsh / Milestone XProtect / Genetec)

Anchor deployment: a **200-channel order** — complete VMS + recording, multi-brand cameras + NVRs, ONVIF events, health monitoring, playback/export. No AI. This part closes the **feature catalog**, the **distributed/HA architecture**, and the **200-ch sizing** at enterprise brand level.

## 13. Where we compete / win

| Axis | CP-Plus / Sparsh (India SMB-mid) | Milestone / Genetec (enterprise) | **neubit VMS (us)** |
|---|---|---|---|
| Core VMS (live/record/playback/PTZ) | ✅ | ✅ | ✅ (port from gvd_nvr) |
| Multi-brand ONVIF + NVR/DVR estate | ✅ ONVIF + own brand | ✅ 1000s of drivers | ✅ ONVIF Profile S/G/T + connector drivers (Hik/Dahua/CP-Plus/Uniview…) |
| Distributed / failover / federation | limited | ✅ (recording servers, failover, federation) | ✅ management + recording nodes + N+1 failover + multi-site |
| Web-native (no thick client) | partial | thick Windows client | ✅ **browser-native** (WebRTC/HLS), zero-install |
| **Unified PSIM** (VMS + access + SOP/workflow + alarms) | ✗ | Genetec ✅ (pricey) | ✅ **already have** access(gates) + workflow/SOP + alarm-monitor + maps — VMS slots in |
| Multi-tenant / SaaS | ✗ | ✗ (single-org) | ✅ multi-tenant from the core |
| Open API / event spine | limited | SDK | ✅ NATS spine + REST + webhooks |

**Our wedge:** not "another VMS" — a **web-native, multi-tenant PSIM** where VMS is one pillar next to access-control + SOP-driven incident management we've already built. That's the Genetec story at a fraction of the cost/complexity.

## 14. Enterprise feature catalog

Legend: **[M]** = MVP for the 200-ch order (must ship) · **[E]** = full-enterprise (fast-follow) · **[L]** = later.

### A. Device onboarding & management
- [M] Manual add (RTSP/ONVIF), **ONVIF auto-discovery** (WS-Discovery + subnet scan), **bulk-add** multi-channel, CSV import, IP-range scan.
- [M] **Multi-brand via drivers**: ONVIF Profile S (live) + G (recording/playback) + T; connector drivers for Hikvision (ISAPI), Dahua, CP-Plus, Uniview, Axis (VAPIX) — ONVIF default, brand SDK where ONVIF is weak (esp. NVR playback).
- [M] Encrypted credential vault; capability auto-detect (PTZ/audio/IO/events); main/sub/third stream.
- [M] Camera grouping + **site/floor/zone hierarchy + maps** (already built).
- [E] Device templates / bulk config push; firmware/version inventory; camera config over ONVIF (imaging/OSD/privacy-mask/motion-region/WDR/day-night).
- [E] **PTZ**: presets, tours/patterns, priority locking, digital PTZ.

### B. NVR / DVR estate (explicit order requirement)
- [M] **Onboard existing NVR/DVR** (multi-brand): connect, **enumerate channels**, map channels→cameras, pull **live (RTSP)** + **recorded playback** (ONVIF Profile G + brand playback protocol: Hik ISAPI, Dahua SDK, CP-Plus).
- [M] **NVR health**: online/offline, per-channel status, storage/HDD state, recording status.
- [M] **Remote playback extraction** from NVR (timeline + clip export pulled from the NVR's own storage).
- [E] NVR config sync, HDD SMART, RAID status, NVR firmware.

### C. Live monitoring / control room
- [M] Live single + **multi-cam video wall** (1/4/9/16/25/36 + custom); saved **layouts** per user; WebRTC low-latency + HLS fallback.
- [M] Snapshot, digital zoom, **instant playback** (rewind live), fullscreen, per-tile controls.
- [E] **Camera tours/sequences/carousel**; multi-monitor / floating windows; **two-way audio** (backchannel); **video-wall/decoder + spot-monitor output**; alarm-triggered live popup; operator workspaces.

### D. Recording
- [M] Modes: **continuous, scheduled, motion, event, manual**; per-camera **weekly schedule grid**; pre/post-event buffer; H.264/H.265 **copy (no transcode)**.
- [M] Retention per camera/group; storage quotas; **HLS-segment recording** (scale-friendly).
- [E] **ANR / edge-recording backfill** (pull gaps from camera SD card); **redundant/failover recording**; recording **integrity** (checksum, lock/protect, tamper-evidence); **storage tiering** (hot→cold→archive: local→NAS/SAN→S3).

### E. Playback / investigation / export
- [M] **Timeline playback** per camera + **synchronized multi-camera**; speed/reverse/frame-step; **thumbnail scrubbing**; **bookmarks/evidence marks**.
- [M] **Export** (MP4 + native), single & multi-camera, clip by time-range, snapshot export.
- [E] **Motion/metadata smart-search** in recorded video (region-based, non-AI); **tamper-proof export** (digital signature + watermark + bundled player); **case management / evidence locker**; dual-authorization for export.

### F. Events & alarms (order requirement: ONVIF + brand-wise)
- [M] **ONVIF PullPoint events**: motion, tamper (blur/dark/scene), video-loss, IO digital-input, line-crossing, field/zone intrusion, audio (port gvd_nvr's full topic map).
- [M] **Brand-native events** through the driver (Hik/Dahua alarm streams).
- [M] **System events**: camera offline, recording failure, storage low/full, disk/RAID error, server down.
- [M] **Alarm management**: alarm queue/monitor, acknowledge/escalate/comment/priority, dedupe — flows into the **workflow/SOP engine → incidents** (already built) + the **alarm-monitor UI** (already built).
- [M] **Event-linkage / action rules**: on event → start-recording / PTZ-preset / trigger IO output / notify / popup camera. (gvd_nvr has this; wire to SOP engine.)
- [M] **Notifications**: email, webhook, mobile push (connector framework ready); [E] SMS, SNMP.

### G. System / server / scale (enterprise backbone)
- [M] **Distributed**: 1 management (vms) server + **N recording/media nodes** + camera→node sharding (handles 200 now, 1000+ later).
- [E] **Failover recording servers (N+1)**; recording-server **load-balancing**; **multi-site federation** (central mgmt of many sites); bandwidth management/throttling; server health + auto-alerts.
- [E] HA/clustering for the management server; DB partitioning + retention purge.

### H. Users / security / audit (enterprise, order-grade)
- [M] **RBAC** with granular permissions + **camera-level ACL** (which users see which cameras) + tenant isolation (already have roles/permissions in core).
- [M] **Audit trail** (who did what — export, config, playback) for compliance.
- [E] **LDAP/AD + SSO**, **2FA**, session mgmt, dual-authorization for sensitive ops; **privacy** (privacy-masking, DPDP/GDPR retention + right-to-erasure + export logging).

### I. Health monitoring & maintenance (explicit order requirement)
- [M] **Health dashboard**: camera online/offline, bitrate/fps/packet-loss/latency; recording gaps/failures; storage capacity; server CPU/mem/disk/net.
- [M] Auto-alerts on degradation; per-camera health history (retention-purged).
- [E] HDD SMART/RAID health; uptime/SLA reporting; firmware management.

### J. Maps / situational awareness
- [M] Interactive **floor-plan maps** with camera icons + **FOV cones**, click→live/playback, alarms on map. (**Already built** — DevicePlacement + Events Map + cameraRenderer; VMS just supplies inventory + live.)
- [E] Multi-level maps, GIS/geo maps.

### K. Reporting (non-AI, operational)
- [E] Camera uptime, recording-coverage, storage-usage, event/alarm stats, bandwidth, user-activity reports; scheduled email reports.

### L. Mobile / remote
- [E] Mobile app (live + playback + alarms + push) via the connector framework; web client is the existing frontend.

### M. Integrations
- [M] **Access-control ↔ video** (we have gates): access event (door forced/held) → auto-pop camera + record (video verification). Big PSIM differentiator.
- [E] 3rd-party via REST/webhooks/ONVIF Profile G/T; AI-analytics as a pluggable event source (later).

## 15. Distributed / HA architecture (enterprise)

```
                 ┌─────────────────── Management tier (HA pair) ───────────────────┐
                 │  vms mgmt server: cameras/NVR master, config, users/RBAC,        │
                 │  event ingestion orchestration, stream-supervisor (sharding),     │
                 │  playback-session issuer, health aggregation                      │
                 └───────┬───────────────────────────────────┬─────────────────────┘
        assign camera→node │                                   │ NATS vms.* / device.*
                 ┌─────────▼─────────┐   ┌─────────▼─────────┐  ▼  workflow correlation → incidents
                 │ recording node 1   │   │ recording node 2  │  (+ N more; N+1 failover)
                 │ MediaMTX + rec-wkr │   │ MediaMTX + rec-wkr│
                 │  ~100 ch            │   │  ~100 ch           │  ← 200-ch order = 2 nodes (or 1 + 1 failover)
                 └────────┬───────────┘   └────────┬──────────┘
                          │ HLS segments            │
                          ▼                          ▼
                 ┌──────────────── storage: local RAID / NAS-SAN / S3(MinIO) cold ────────────────┐
```

- **Camera→node sharding** by NVR-group affinity + load; a node dies → its shards reassign to a peer (N+1 failover). This is the "enterprise recording server" model (Milestone/Genetec) done with MediaMTX nodes.
- **Federation**: multiple sites each run a node cluster; one management plane. Multi-tenant already gives us the isolation primitive.

## 16. The 200-channel order — reference sizing

- **Bitrate**: 200 × ~4 Mbps (H.265 1080p main) ≈ **800 Mbps** sustained record ingest → 10GbE + RAID6/RAID10 array (or split across 2 nodes @ ~400 Mbps each).
- **Storage (30-day continuous)**: 4 Mbps ≈ 43 GB/cam/day → 200 cams ≈ **8.6 TB/day → ~260 TB/30d**. Cut with **sub-stream or motion/schedule recording** (40–70% less) → plan **~90–260 TB** depending on policy. Tiering to cold storage for older footage.
- **Compute**: recording = stream **copy** (no transcode) → I/O-bound, light CPU; live WebRTC transcode-free. **2 recording nodes** comfortably cover 200 ch with headroom + failover; **1 management server**.
- **Topology delivered**: 1 vms mgmt + 2 recording/media nodes + storage array + gateway; grows to 1000+ by adding nodes. Same code, more nodes.

## 17. Delivery phases (mapped to the order)

- **P1 Camera + NVR onboarding + health** [M] — vms service, ONVIF discovery + multi-brand drivers (ONVIF + Hik/Dahua/CP-Plus), NVR channel enumeration + health, camera CRUD/config, site placement. *Order-visible: cameras + NVRs onboard, health dashboard, map markers.*
- **P2 Live** [M] — MediaMTX nodes + sharding + WebRTC/HLS + **video wall** + layouts. *Order-visible: live monitoring.*
- **P3 Recording + storage** [M] — modes + schedule grid + HLS segmenter + storage pools + retention + tiering. *Order-visible: recording works.*
- **P4 Playback + export + NVR playback extraction** [M] — timeline + sync multi-cam + bookmarks + export + **pull playback from NVRs**. *Order-visible: playback + evidence export.*
- **P5 Events + alarms + linkage** [M] — ONVIF/brand events → NATS → SOP incidents + alarm-monitor + action rules + access↔video. *Order-visible: event-driven alarms.*
- **P6 Enterprise hardening** [E] — failover/N+1, federation, LDAP/SSO/2FA, ANR/redundant recording, tamper-proof export, reporting, mobile. *Post-order, competitive parity.*

**P1–P5 = the 200-channel order's "complete VMS + recording".** P6 = enterprise moat.
