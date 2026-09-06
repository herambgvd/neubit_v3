"""Right-to-erase for the reporting store — every relation, not just the modelled ones.

WHY THIS EXISTS INSTEAD OF JUST kernel.lifecycle.erase_tenant_data
------------------------------------------------------------------
The kernel's erase walks ``Base.metadata``. That is the right answer for the
other five satellites, whose databases contain exactly what their models declare.
This one does not. Three kinds of relation here hold tenant rows and no model
can declare any of them:

  * the PROJECTION relations (`access_events`, `iot_alerts`) — created at runtime
    from a `reporting_projections` row, which is the whole point of registering a
    projection as data;
  * their ROLLUPS and the two readings rollups — continuous aggregates, which
    SQLAlchemy has no way to express;
  * anything a projection added after this file was written.

At the time of writing that was `access_events` (door-level movement, carrying
`cardholder_ref`), `iot_alerts`, and four aggregates retaining derived rows for up
to 1825 days. A metadata-only erase leaves all of it, and reports a row count that
looks like the job was done.

So this does not enumerate anything. It ASKS THE DATABASE which relations carry
the tenant, and deletes from each. A projection added next month is covered on
the day it is added, with no edit here.

CONTINUOUS AGGREGATES ARE DELETED THROUGH THEIR MATERIALIZATION HYPERTABLE
--------------------------------------------------------------------------
``DELETE FROM access_events_1h`` fails outright — a real-time aggregate is a
UNION view and Postgres will not delete through it. The two alternatives are:

  * refresh the aggregate over the affected range after clearing the source. This
    is the documented path, and it is WRONG here: source retention (90 days for
    readings) is shorter than aggregate retention (400 and 1825 days), so a
    refresh of an old window recomputes those buckets from source data that has
    been dropped — erasing every OTHER tenant's history along with the one being
    offboarded.
  * delete from the aggregate's materialization hypertable, filtered by tenant.
    Precise: it removes one tenant's buckets and touches nobody else's.

The second one, therefore. The materialization hypertable's name is read from
``timescaledb_information.continuous_aggregates`` rather than guessed. No refresh
is needed afterwards: the source rows are gone in the same transaction, so a later
refresh recomputes the same empty result.
"""

from __future__ import annotations

import json
import logging
import re
import uuid

from sqlalchemy import text

log = logging.getLogger("reporting.erasure")

# Relation and column names are quoted into DDL-shaped SQL below because a table
# name cannot be a bind parameter. Everything reaching that point comes from the
# Postgres catalog or from a registry spec that `app/projections/spec.py` already
# validated against this same pattern — but it is re-checked here, because "the
# other end validates it" is how a validation stops being in force.
_IDENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def _ident(name: str, what: str) -> str:
    if not _IDENT.match(name or ""):
        raise ValueError(f"{what} {name!r} is not a usable identifier")
    return name


async def _registry_tenant_columns(session) -> dict[str, str]:
    """Relation -> tenant column, for projections that name theirs something
    other than `tenant_id`. The generic sweep below finds `tenant_id` on its own;
    this is what keeps a differently-named one from being missed silently."""
    exists = await session.execute(text("SELECT to_regclass('public.reporting_projections')"))
    if exists.scalar() is None:
        return {}
    out: dict[str, str] = {}
    rows = await session.execute(text("SELECT spec FROM reporting_projections"))
    for (spec,) in rows:
        if isinstance(spec, (str, bytes)):
            spec = json.loads(spec)
        if not isinstance(spec, dict):
            continue
        target = spec.get("target")
        if not isinstance(target, dict) or not target.get("relation"):
            continue
        for col in target.get("columns") or []:
            if isinstance(col, dict) and col.get("tenant") and col.get("name"):
                out[str(target["relation"])] = str(col["name"])
    return out


async def _tables_with_tenant(session) -> dict[str, str]:
    """Every ordinary table in `public` that carries a tenant column.

    Hypertable chunks live in `_timescaledb_internal`, so the schema filter keeps
    this to the 15-ish relations a person would name, not the hundreds Timescale
    partitions them into — deleting from the parent covers the chunks anyway.
    """
    rows = await session.execute(
        text(
            "SELECT c.table_name FROM information_schema.columns c "
            "JOIN information_schema.tables t "
            "  ON t.table_schema = c.table_schema AND t.table_name = c.table_name "
            "WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id' "
            "  AND t.table_type = 'BASE TABLE'"
        )
    )
    found = {str(r[0]): "tenant_id" for r in rows}
    found.update(await _registry_tenant_columns(session))
    return found


async def _aggregate_materializations(session) -> list[tuple[str, str, str]]:
    """(aggregate name, materialization schema, materialization table) for every
    continuous aggregate whose materialization carries `tenant_id`."""
    rows = await session.execute(
        text(
            "SELECT ca.view_name, ca.materialization_hypertable_schema, "
            "       ca.materialization_hypertable_name "
            "  FROM timescaledb_information.continuous_aggregates ca "
            "  JOIN information_schema.columns c "
            "    ON c.table_schema = ca.materialization_hypertable_schema "
            "   AND c.table_name = ca.materialization_hypertable_name "
            " WHERE c.column_name = 'tenant_id'"
        )
    )
    return [(str(a), str(b), str(c)) for a, b, c in rows]


async def erase_tenant_data(database, tenant_id: str) -> dict[str, int]:
    """Delete ``tenant_id``'s rows from every relation in this database that has any.

    One transaction. Returns rows removed per relation, so the log says WHAT was
    erased rather than only how much — a total of 0 and "there was nothing to
    erase" look identical otherwise.

    Idempotent, which is what makes it safe for the bus to redeliver after a
    partial failure.
    """
    tid = uuid.UUID(str(tenant_id))
    removed: dict[str, int] = {}
    async with database.get_sessionmaker()() as session:
        for relation, column in sorted((await _tables_with_tenant(session)).items()):
            _ident(relation, "relation")
            _ident(column, "tenant column")
            result = await session.execute(
                text(f'DELETE FROM public."{relation}" WHERE "{column}" = :tid').bindparams(
                    tid=tid
                )
            )
            if result.rowcount:
                removed[relation] = result.rowcount

        for view, schema, table in await _aggregate_materializations(session):
            _ident(schema, "materialization schema")
            _ident(table, "materialization table")
            result = await session.execute(
                text(
                    f'DELETE FROM "{schema}"."{table}" WHERE tenant_id = :tid'
                ).bindparams(tid=tid)
            )
            if result.rowcount:
                removed[view] = result.rowcount

        await session.commit()
    log.info("erased tenant %s: %s", tid, removed or "nothing")
    return removed
