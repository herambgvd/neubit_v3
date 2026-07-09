# VMS — Phase 3 plan (recording + storage)

Record camera streams to disk/cloud, retain + tier, keep an integrity trail. Builds on P2's live pipeline (MediaMTX + Go `nvr`). Recording is a **data-plane** concern → the Go `nvr` owns the engine; **vision** owns the config/metadata/policy; a retention worker sweeps.

## Approach — MediaMTX native recording (lean)
MediaMTX records a path itself when `record: yes` (fmp4 segments to `recordPath`, `recordSegmentDuration`, `recordDeleteAfter`). So the Go `nvr` doesn't re-implement ffmpeg segmenting — it **enables/disables recording on the MediaMTX path** per camera/mode/schedule, and **tracks the segments** (Recording rows) + drives retention/tiering. (gvd_nvr's ffmpeg segmenter is the reference for the metadata/retention logic; the actual muxing is MediaMTX's job — matches D8 "orchestrator, not codec".)

## Modules

### P3-A — recording engine + config (Go `nvr` + vision)
- **Go `nvr`**: enable/disable MediaMTX recording on a path (`record`, `recordPath=/recordings/<tenant>/<cam>/<profile>`, `recordFormat=fmp4`, `recordSegmentDuration`, `recordDeleteAfter=0` [nvr owns retention]); a **recording-supervisor** that reconciles desired-vs-actual (which cameras should be recording now, per mode/schedule) on a tick; **segment tracker** — watch the record dir (inotify/fsnotify) or MediaMTX's `recordings` API → emit a segment-complete event (NATS `tenant.<id>.vms.recording.segment`) with {camera, path, start, end, size}. Internal endpoints `POST /recording/{camera}/{profile}/start|stop`, `GET /recording/status`.
- **vision**: `Recording` model (camera_id, profile, file/manifest path, start/end, duration, size, codec, trigger_type[continuous|schedule|motion|event|manual], storage_pool_id, checksum?, locked, has_motion, event_markers) + per-camera recording config already on Camera (recording_mode/schedule/fps/retention_days/record_substream). Consume the nvr segment events → persist Recording rows. API: `PUT /cameras/{id}/recording` (mode/schedule/retention), `POST /cameras/{id}/recording/{start|stop}` (manual → calls nvr), `GET /cameras/{id}/recordings` (list, filter by time). **Modes:** continuous + schedule (a scheduler toggles record by weekly windows) built now; motion/event wired to the recording-supervisor but fired by P5 events (stub the trigger).
- Verify: enable recording on the synthetic testpat camera → MediaMTX writes fmp4 segments → nvr emits segment events → vision persists Recording rows → `GET /recordings` returns them; stop → recording ceases; schedule window toggles; graceful.

### P3-B — storage pools + tiering + retention + integrity (vision + worker)
- **StoragePool** model + CRUD (local / NFS / SMB / **S3/MinIO**) — path/bucket, priority, max_size, is_default, NAS mount fields, encrypted creds. New cameras/recordings assigned a pool (default). Add a **MinIO** service to compose for the S3 tier (dev).
- **TierRule** + **retention worker** (Celery-style in vision, or a Go nvr job): move recordings source→target pool after age (hot local → cold S3); delete recordings past `retention_days` (per-camera or global) or when a pool is over `max_size` (oldest-first); respect `locked`. **Integrity**: SHA-256 checksum on segment finalize, `integrity_status`, lock/unlock endpoint.
- Port gvd_nvr `storage/` (pools/tiering) + recording retention. Verify: create pools; a tier rule moves an old recording local→S3 (MinIO); retention deletes an over-age unlocked recording, keeps a locked one; checksum recorded.

### P3-C — frontend (recordings + storage + schedule UI)
- **Recordings** view (per camera + estate): list (time/duration/size/trigger/locked), filter by camera+date, lock/unlock, delete (confirm), download a segment. A **recording schedule** editor (weekly grid) on the camera config "Recording" tab (already a tab — make it real). **Storage** config page (pools CRUD + tiering rules + retention + usage bars). Port gvd_nvr `Recordings.js` + `Storage.js` + the schedule grid, rethemed. Enable the Config→Storage tab (currently "Soon").
- Verify: routes 200, compile clean, api matches; playback of recordings is P4.

## Honest verifiability
Full recording pipeline testable with the synthetic testpat stream (record → segments on disk → Recording rows → retention/tier against MinIO). Real-camera recording (H.264/H.265, real bitrate/storage math) validates on owner hardware.

## Done when
Cameras record (continuous + schedule) to pooled storage (local + S3), segments tracked as Recording rows, retention + tiering + integrity/lock work, UI to configure + browse — verified on the synthetic stream. Then P4 (playback/export).
