# VMS — Phase 6 plan (enterprise hardening)

The moat: features Indian clients compare against CP-Plus/Milestone/Genetec. Committed (E-tier). Build the verifiable high-value pieces; flag pure deployment/scale items as architecture-ready (validated at real scale/hardware).

## Modules

### P6-A — recording resilience + media-node scale (Go nvr)
- **ANR / edge-recording backfill**: when a camera reconnects after an outage, pull the gap from its edge SD-card (ONVIF Profile G / brand playback search over the gap window) → write the missing segments → Recording rows. `ANRJob` model + a worker; port gvd_nvr `anr`.
- **Redundant / failover recording**: a camera can record to a **primary + secondary pool/node**; on primary-node loss the stream-supervisor reassigns + resumes (extends the P2-A shard model — the multi-node **rebalance-on-node-loss** stub becomes real: node heartbeat → detect dead node → reassign its shards + re-enable record on the new node).
- Verify: simulate a recording gap → ANR search+backfill (fixture for the NVR/edge search); kill a media node → shards reassign + recording resumes (single-node dev: prove the reassign logic + heartbeat).

### P6-B — tamper-proof signed export + reporting (vision)
- **Tamper-evident export**: extend P4-B export — after the mp4 is built, compute a **SHA-256 + a digital signature** (Ed25519 with a per-tenant/appliance key — reuse the platform's Ed25519 licensing key infra if present), write a **sidecar manifest** (`{file_hash, signature, camera, range, exported_by, exported_at, chain}`) + optional **visible watermark** (ffmpeg drawtext: site/camera/time) + a small **verify tool/endpoint** (`POST /export/verify` → re-hash + verify signature → valid/tampered). Optional bundled-player note.
- **Reporting**: a `reports` domain — camera-uptime, recording-coverage, storage-usage, event/alarm-stats, bandwidth (from health/recording/event/storage data). `GET /api/v1/vms/reports/{kind}?from=&to=` (JSON) + a CSV/PDF export + **scheduled email reports** (a report scheduler → the notify path). Port gvd_nvr reporting concepts.
- Verify: export → signed manifest + `verify` returns valid; corrupt the mp4 → `tampered`; reports return real numbers from the DB; scheduled-report job runs.

### P6-C — ONVIF server (our VMS pullable by 3rd-party VMS) + interop
- **Our VMS acts as an ONVIF device/server** (Profile S live + G recording) so external VMS/recorders (Milestone/Genetec/NVRs) can discover + pull OUR camera streams + recordings. Port gvd_nvr/vizor_nvr `onvif_device` (the ONVIF device-server: GetProfiles/GetStreamUri/GetRecordings/GetReplayUri answering with our MediaMTX/playback URLs + WS-Discovery advertise). A big interop differentiator. Config: enable per-tenant, which cameras exposed.
- Verify: the ONVIF-server endpoints answer GetProfiles/GetStreamUri with our stream URLs; WS-Discovery advertises; (real ONVIF-client validation = a Milestone/onvif-tester on the owner's side, `# LIVE-VALIDATE`).

### P6-D — security hardening (core) — AUDIT FIRST
- **Audit what core already has** (neubit_v3 core came from platform_base `edge`; the STQC program built headers/lockout/pw-policy/**TOTP 2FA**/secrets-at-rest/TLS — much may already exist). Then ADD the gaps for VMS-grade enterprise: **LDAP/AD sync + SSO (OIDC/SAML)**, enforce **2FA** (if TOTP exists, expose/enforce it), **dual-authorization** for sensitive ops (export/delete-recording), session policy. Video-specific: privacy-masking is per-camera (P1), **DPDP/GDPR retention + right-to-erasure + export-logging** (audit every playback/export — tie to the hash-chain audit).
- Verify: what exists documented; new LDAP/SSO config + 2FA-enforce + export/playback audit-logged.

### P6-E — frontend (reports + signed-export + security/ONVIF-server config) + mobile
- Reports UI (dashboards + scheduled-report config + download), signed-export UX (export → manifest/verify badge), ONVIF-server config page, security/SSO/2FA config (or extend core's existing security settings), ANR/redundancy config on the camera.
- **Mobile**: the API is already REST+JWT+HLS/WebRTC (mobile = a client). Ship the **mobile-push connector** (FCM/APNs) for events/popups + document the mobile client contract. (A full native app is a separate deliverable; P6 makes the backend mobile-ready + push.)
- Verify: routes 200, compile clean.

## Deployment/scale items (architecture-ready, validated at deployment — flag, don't force in dev)
- **Multi-site federation** (central mgmt of many sites) + **HA clustering** of the management/media plane + **512/1000ch load** validation — the design (sharding, per-tenant isolation, node registry) supports these; they're proven on real multi-node hardware at deployment, not synthetic dev.
- **Go-nvr event-ingestion scale move** (D8): move P5-A's vision event pool to the Go nvr for 1000ch connection-density (same NATS subject → drop-in).

## Done when
Recording resilience (ANR + failover), tamper-proof signed export + reporting, ONVIF-server interop, security hardening (LDAP/SSO/2FA/audit), and mobile-push are built + verified (synthetic/fixtures) — with deployment-scale items architecture-ready. **VMS feature-complete for the enterprise pitch.**
