"""DDL from a spec: the relations a projection declares, brought into existence.

WHY THIS IS HERE AND NOT IN A MIGRATION
---------------------------------------
`reporting-migrate` owns the IoT schema and the two registry tables, and it runs
at deploy time. A projection, by design, is inserted at any time with no deploy —
so a migration cannot know which relations a projection needs. If it had to, then
"registration is data" would hold only for the last mile and a new domain would
still wait on a release. The ownership split is therefore:

    reporting-migrate   → the IoT schema, `dashboard_datasets`, `reporting_projections`
    reporting-projector → every relation declared inside `reporting_projections`

WHAT IT WILL AND WILL NOT DO
----------------------------
Additive only, and idempotent:

  * `CREATE TABLE IF NOT EXISTS` with the natural key as the primary key
  * `create_hypertable(..., if_not_exists => TRUE)`
  * `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` for a column added to a spec later
  * `CREATE INDEX IF NOT EXISTS`
  * `CREATE MATERIALIZED VIEW ... WITH (timescaledb.continuous)` for a rollup that
    does not exist yet, `WITH NO DATA` so a first run cannot block on a backfill
  * refresh and retention policies, `if_not_exists => TRUE`

It never drops a relation, never drops a column, and never alters a column's
type. A spec change that would need any of those is reported as a mismatch and
the projection is REFUSED — rewriting a live column's type underneath a running
dashboard is not something a background service should decide to do.

Every identifier is validated by `spec.py` before it arrives here (the same
`^[A-Za-z_][A-Za-z0-9_]*$` allowlist the dashboard builder's SQL generator uses)
and every interval literal against a closed pattern. That is what makes quoting
them into DDL — the one place values cannot be bound as parameters — safe.
"""

from __future__ import annotations

import logging

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection

from .spec import PG_TYPE, Projection, ProjectionRow

log = logging.getLogger("projector.ensure")


class SchemaRefused(Exception):
    """The declared shape cannot be reached additively. The projection is skipped."""


async def _regclass(conn: AsyncConnection, name: str) -> bool:
    got = await conn.execute(text("SELECT to_regclass(:n)").bindparams(n=f"public.{name}"))
    return got.scalar() is not None


async def _columns(conn: AsyncConnection, relation: str) -> dict[str, str]:
    rows = await conn.execute(
        text(
            "SELECT column_name, data_type FROM information_schema.columns "
            "WHERE table_schema='public' AND table_name=:t"
        ).bindparams(t=relation)
    )
    return {r[0]: r[1] for r in rows.all()}


async def _is_hypertable(conn: AsyncConnection, relation: str) -> bool:
    got = await conn.execute(
        text(
            "SELECT 1 FROM timescaledb_information.hypertables "
            "WHERE hypertable_schema='public' AND hypertable_name=:t"
        ).bindparams(t=relation)
    )
    return got.first() is not None


async def _is_cagg(conn: AsyncConnection, relation: str) -> bool:
    got = await conn.execute(
        text(
            "SELECT 1 FROM timescaledb_information.continuous_aggregates "
            "WHERE view_schema='public' AND view_name=:t"
        ).bindparams(t=relation)
    )
    return got.first() is not None


# `information_schema.data_type` spelling for each declared type, so an existing
# column can be compared against what the spec now says without guessing.
_INFO_TYPE = {
    "timestamptz": "timestamp with time zone",
    "uuid": "uuid",
    "text": "text",
    "bigint": "bigint",
    "double precision": "double precision",
    "boolean": "boolean",
    "jsonb": "jsonb",
}


async def ensure_target(conn: AsyncConnection, proj: Projection) -> bool:
    """Create or converge the fact relation. Returns True if it created it."""
    t = proj.target
    created = False
    if not await _regclass(conn, t.relation):
        cols = ",\n  ".join(
            f'"{c.name}" {PG_TYPE[c.type]}' + (" NOT NULL" if c.required or c.tenant else "")
            for c in t.columns
        )
        pk = ", ".join(f'"{c}"' for c in t.natural_key)
        await conn.execute(
            text(f'CREATE TABLE "{t.relation}" (\n  {cols},\n  PRIMARY KEY ({pk})\n)')
        )
        created = True
        log.info("created relation %s (%d columns)", t.relation, len(t.columns))

    existing = await _columns(conn, t.relation)
    for c in t.columns:
        if c.name not in existing:
            # A column added to a spec after the table was created. NULLable
            # regardless of `required`: existing rows genuinely do not have it,
            # and backfilling a value nobody published is the exact fabrication
            # this pipeline exists to avoid.
            await conn.execute(
                text(f'ALTER TABLE "{t.relation}" ADD COLUMN IF NOT EXISTS '
                     f'"{c.name}" {PG_TYPE[c.type]}')
            )
            log.info("added column %s.%s", t.relation, c.name)
            continue
        want = _INFO_TYPE[c.type]
        if existing[c.name] != want:
            raise SchemaRefused(
                f"{t.relation}.{c.name} is {existing[c.name]} but the spec says {want}; "
                "this service never rewrites a live column's type — fix the spec or "
                "migrate the column deliberately"
            )

    if not await _is_hypertable(conn, t.relation):
        await conn.execute(
            text(
                "SELECT create_hypertable(:rel, :col, "
                f"chunk_time_interval => INTERVAL '{t.chunk_interval}', "
                "if_not_exists => TRUE, migrate_data => TRUE)"
            ).bindparams(rel=t.relation, col=t.time_column)
        )
        log.info("made %s a hypertable on %s", t.relation, t.time_column)

    for idx in t.indexes:
        cols = ", ".join(f'"{c}"' for c in idx.columns)
        await conn.execute(
            text(f'CREATE INDEX IF NOT EXISTS "{idx.name}" ON "{t.relation}" ({cols})')
        )

    if t.retention:
        await conn.execute(
            text(
                "SELECT add_retention_policy(:rel, "
                f"INTERVAL '{t.retention}', if_not_exists => TRUE)"
            ).bindparams(rel=t.relation)
        )
    return created


async def ensure_rollups(conn: AsyncConnection, proj: Projection) -> None:
    t = proj.target
    for r in proj.rollups:
        if await _regclass(conn, r.relation) and not await _is_cagg(conn, r.relation):
            raise SchemaRefused(
                f"{r.relation} exists but is not a continuous aggregate; refusing to "
                "replace it (a plain view standing in for a rollup is exactly the "
                "kind of thing that quietly serves stale numbers)"
            )
        if await _is_cagg(conn, r.relation):
            # A continuous aggregate's SELECT list is fixed at creation and
            # Timescale has no `ALTER MATERIALIZED VIEW ... ADD COLUMN`. So a
            # group_by column added to the spec after the aggregate exists lands
            # NOWHERE, and the failure is invisible from here: the projection keeps
            # consuming, the registry publishes a dimension, and the chart that
            # uses it 500s on a column the rollup does not have — but only at the
            # resolution that reads the rollup, so it works over six hours and
            # breaks over six days.
            #
            # Refusing is the loud version of that (`/readyz` goes red, and the
            # reason names the columns). Recreating it would be a DROP, and this
            # service never drops a relation — a rollup that has to widen is
            # dropped DELIBERATELY by a migration, which is a reviewed change an
            # operator runs, and this service then rebuilds it from the fact table
            # on the next reload.
            have = set(await _columns(conn, r.relation))
            want = set(r.group_by) | {r.time_column} | {a.name for a in r.aggregates}
            missing = sorted(want - have)
            if missing:
                raise SchemaRefused(
                    f"{r.relation} exists but does not carry {', '.join(missing)}; a "
                    "continuous aggregate's columns are fixed at creation and this "
                    "service never drops one. Drop it deliberately in a migration and "
                    "it will be rebuilt from the fact table on the next reload."
                )
        else:
            group = ", ".join(f'"{c}"' for c in r.group_by)
            aggs = ", ".join(a.sql() for a in r.aggregates)
            sql = (
                f'CREATE MATERIALIZED VIEW "{r.relation}" '
                f"WITH (timescaledb.continuous, "
                f"timescaledb.materialized_only = {str(not r.real_time).lower()}) AS "
                f"SELECT time_bucket(INTERVAL '{r.bucket}', \"{t.time_column}\") "
                f'AS "{r.time_column}", {group}, {aggs} '
                f'FROM "{t.relation}" '
                f'GROUP BY 1, {group} '
                # WITH NO DATA: creating the aggregate must not block startup on a
                # full backfill. The refresh policy fills it in.
                "WITH NO DATA"
            )
            await conn.execute(text(sql))
            log.info("created continuous aggregate %s over %s", r.relation, t.relation)

        await conn.execute(
            text(
                "SELECT add_continuous_aggregate_policy(:rel, "
                f"start_offset => INTERVAL '{r.refresh.start_offset}', "
                f"end_offset => INTERVAL '{r.refresh.end_offset}', "
                f"schedule_interval => INTERVAL '{r.refresh.schedule_interval}', "
                "if_not_exists => TRUE)"
            ).bindparams(rel=r.relation)
        )
        if r.retention:
            await conn.execute(
                text(
                    "SELECT add_retention_policy(:rel, "
                    f"INTERVAL '{r.retention}', if_not_exists => TRUE)"
                ).bindparams(rel=r.relation)
            )


async def register_dataset(conn: AsyncConnection, row: ProjectionRow) -> None:
    """Publish the projection's `dashboard_datasets` row.

    The SAME path IoT registration uses — one row in the same table, read by the
    same loader and validated by the same validator. It happens here, after the
    relations exist, so the builder never lists a dataset whose relation would
    404 on the first query.

    The permission named on that row reaches core's catalog through the
    reading-writer's `permsync` on the next `/bi/datasets` read, which is what
    makes it GRANTABLE by a role rather than reachable only by a wildcard admin.
    """
    ds = row.spec.dataset
    if not ds:
        return
    import json as _json

    await conn.execute(
        text(
            """
            INSERT INTO dashboard_datasets
                (key, name, description, permission, permission_label,
                 permission_group, enabled, definition, updated_at)
            VALUES (:key, :name, :description, :permission, :permission_label,
                    :permission_group, true, CAST(:definition AS jsonb), now())
            ON CONFLICT (key) DO UPDATE SET
                name = excluded.name,
                description = excluded.description,
                permission = excluded.permission,
                permission_label = excluded.permission_label,
                permission_group = excluded.permission_group,
                definition = excluded.definition,
                updated_at = now()
            """
        ).bindparams(
            key=row.key,
            name=ds.get("name") or row.name,
            description=ds.get("description") or "",
            permission=ds["permission"],
            permission_label=ds.get("permission_label") or "",
            permission_group=ds.get("permission_group") or "Dashboard datasets",
            definition=_json.dumps(ds.get("definition") or {}),
        )
    )


async def ensure(conn: AsyncConnection, row: ProjectionRow) -> None:
    """Everything one projection needs, in dependency order."""
    await ensure_target(conn, row.spec)
    await ensure_rollups(conn, row.spec)
    await register_dataset(conn, row)
