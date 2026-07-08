-- nvr baseline (P1) — placeholder schema for the Go data-plane service.
--
-- The nvr service owns its own DB (neubit_nvr). Heavy streaming/recording tables
-- (segments, shards, media-node registry, ANR jobs) arrive in P2–P3. For P1 this
-- baseline only records that the service's DB is provisioned + migration-tracked,
-- mirroring the Python services' "empty-ish 0001_baseline" convention.
--
-- Applied by gokernel/db.Migrate (idempotent; recorded in _migrations).

CREATE TABLE IF NOT EXISTS nvr_meta (
    key        text        PRIMARY KEY,
    value      text        NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO nvr_meta (key, value)
VALUES ('schema_phase', 'P1-baseline')
ON CONFLICT (key) DO NOTHING;
