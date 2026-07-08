"""VMS control-plane ORM models (vision service DB: neubit_vision).

P1-A SCAFFOLD: the real domain tables — Camera / NVR / MediaProfile /
CameraGroup / CameraACL / CameraHealth / MediaNode / StreamShard (see
docs/VMS_P1_PLAN.md §Data model) — are added in the NEXT module. This module is
deliberately (near-)empty for now, but it is ALREADY WIRED into both
``migrations/env.py`` and the ``0001_baseline`` metadata sweep so that later,
adding a model here + listing it in the baseline is the ONLY step needed for a
fresh deploy to create it (guards the project's "imported-or-silently-dropped"
migration gotcha).

A single placeholder table (``vms_meta``) exists so the baseline has something to
create and the service's DB is provably migration-tracked in P1.
"""

from __future__ import annotations

import datetime as dt

from sqlalchemy import DateTime, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class VmsMeta(Base):
    """Placeholder metadata row — proves the baseline migration ran (P1).

    Removed/superseded when the real camera domain lands next module; kept tiny
    on purpose so it carries no schema commitments.
    """

    __tablename__ = "vms_meta"

    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[str] = mapped_column(String(255), nullable=False)
    updated_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
