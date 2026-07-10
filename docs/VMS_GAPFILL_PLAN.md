# VMS — Gap-fill plan (enterprise feature parity, NO AI)

Review (2026-07-09) found major E-tier features missing vs Milestone/Genetec/CP-Plus.
User: build ALL of these, only AI analytics excluded. Spec-first, phase-by-phase,
Docker-verified, committed on `feat/vms`. Each phase = backend (vision, own migration +
rebuild) then frontend; a frontend phase may pipeline with the NEXT backend (frontend vs
vision are different containers) but backends run SEQUENTIALLY (one migration head at a time).

Current heads: vision `0013_video_decoder`, core `0012_security`, workflow `0005_device_tokens`, nvr `0004_resilience`.

## G1 — PTZ operator control (highest priority)
Drivers already have goto-preset (Hik/ONVIF/CP-Plus/Lumina). Add the full operator surface.
- **Backend (vision)**: PTZ command API — continuous move (pan/tilt/zoom start+stop), absolute/relative, zoom, focus/iris; **presets** create/list/goto/delete; **patrols/guard-tours** (ordered presets + dwell, start/stop, optional schedule). `PtzPreset` + `PtzPatrol` models + migration. Extend `CameraDriver.ptz` for continuous move/stop + preset set/remove where the brand supports it; graceful degrade. Perm `vms.ptz.control`.
- **Frontend**: PTZ control overlay on `LivePlayer` (pan/tilt pad + zoom/focus buttons, hold-to-move), a preset bar (save/goto), patrol start/stop. Show only when `camera.ptz_capable`.

## G2 — Operations / Health Dashboard
The main Dashboard tab is disabled ("SOON"), no route. Build the live ops overview.
- **Backend (vision + maybe core aggregate)**: a dashboard summary endpoint aggregating EXISTING data — camera-health rollup (online/offline/degraded), recording status (recording/idle/failed counts), storage capacity + %used + simple forecast (days-to-full from recent growth), node/media-node health + failover status, bandwidth estimate, alarm/event counts (24h), NVR health. Mostly reads health/recording/storage/event/supervisor data.
- **Frontend**: `/dashboard` page (enable the disabled tab) — KPI cards + health rollup + storage gauges + recent-alarms strip + node status. Auto-refresh.

## G3 — Bookmarks + Evidence Lock / Legal Hold
- **Backend (vision)**: `Bookmark` model (camera_id, tenant, ts/range, title, note, tags, created_by) CRUD + list by camera/time. `EvidenceLock` / retention-hold on `Recording` (or a lock table) that **the retention worker MUST respect** (locked segments never auto-deleted) + optional case/reference. Perms `vms.bookmark.*` / reuse export/recording perms. Migration.
- **Frontend**: bookmark create on playback timeline + bookmark list/markers; evidence-lock toggle on a recording/segment + a "protected" badge; a bookmarks/evidence panel.

## G4 — Smart / Forensic Motion Search (non-AI)
Find motion in a drawn region over a time window in recorded footage. VMD-based (ffmpeg scene/
select or motion energy over the segment crop), NOT AI.
- **Backend (vision)**: a motion-search job — given camera + time-window + region rect(s), analyze the covering recorded segments (ffmpeg motion/scene filter on the cropped region) → return hit intervals with scores. Async job + result (reuse the export/ffmpeg worker pattern). Perm `vms.playback.view`.
- **Frontend**: on playback, draw a region on a reference frame + pick window → run → hits on the timeline → click to jump.

## G5 — Privacy Masking + Motion-Zone drawing UI
Backend already stores `privacy_masks` (camera config) + config API; add `motion_zones` similarly and the DRAW tools (currently "— P2" stubs).
- **Backend (vision)**: add `motion_zones` to camera config + `configure(section=motion_config/privacy_masks)` driver push (drivers already have a configure seam). Small migration/field.
- **Frontend**: a canvas draw-tool over a snapshot/live frame for privacy masks (rectangles/polys) + motion zones (grid/regions + sensitivity), saved to camera config. Replace the CameraConfigForm P2 placeholders.

## G6 — Audio (two-way + recording)
- **Backend (vision + nvr)**: audio recording — include the audio track when recording (MediaMTX/ffmpeg carries audio if the stream has it; add `audio_enabled` flag on the camera/recording). Two-way audio (talk-to-camera) via ONVIF backchannel / brand API — a `talk` command (driver detects `backchannel` capability already). Real backchannel push = `# LIVE-VALIDATE`.
- **Frontend**: live "listen" (unmute) toggle + push-to-talk button (uses browser mic → WHIP/backchannel).

## G7 — Device / fleet management (medium)
- **Backend (vision)**: driver ops — config backup/restore, firmware info (+ update where supported), reboot, bulk password change, NTP/time-sync. Graceful per brand.
- **Frontend**: a device-management panel (per camera + bulk) under Devices → Cameras.

## G8 — Reports: operator-activity + alarm-response (medium)
- **Backend**: new report kinds — operator activity (from core audit) + alarm/incident response-time analytics (from workflow incidents). May read core/workflow.
- **Frontend**: add the two report kinds to the Reports page.

## Deliberately excluded
AI analytics (LPR / face / people-count / object). "Abhi AI nahi chahiye."

## Done when
G1–G8 built + Docker-verified (synthetic/fixtures) + committed. Real PTZ moves / backchannel
audio / firmware push / real motion-search accuracy = `# LIVE-VALIDATE` on the owner's hardware.
