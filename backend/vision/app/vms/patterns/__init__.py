"""Video-wall Patterns domain — rotating camera-group sequences (tenant-scoped).

A Pattern cycles through its ``camera_group_ids`` every ``seconds`` seconds on a
video wall / display. Self-contained (``schemas`` + ``service`` + ``router``); ported
from neubit_v2's auxiliary ``PatternDocument`` / pattern routes.
"""

from __future__ import annotations

from app.vms.patterns.router import router

__all__ = ["router"]
