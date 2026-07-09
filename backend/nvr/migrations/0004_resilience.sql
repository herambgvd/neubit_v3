-- nvr P6-A — recording resilience schema.
--
-- Three resilience pillars, all nvr-side (the data-plane owns placement +
-- reconciliation state, mirroring the P2-A/P3-A tables):
--
--   1. multi-node rebalance-on-node-loss — media_nodes gains an explicit
--      last_heartbeat + dead flag so the heartbeat monitor can mark a node dead
--      (no heartbeat within VE_NODE_DEAD_SEC) and reassign its stream_shards +
--      recording_targets to a healthy node.
--   2. redundant / failover recording — a per-target flag + a secondary node so
--      the recording-supervisor can drive record on BOTH a primary and a secondary
--      path/node (a single node loss then never loses footage).
--   3. ANR (edge-recording backfill) — an anr_jobs ledger tracking each backfill
--      of a detected recording gap after a camera reconnects.
--
-- Applied by gokernel/db.Migrate (idempotent; recorded in _migrations).

-- ── 1. node heartbeat (rebalance-on-node-loss) ──────────────────────────────
-- last_heartbeat is the freshest liveness stamp (updated by EnsureNode + the
-- monitor's own probe); a node with no heartbeat within VE_NODE_DEAD_SEC is
-- flipped healthy=false and its shards reassigned. `dead_since` records when the
-- monitor first observed it dead (for idempotent reassign + logging).
ALTER TABLE media_nodes
    ADD COLUMN IF NOT EXISTS last_heartbeat timestamptz NOT NULL DEFAULT now();

ALTER TABLE media_nodes
    ADD COLUMN IF NOT EXISTS dead_since timestamptz;

-- ── 2. redundant / failover recording ───────────────────────────────────────
-- A recording target can be flagged redundant: record is driven on BOTH the
-- primary node (node_id) and a secondary node (secondary_node_id) so a single
-- node loss does not lose footage. secondary_node_id is chosen at
-- StartRecording time (least-loaded among the OTHER healthy nodes) and re-picked
-- on rebalance. redundant defaults false → existing single-copy recording is
-- unchanged.
ALTER TABLE recording_targets
    ADD COLUMN IF NOT EXISTS redundant boolean NOT NULL DEFAULT false;

ALTER TABLE recording_targets
    ADD COLUMN IF NOT EXISTS secondary_node_id text;

-- Also flag stream_shards so live redundancy intent travels with the stream (a
-- redundant camera's live path can be re-ensured on the secondary on failover).
ALTER TABLE stream_shards
    ADD COLUMN IF NOT EXISTS redundant boolean NOT NULL DEFAULT false;

-- ── 3. ANR (edge-recording backfill) jobs ───────────────────────────────────
-- One row per backfill of a detected recording gap. status walks
-- queued → running → done|failed. backfilled_segments counts segments the edge
-- fulfiller pulled into the recordings volume (which then flow through the normal
-- segment tracker → Recording rows). tenant_id + camera_id are the scope; the
-- (camera_id, gap_from, gap_to) shape lets the gap-detector dedupe an in-flight
-- job for the same outage.
CREATE TABLE IF NOT EXISTS anr_jobs (
    id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id           text        NOT NULL,
    camera_id           text        NOT NULL,
    profile             text        NOT NULL DEFAULT 'main',
    gap_from            timestamptz NOT NULL,
    gap_to              timestamptz NOT NULL,
    status              text        NOT NULL DEFAULT 'queued', -- queued|running|done|failed
    backfilled_segments int         NOT NULL DEFAULT 0,
    error               text,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    completed_at        timestamptz
);

CREATE INDEX IF NOT EXISTS ix_anr_jobs_camera ON anr_jobs (camera_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_anr_jobs_status ON anr_jobs (status);

-- Guard against two concurrent jobs for the SAME camera+gap window: a partial
-- unique index over the ACTIVE statuses (an already-done/failed job for the same
-- window is fine to re-attempt later).
CREATE UNIQUE INDEX IF NOT EXISTS ux_anr_jobs_active
    ON anr_jobs (tenant_id, camera_id, profile, gap_from, gap_to)
    WHERE status IN ('queued', 'running');
