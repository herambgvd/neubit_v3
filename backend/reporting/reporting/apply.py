"""Entrypoint: reconcile the reporting store's Timescale policies with the env.

    python -m reporting.apply

Run by the `reporting-migrate` container after `alembic upgrade head`, on every
`docker compose up`. Change a `VE_READINGS_*` variable in deploy/.env, then
`docker compose up -d reporting-migrate`, and the live policies follow.

Prints the reconciliation result so a deploy log shows exactly which policies
were created, replaced, removed or left alone.
"""

from __future__ import annotations

import asyncio
import logging
import sys

from reporting.db import database
from reporting.policies import PolicyConfig
from reporting.reconcile import reconcile_policies

log = logging.getLogger("reporting.apply")


async def main() -> None:
    cfg = PolicyConfig.from_env()
    engine = database.get_engine()
    async with engine.begin() as conn:
        result = await conn.run_sync(reconcile_policies, cfg)
    await engine.dispose()

    width = max(len(k) for k in result)
    for name, what in result.items():
        print(f"  {name:<{width}}  {what}")


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s %(message)s")
    try:
        asyncio.run(main())
    except Exception as exc:  # startup gate: fail loudly, never silently.
        print(f"apply policies failed: {exc}", file=sys.stderr)
        raise
