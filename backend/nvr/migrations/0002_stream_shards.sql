-- nvr P2-A — live-stream orchestration schema.
--
-- The nvr data-plane owns the media-node registry + camera→node shard
-- assignment. This is nvr-side (not a read model off vision) because the
-- supervisor's placement + reassignment logic is a pure data-plane concern and
-- keeping it local avoids a cross-service write dependency for every stream. The
-- Python `vision` control-plane addresses streams by (camera_id, profile) and
-- never needs to read these tables directly — it calls nvr's REST endpoints.
--
-- Applied by gokernel/db.Migrate (idempotent; recorded in _migrations).

-- media_nodes — the MediaMTX node registry. In P2 there is a single node; the
-- table is the seam for multi-node sharding (least-loaded assignment + failover
-- rebalance hardened in P6).
CREATE TABLE IF NOT EXISTS media_nodes (
    id           text        PRIMARY KEY,          -- e.g. "mediamtx-0"
    api_url      text        NOT NULL,             -- internal control API (:9997)
    hls_base     text        NOT NULL,             -- browser-facing HLS base
    webrtc_base  text        NOT NULL,             -- browser-facing WHEP base
    rtsp_base    text        NOT NULL,             -- browser-facing RTSP base
    healthy      boolean     NOT NULL DEFAULT true,
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    created_at   timestamptz NOT NULL DEFAULT now()
);

-- stream_shards — one row per active (tenant, camera, profile) stream, pinned to
-- the media_node that serves it. path_name is the MediaMTX path
-- (cameras/<tenant>/<camera>/<profile>). Reassignment on node loss updates
-- node_id (P6). tenant_id is nullable only to tolerate platform/test streams.
CREATE TABLE IF NOT EXISTS stream_shards (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id     text        NOT NULL,
    camera_id     text        NOT NULL,
    profile       text        NOT NULL DEFAULT 'main',
    node_id       text        NOT NULL REFERENCES media_nodes(id),
    path_name     text        NOT NULL,
    rtsp_url      text        NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, camera_id, profile)
);

CREATE INDEX IF NOT EXISTS ix_stream_shards_node ON stream_shards (node_id);
