"""VMS control-plane ORM models (vision service DB: neubit_vision).

Every table is TENANT-SCOPED (nullable ``tenant_id``) and uses plain-string
status/mode/type columns (NO PG enums — asyncpg add-column enum footgun, project
memory). Enterprise fields (recording / advanced / ptz / placement / node) are
present from day 1 (build-once).

⭐ Migration gotcha: importing every model module HERE is what registers its table
on ``Base.metadata``. This package is imported by BOTH ``migrations/env.py`` AND
``0001_vision_baseline._tables()`` — a table whose module is not imported in both
is silently dropped on a fresh deploy. Keep ``__all__`` and the baseline list in
sync when adding a model.

Domain split:
  * ``camera``     — Camera + MediaProfile
  * ``nvr``        — NVR
  * ``group``      — CameraGroup + CameraACL
  * ``health``     — CameraHealth
  * ``media_node`` — MediaNode + StreamShard
  * ``live``       — PlaybackSession (live/recorded viewer sessions, P2)
"""

from __future__ import annotations

from .camera import Camera, MediaProfile
from .group import CameraACL, CameraGroup
from .health import CameraHealth
from .live import PlaybackSession
from .media_node import MediaNode, StreamShard
from .nvr import NVR

__all__ = [
    "Camera",
    "MediaProfile",
    "NVR",
    "CameraGroup",
    "CameraACL",
    "CameraHealth",
    "MediaNode",
    "StreamShard",
    "PlaybackSession",
]
