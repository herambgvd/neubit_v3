"""Reconcile the reporting store's TimescaleDB background jobs with the config.

Alembic revisions run ONCE. Retention windows are a deployment setting that an
operator changes later, so they cannot live only in a migration. This module is
the other half: it reads :class:`PolicyConfig` and makes the live jobs match,
every time it runs. Idempotent — running it when nothing changed is a no-op.

Called from two places, both with a SYNCHRONOUS SQLAlchemy connection:
  * revision 0002, right after it creates the aggregates (first-run setup);
  * ``python -m reporting.apply``, run on every start of ``reporting-migrate``
    (ongoing reconciliation).

ORDER MATTERS, and TimescaleDB 2.17 enforces it: a continuous aggregate must
have a REFRESH policy before it will accept a COMPRESSION policy
("setup a refresh policy for ... before setting up a compression policy").
Refresh policies are therefore applied first.
"""

from __future__ import annotations

import logging

from sqlalchemy import String, bindparam, text
from sqlalchemy.engine import Connection

from reporting.policies import AGG_1H, AGG_1M, RAW, PolicyConfig, RefreshPolicy

log = logging.getLogger("reporting.reconcile")


# ── introspection ─────────────────────────────────────────────────────────────
def _jobs(conn: Connection, proc: str, target: str) -> list[tuple[int, dict]]:
    """Existing jobs of `proc` on `target`, resolving a cagg to its mat hypertable."""
    rows = conn.execute(
        text(
            """
            SELECT j.job_id, j.config
            FROM timescaledb_information.jobs j
            WHERE j.proc_name = :proc
              AND j.hypertable_name = COALESCE(
                    (SELECT materialization_hypertable_name
                       FROM timescaledb_information.continuous_aggregates
                      WHERE view_name = :target),
                    :target)
            """
        ),
        {"proc": proc, "target": target},
    ).all()
    return [(r[0], r[1] or {}) for r in rows]


def _same_interval(conn: Connection, want: str, current: str | None) -> bool:
    """Is `want` ('2 hours') the same interval as what Timescale stored ('02:00:00')?

    Two things make this fiddlier than it looks, and both cost a debugging round:
      * `:name` bind syntax and Postgres's `::` cast operator collide, so the cast
        must be spelled CAST(... AS interval);
      * asyncpg infers the parameter type from that cast and then demands a
        `timedelta`, so the parameters are pinned to text with an explicit
        bindparam type and cast from there.
    """
    if current is None:
        return False
    return bool(
        conn.execute(
            text(
                "SELECT CAST(CAST(:want AS text) AS interval)"
                "     = CAST(CAST(:cur AS text) AS interval)"
            ).bindparams(
                bindparam("want", want, type_=String),
                bindparam("cur", current, type_=String),
            )
        ).scalar()
    )


def _drop(conn: Connection, job_id: int) -> None:
    conn.execute(text("SELECT delete_job(:jid)"), {"jid": job_id})


# ── reconcilers ───────────────────────────────────────────────────────────────
def _reconcile_refresh(conn: Connection, view: str, want: RefreshPolicy) -> str:
    existing = _jobs(conn, "policy_refresh_continuous_aggregate", view)
    for job_id, cfg in existing:
        # Compare semantically: Timescale normalises '2 hours' to '02:00:00'.
        same = _same_interval(conn, want.start_offset, cfg.get("start_offset")) and \
            _same_interval(conn, want.end_offset, cfg.get("end_offset"))
        if same:
            return "unchanged"
        _drop(conn, job_id)

    conn.execute(
        text(
            f"SELECT add_continuous_aggregate_policy('{view}',"
            f"  start_offset => INTERVAL '{want.start_offset}',"
            f"  end_offset   => INTERVAL '{want.end_offset}',"
            f"  schedule_interval => INTERVAL '{want.schedule_interval}')"
        )
    )
    return "created" if not existing else "replaced"


def _reconcile_interval_policy(
    conn: Connection, proc: str, add_fn: str, key: str, target: str, want: str | None
) -> str:
    """Shared shape for compression (`compress_after`) and retention (`drop_after`)."""
    existing = _jobs(conn, proc, target)

    if want is None:
        for job_id, _ in existing:
            _drop(conn, job_id)
        return "removed" if existing else "absent"

    for job_id, cfg in existing:
        if _same_interval(conn, want, cfg.get(key)):
            return "unchanged"
        _drop(conn, job_id)

    conn.execute(text(f"SELECT {add_fn}('{target}', INTERVAL '{want}')"))
    return "created" if not existing else "replaced"


def reconcile_policies(conn: Connection, cfg: PolicyConfig | None = None) -> dict[str, str]:
    """Make the live Timescale jobs match `cfg`. Returns what changed, per policy."""
    cfg = cfg or PolicyConfig.from_env()
    result: dict[str, str] = {}

    # 1. Refresh policies FIRST — cagg compression requires them (see module doc).
    result["refresh:1m"] = _reconcile_refresh(conn, AGG_1M, cfg.refresh_1m)
    result["refresh:1h"] = _reconcile_refresh(conn, AGG_1H, cfg.refresh_1h)

    # 2. Compression.
    for target, want in ((RAW, cfg.compress_raw_after),
                         (AGG_1M, cfg.compress_1m_after),
                         (AGG_1H, cfg.compress_1h_after)):
        result[f"compress:{target}"] = _reconcile_interval_policy(
            conn, "policy_compression", "add_compression_policy", "compress_after",
            target, want,
        )

    # 3. Retention. Raw short, rollups long — see reporting.policies.
    for target, want in ((RAW, cfg.retain_raw),
                         (AGG_1M, cfg.retain_1m),
                         (AGG_1H, cfg.retain_1h)):
        result[f"retention:{target}"] = _reconcile_interval_policy(
            conn, "policy_retention", "add_retention_policy", "drop_after",
            target, want,
        )

    for name, what in result.items():
        log.info("policy %-24s %s", name, what)
    return result
