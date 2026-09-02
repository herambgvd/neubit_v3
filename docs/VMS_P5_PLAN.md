# VMS — Phase 5 plan (events + alarms + linkage)

Turn camera device-events (ONVIF/brand) into action: normalize → NATS → the **workflow/SOP engine → incidents** (the alarm-monitor, already built), fire **linkage/action rules** (record-on-motion, notify, PTZ, output), mark events on the playback timeline, and wire **access↔video verification**. No AI — device-level events only (motion/tamper/video-loss/IO/line/zone/audio). Builds on P1 drivers (ONVIF topic map + `subscribe_events`) + P3 recording (event-clip entry point) + the existing workflow correlation + Events alarm monitor.

## Where event ingestion runs
The P1 `OnvifDriver.subscribe_events` (+ the full gvd_nvr topic map) already lives in **vision** (Python). For P5, run the **event-supervisor in vision** (bounded worker pool, one subscription per event-enabled camera) — functionally complete + reuses P1. *(Scale note: D8 targets a Go `nvr` connection-dense pool at 1000ch — that move is P6 hardening; the NATS contract stays identical so it's a drop-in.)*

## Modules

### P5-A — event ingestion (vision)
- **VmsEvent** model (camera events log): id, tenant_id, camera_id, event_type (motion|tamper|video_loss|camera_online|camera_offline|io_input|line_crossing|zone_intrusion|audio|…), severity, source (onvif|brand|system), raw (JSON), dedup_key, occurred_at, published, acknowledged/ack_by/ack_at, snapshot_path?, recording_id?.
- **event-supervisor** (lifespan task): for each active camera with `onvif_events_enabled`, open the driver's `subscribe_events` (ONVIF PullPoint / brand stream) → normalize via the driver's topic map → dedupe → persist VmsEvent → **publish NATS `tenant.<id>.vms.camera.<event_type>`** `{camera_id, event_type, severity, occurred_at, zone?, …}`. Bounded concurrency, reconnect/backoff, graceful (a dead camera doesn't stall others). System events (camera online/offline from the health sampler; recording-error/storage-low) also become VmsEvents + published.
- Events API: `GET /api/v1/vms/events` (filters camera/type/severity/from/to + ack), `POST /events/{id}/ack`. `GET /api/v1/vms/cameras/{id}/events`.
- **These `tenant.*.vms.>` events are ALREADY consumed by the workflow correlation engine** → SOP triggers → incidents on the alarm-monitor. Verify that path lights up (a published motion event → an incident when a matching SOP/trigger exists).
- Verify: simulate/publish a camera event → VmsEvent persisted + NATS published + (with a trigger) a workflow incident appears; ack works; dedupe holds.

### P5-B — linkage / action rules + timeline markers + access↔video (vision + nvr)
- **LinkageRule** model + engine (port gvd_nvr `events/linkage_service`): trigger (event_type + filter + camera scope) → actions[]: **start_recording** (event-clip via nvr `StartEventClip` + pre/post buffer, sets Recording.trigger_type=event + a marker), **notify** (email/webhook/push via the connector framework), **ptz_preset** (driver PTZ), **trigger_output** (driver IO relay), **popup** (a NATS UI event). Cooldown + schedule per rule. CRUD `/api/v1/vms/linkage-rules`.
- **Event markers on the timeline**: extend `GET /cameras/{id}/timeline` to include motion/event markers (from VmsEvent occurred_at) so the P4-C scrub bar shows them (the "left out for P5" markers).
- **Access↔video verification** (PSIM differentiator): subscribe to `tenant.<id>.access.*` (gates events) → for a door event (forced/held) find the camera(s) placed at/near that door (DevicePlacement / a door↔camera link) → fire a linkage action (pop camera live + start recording + raise an incident with the video). Wire the door→camera association (a simple mapping or via placement proximity).
- Verify: a motion event → linkage rule starts an event-clip recording + a marker on the timeline; a fabricated access "door forced" → the associated camera pops/records; notify/ptz/output actions fire (fixture where hardware-bound); cooldown holds.

### P5-C — frontend (events feed + linkage rules + markers + Events integration)
- **VMS Events feed** (a camera-events surface, or fold into the existing Events alarm monitor): list camera events (type/severity/camera/time/ack) with filters + live (SSE via the core realtime bridge on `tenant.*.vms.>` — reuse the access-events SSE pattern) + ack + jump-to-recording (open PlaybackPlayer at the event time).
- **Linkage-rule editor** (Config or under Cameras): trigger + camera scope + actions builder + cooldown/schedule. Port gvd_nvr linkage UI.
- **Event markers on the PlaybackPlayer scrub bar** (from the extended timeline).
- **Wire camera into the Events alarm cards**: an incident whose source is a camera event shows the camera's live/last-snapshot + a "view recording" (at the event time) — closes the PSIM loop (alarm-monitor already built; just add the camera media).
- Verify: routes 200, compile clean; live event feed + markers need real cameras.

## Honest verifiability
Event ingestion + linkage + the correlation→incident path testable by publishing synthetic camera events (no real ONVIF device needed for the pipeline). Real ONVIF PullPoint motion/tamper from the owner's cameras validates on hardware (`# LIVE-VALIDATE`).

## Done when
Camera device-events flow ONVIF/brand → NATS → SOP incidents (alarm-monitor) + linkage rules (record/notify/PTZ/output) fire + events mark the timeline + access↔video verification works — verified on synthetic events + fixtures. Then P6 (enterprise hardening).
