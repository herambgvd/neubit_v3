"""Bring a service's schema up to head, correctly on a fresh AND an existing DB.

    python -m kernel.migrate <baseline-revision> [--widen-version-table]

Run it from the service's directory (where its `alembic.ini` is). It is the
Python form of `deploy/migrate.sh` and `backend/core/migrate.sh`, for the native
Windows appliance, which has no bash. The decision is the same, and the reasons
are written up in those scripts:

  * fresh database (no alembic_version row) -> upgrade to the baseline, which
    builds the CURRENT schema from the ORM metadata, then stamp head: every later
    revision is already folded into what the baseline built, and replaying them
    fails ("column already exists", "column does not exist");
  * existing database -> plain `upgrade head`, so migrations authored since the
    last deploy actually run. Nothing is stamped that did not run.

`--widen-version-table` is core's extra step: alembic creates
`alembic_version.version_num` as VARCHAR(32) when `stamp` makes the table, and
core's descriptive revision ids brush that limit. It is idempotent, so it runs on
both branches.
"""

from __future__ import annotations

import argparse
import asyncio
import io
import sys
from dataclasses import dataclass
from typing import Callable


@dataclass
class Plan:
    fresh: bool
    steps: list[tuple[str, str]]  # (alembic command, revision)


def plan(current: str, baseline: str) -> Plan:
    """What to run, given `alembic current`'s output (empty = no version row)."""
    if current.strip():
        return Plan(fresh=False, steps=[("upgrade", "head")])
    return Plan(fresh=True, steps=[("upgrade", baseline), ("stamp", "head")])


def _alembic_config(stdout: io.StringIO | None = None):
    from alembic.config import Config

    return Config("alembic.ini", stdout=stdout or sys.stdout)


def current_revision() -> str:
    """`alembic current`, captured. Read-only: it never creates the version table."""
    from alembic import command

    buf = io.StringIO()
    command.current(_alembic_config(buf))
    return buf.getvalue()


def _run(step: tuple[str, str]) -> None:
    from alembic import command

    verb, rev = step
    getattr(command, verb)(_alembic_config(), rev)


def widen_version_table(url: str) -> None:
    from sqlalchemy.ext.asyncio import create_async_engine
    from sqlalchemy.pool import NullPool

    async def _widen() -> None:
        engine = create_async_engine(url, poolclass=NullPool)
        try:
            async with engine.begin() as conn:
                await conn.exec_driver_sql(
                    "ALTER TABLE alembic_version ALTER COLUMN version_num TYPE VARCHAR(255)"
                )
        finally:
            await engine.dispose()

    asyncio.run(_widen())


def database_url() -> str:
    """The URL the service's own `env.py` resolved, so this never second-guesses it."""
    cfg = _alembic_config(io.StringIO())
    from alembic import command

    command.current(cfg)  # imports env.py, which sets sqlalchemy.url
    url = cfg.get_main_option("sqlalchemy.url")
    if not url:
        raise SystemExit("migrate: env.py did not set sqlalchemy.url")
    return url


def main(
    argv: list[str] | None = None,
    *,
    current: Callable[[], str] = current_revision,
    run: Callable[[tuple[str, str]], None] = _run,
    widen: Callable[[], None] | None = None,
) -> int:
    ap = argparse.ArgumentParser(prog="python -m kernel.migrate")
    ap.add_argument("baseline", help="the baseline revision id, e.g. 0001_vision_baseline")
    ap.add_argument("--widen-version-table", action="store_true")
    args = ap.parse_args(argv)

    p = plan(current(), args.baseline)
    if p.fresh:
        print(f"migrate: fresh database - building schema from {args.baseline}, then stamping head")
    else:
        print("migrate: existing database - replaying to head")
    for step in p.steps:
        run(step)

    if args.widen_version_table:
        (widen or (lambda: widen_version_table(database_url())))()
        print("migrate: alembic_version.version_num ensured VARCHAR(255)")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
