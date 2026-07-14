-- nvr P3-A — recording engine schema.
--
-- The nvr data-plane owns the DESIRED recording state (which camera/profile
-- should be recording now) + a segment ledger so the segment tracker dedupes and
-- only emits a NATS event ONCE per finalized segment. vision owns the durable
-- Recording metadata (neubit_vision); these tables are the nvr's local
-- reconciliation state, mirroring the stream_shards pattern.
--
-- Applied by gokernel/db.Migrate (idempotent; recorded in _migrations).

-- recording_targets — one row per (tenant, camera, profile) the control-plane has
-- asked to record. The recording-supervisor reconciles these against MediaMTX's
-- actual path record flag on every tick (+ on demand from the start/stop
-- endpoints). `active` is the desired state; vision drives it via start/stop.
-- `record_path` is the MediaMTX record template for this target.
CREATE TABLE IF NOT EXISTS recording_targets (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id     text        NOT NULL,
    camera_id     text        NOT NULL,
    profile       text        NOT NULL DEFAULT 'main',
    node_id       text,                            -- pinned node (set on ensure)
    path_name     text        NOT NULL,            -- cameras/<tenant>/<cam>/<profile>
    record_path   text        NOT NULL,            -- MediaMTX recordPath template
    active        boolean     NOT NULL DEFAULT true,
    trigger_type  text        NOT NULL DEFAULT 'continuous', -- continuous|schedule|motion|event|manual
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, camera_id, profile)
);

CREATE INDEX IF NOT EXISTS ix_recording_targets_active ON recording_targets (active);

-- recording_segments — the segment tracker's local ledger: one row per segment
-- path it has ALREADY emitted a NATS event for, so a segment is never
-- double-published across ticks/restarts. vision persists the durable Recording
-- row; this is only the emit-once dedupe key.
CREATE TABLE IF NOT EXISTS recording_segments (
    path         text        PRIMARY KEY,          -- absolute segment file path
    tenant_id    text        NOT NULL,
    camera_id    text        NOT NULL,
    profile      text        NOT NULL DEFAULT 'main',
    started_at   timestamptz,
    emitted_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_recording_segments_camera ON recording_segments (camera_id, started_at);
