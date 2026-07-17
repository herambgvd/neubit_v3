-- ── Recording self-heal: pin the camera RTSP on the recording target ─────────
-- Before this, the reconcile loop re-provisioned a dropped MediaMTX path using
-- the RTSP from stream_shards. But a live-stream teardown (DropStream, called
-- when the last live viewer leaves) DELETES the shard row — so a record-only
-- camera whose path later vanished had NO RTSP to re-provision from, and
-- SetRecord 404'd "path not found" on every reconcile tick, forever, until a
-- manual re-kick. Recording silently stopped while live kept working.
--
-- Persisting rtsp_url on the recording target makes recording self-healing fully
-- independent of the live-stream/shard lifecycle: reconcile prefers the live
-- shard's RTSP (fresh) but falls back to this pinned value when the shard is gone.
ALTER TABLE recording_targets
    ADD COLUMN IF NOT EXISTS rtsp_url text NOT NULL DEFAULT '';
