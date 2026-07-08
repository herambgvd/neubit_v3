# VMS — Phase 1 implementation plan (camera + NVR onboarding, drivers, health, placement)

Port sources (cross-reference BOTH — nearly identical NVR codebases; use whichever is more complete per module): **gvd_nvr** (`/Users/snowden/office/side_project/gvd_nvr`, +`relay/`) and **vizor_nvr** (`/Users/snowden/project/vizor_nvr`, the original). Enterprise modules present in both to mine in later phases: **`onvif_device`** (⭐ our VMS acts as an ONVIF server so 3rd-party VMS can pull from us — interop feature), **`storage`** (pools local/NFS/SMB/RAID + tiering, P3), **`cluster`** (multi-node, P5), **`license`** (Ed25519), **`relay`/`spot_output`** (alarm-relay + spot-monitor), `bookmarks`/`snapshots`/`monitoring` (P4/health).

Derived from `docs/VMS_DESIGN.md` (decisions D1–D8 locked). **Enterprise-from-start, build-once, mobile-ready, no double-engineering.** P1 = the foundation + everything visible without video yet: onboard cameras + multi-brand NVRs, detect capabilities, monitor health, place on floor-plans/maps. Live/record/playback = P2–P4.

Plane split (D8): **`vision` (Python)** = control brain · **`nvr` (Go)** = data-plane muscle (scaffold only in P1; heavy work P2–P3) · **MediaMTX** = media (P2). Management/RBAC = **core** (reuse).

---

## P1 deliverables
1. **Go kernel** (`backend/gokernel/`) — shared Go lib mirroring the Python kernel's contracts (first Go foundation, build-once).
2. **`nvr` (Go) service scaffold** — boots, health, NATS connect, JWT verify, own DB `neubit_nvr`, compose+gateway. No streaming/recording yet.
3. **`vision` (Python) service** — camera/NVR master + onboarding + drivers + config + health + placement + ACL. Own DB `neubit_vision`.
4. **Driver framework** (Python control-plane) — capability interface + **ONVIF (Profile S/G/T) + Hikvision (ISAPI) + CP-Plus + Lumina** connectors: discover/probe/channels/capabilities/config/PTZ.
5. **Frontend** (`features/vms/`) — Devices → **Cameras** (list/grid, onboard, ONVIF discovery + multi-channel bulk-add, config tabs, health), Devices → **NVR** (estate, channel mapping, health) + camera markers on the Events **Map**. v3 dark theme, proper UX.
6. **Contracts** — data model, REST OpenAPI, NATS subjects, `vms.*` permissions, driver interface. Frozen so web + mobile build against them.

---

## Contracts (freeze first)

### Data model — `vision` (Python, tenant-scoped; enterprise fields present day-1 even if UI later)
- **Camera**: id, tenant_id, name, is_enabled, status(online|offline|connecting|error), brand/driver, connection_type(rtsp|onvif|nvr_channel); network_info{ip,port,rtsp_port,mac}; onvif{host,port,enc_user,enc_pass,profile_token,capabilities}; media_profiles→(MediaProfile); recording{mode,schedule,fps,record_substream,retention_days,pre/post_buffer,anr_enabled}; advanced{privacy_masks,motion_config,pos_overlay,dewarp,backchannel}; ptz{capable,presets}; placement refs{site_id,floor_id,zone_id}; nvr_id, nvr_channel_number; storage_pool_id; media_node_id; display_order; thumbnail_path; last_seen_at; created/updated.
- **NVR**: id, tenant_id, name, brand/driver, host, port, enc_creds, channel_count, status, storage_info(JSON), capabilities, last_seen_at.
- **MediaProfile**: id, camera_id, name(main|sub|third), codec, resolution, fps, rtsp_path, bitrate.
- **CameraGroup**: id, tenant_id (name unique per-tenant), color, camera_ids, description.
- **CameraACL**: id, tenant_id, subject_type(role|user|group), subject_id (core ID), camera_id|group_id, privileges[] (view_live|playback|export|ptz|config). *(VMS owns per-camera ACL; coarse RBAC = core.)*
- **CameraHealth**: id, tenant_id, camera_id, status, bitrate_kbps, fps_actual, packet_loss, latency_ms, captured_at. *(retention-purged.)*
- **MediaNode / StreamShard** (registry; assignment logic P2): node id/host/capacity/status; shard camera_id→node_id→profile.

Migration: `neubit_vision/0001_baseline` (create_all off metadata — per the project's baseline convention, so fresh deploys under `upgrade 0001 && stamp head` get every table; import all models in env.py + baseline `_metadata()`).

### REST API — `vision` `/api/v1/vms` (OpenAPI; web+mobile+desktop clients)
- Cameras: `GET/POST /cameras`, `GET/PATCH/DELETE /cameras/{id}`, `POST /cameras/bulk` (enable/disable/group/retention/delete, cap 200), `POST /cameras/reorder`.
- Discovery: `POST /cameras/onvif/discover`, `/onvif/probe`, `/onvif/channels`, `/onvif/bulk-add`, `/onvif/snapshot`.
- Config sub-resources (ONVIF-backed): `{id}/ptz`, `{id}/imaging`, `{id}/io`, `{id}/motion-config`, `{id}/privacy-masks`, `{id}/onvif-events`.
- NVR: `GET/POST /nvrs`, `GET/PATCH/DELETE /nvrs/{id}`, `POST /nvrs/discover`, `GET /nvrs/{id}/channels`, `POST /nvrs/{id}/map-channels`.
- Groups + ACL: `/camera-groups` CRUD, `/cameras/{id}/acl`.
- Health: `GET /cameras/health` (latest per camera), `GET /cameras/{id}/health/history`.
- Placement: emits to core DevicePlacement + `device.camera.*` (Map already consumes).

### NATS subjects (P1)
- `tenant.<id>.device.camera.registered|updated|deregistered` `{camera_id, site_id, floor_id, brand, network_info}` (core/sites + Events Map consume).
- `tenant.<id>.device.nvr.registered|updated|status` `{nvr_id, status, storage}`.
- `tenant.<id>.vms.camera.status|health` `{camera_id, status, bitrate, ...}` (workflow correlation + realtime already subscribe `tenant.*.vms.>`).

### JWT `vms.*` permissions (add to core `app/auth/permissions.py`)
`vms.camera.read|manage`, `vms.nvr.manage`, `vms.live.view`, `vms.recording.control`, `vms.playback.view`, `vms.export`, `vms.ptz.control`, `vms.config.manage`. Assigned to roles in core's editor; ride in JWT.

### Driver interface (Python control-plane — the multi-brand seam, reuse access connector pattern)
`CameraDriver` ABC: `discover(network)`, `probe(host,creds)→DeviceInfo`, `enumerate_channels(host,creds)→[Channel]`, `get_stream_uris(host,creds,profile)→{main,sub}`, `get_capabilities()`, `get_snapshot()`, `ptz(cmd)`, `configure(section,payload)`, `subscribe_events(cb)` *(control-side; high-throughput ingestion lives in Go `nvr` P5)*. Factory by `brand`. Impls:
- **OnvifDriver** (default — Profile S live + G recording/playback + T; port gvd_nvr `onvif_service`+`onvif_event_service` verbatim incl. topic map).
- **HikvisionDriver** (ISAPI HTTP + brand playback for NVR footage extraction).
- **CpPlusDriver** (CP-Plus API; CP-Plus is Dahua-lineage — Dahua HTTP/CGI patterns apply).
- **LuminaDriver** (Lumina API; ONVIF where gaps).

### Go kernel spec (`backend/gokernel/`, build-once)
Mirrors Python kernel contracts so services interop cleanly:
- **config**: env `VE_*` (DB URL, NATS URL, JWT secret, service name/port).
- **auth**: HS256 JWT verify (shared `VE_JWT_SECRET`), claims {sub, tenant_id, is_superadmin, permissions[]}; `RequirePermission`/`Scope` middleware; tenant-scope helper.
- **events**: NATS client (nats.go) — subject `tenant.<id>.<domain>.<event>`, envelope `{event_id,tenant_id,type,occurred_at,source,payload}`, publish/subscribe/JetStream durable — identical shape to Python kernel.
- **db**: pgx pool + migration runner (golang-migrate or embedded SQL).
- **http**: chi router + middleware (auth, tenant, recover, request-id, CORS) + health.
- **errors**: typed API errors matching the Python `{error:{code,message}}` envelope.

---

## Build task order (P1) — plan-per-module, then code

1. **Go kernel** — scaffold `backend/gokernel/`, implement config/auth/events/db/http/errors, unit-test JWT-verify + NATS envelope round-trip against a Python-published event (contract parity check).
2. **`nvr` (Go) scaffold** — service using gokernel: boots, `/health`, NATS connect, JWT verify, DB `neubit_nvr` + baseline migration (empty-ish), Dockerfile, compose entry, gateway route `/api/v1/nvr`. Prove: boots, health 200, NATS connected, JWT-gated.
3. **`vision` (Python) scaffold** — FastAPI + kernel, DB `neubit_vision` + `0001_baseline`, CORS/JWT, compose + gateway `/api/v1/vms`. Health + whoami.
4. **Models + migration** — Camera/NVR/MediaProfile/CameraGroup/CameraACL/CameraHealth/MediaNode/StreamShard (all in baseline metadata).
5. **Driver framework** — `CameraDriver` ABC + factory + **OnvifDriver** (port gvd_nvr onvif_service faithfully) first; then Hikvision, CP-Plus, Lumina stubs→impls (discover/probe/channels/capabilities).
6. **Camera onboarding API** — CRUD + ONVIF discover/probe/channels/bulk-add + capability detect + config (ptz/imaging/io/motion/privacy) + reorder + bulk. Publish `device.camera.*`.
7. **NVR onboarding API** — CRUD + discover + channel-enum + map-channels (create cameras as channels) + health. Publish `device.nvr.*`.
8. **Health monitoring** — a health sampler (in `vision` for P1: periodic reachability + status; real stream-health metrics come from Go `nvr`/MediaMTX in P2) → CameraHealth rows + `vms.camera.health` events + auto-purge.
9. **Core wiring** — add `vms.*` permissions to core catalog; ensure camera placement flows into core DevicePlacement (already built) so Events Map shows camera markers.
10. **Frontend `features/vms/`** (proper UI, v3 dark theme):
    - **Devices → Cameras**: list/grid toggle, health column, status dots, onboard modal (manual + all config tabs Live/Recording/ONVIF/Imaging/IO/Advanced), **ONVIF discovery dialog** (scan → results + enrichment → select channels → bulk-add), bulk actions, drag-reorder, camera detail (config tabs). Port gvd_nvr `Cameras`/`Settings` UX, rethemed.
    - **Devices → NVR**: estate list, add-NVR + discovery, channel mapping table, NVR health.
    - **Health dashboard**: camera/NVR online-offline + bitrate/fps/latency (P1: reachability; richer in P2).
    - **Events Map**: camera markers + FOV (reuse `cameraRenderer.js` — wire vms camera inventory into `deviceInventory.js`).
    - Nav: Devices sub-tabs Cameras/NVR now enabled (were "Soon"); Streaming stays "Soon" until P2.
11. **Verify** — service boots + migrations; onboard a camera (manual + a mock ONVIF) read-back; NVR channel-enum; health rows; `device.camera.*` published + Map marker; frontend routes 200 + compile clean; drivers unit-tested against recorded fixtures (no live devices in dev). Live device validation when owner connects real cameras/NVRs.

---

## Mobile-readiness checkpoints (bake in P1)
- Every capability = a REST endpoint under `/api/v1/vms` (no server-rendered-only flows) — mobile consumes the same.
- Payloads paginated + thin; media returned as URLs (WebRTC/HLS in P2) a mobile player can open.
- Auth = the same JWT; push via the connector framework later. No mobile-specific backend.

---

## Definition of done (P1)
Cameras + multi-brand NVRs onboard (ONVIF + Hik/CP-Plus/Lumina drivers), capabilities detected, health monitored, cameras placed on floor-plans + visible on the Events Map, all tenant-scoped + RBAC via core, contracts frozen (OpenAPI + NATS + permissions), Go+Python services interop over NATS — verified in dev with fixtures; live-device validation on the owner's hardware. Then P2 (live streaming).
