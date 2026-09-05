"""Load the projection registry. Registration is DATA, so this is the only reader.

One SELECT over `neubit_reporting.reporting_projections`, parsed into
`spec.ProjectionRow`. A row whose spec does not validate is SKIPPED with the
reason logged — never half-applied, because half a projection is a table quietly
missing a column, and that reads as "the data is wrong" rather than "the spec is
wrong".

The pipeline re-reads this on an interval (`VE_PROJECTOR_RELOAD_SEC`). That
interval is the whole promise of the design: an INSERT starts being projected
without a restart, a `DELETE`/`enabled=false` stops it, and neither needs a
release.
"""

from __future__ import annotations

import json
import logging

from pydantic import ValidationError as PydanticValidationError
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from .spec import Projection, ProjectionRow

log = logging.getLogger("projector.registry")

_SQL = text(
    """
    SELECT key, name, description, spec
      FROM reporting_projections
     WHERE enabled
     ORDER BY key
    """
)


async def load(db: AsyncSession) -> tuple[dict[str, ProjectionRow], dict[str, str]]:
    """Every valid, enabled projection keyed by `key`, plus the rejects and why."""
    rows = [dict(r) for r in (await db.execute(_SQL)).mappings().all()]
    ok: dict[str, ProjectionRow] = {}
    bad: dict[str, str] = {}
    for row in rows:
        raw = row.get("spec")
        if isinstance(raw, (str, bytes)):
            raw = json.loads(raw)
        try:
            parsed = ProjectionRow(
                key=row["key"],
                name=row["name"],
                description=row["description"] or "",
                spec=Projection.model_validate(raw),
            )
        except (PydanticValidationError, ValueError) as exc:
            reason = str(exc).replace("\n", " ")[:400]
            bad[str(row.get("key"))] = reason
            log.error("projection %r is not loadable and was skipped: %s", row.get("key"), reason)
            continue
        ok[parsed.key] = parsed
    return ok, bad
