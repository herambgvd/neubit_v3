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
  * ``media_node`` — MediaNode (a camera's node placement lives on Camera.media_node_id)
  * ``live``       — PlaybackSession (live/recorded viewer sessions, P2)
  * ``recording``  — Recording (finalized recording-segment metadata, P3)
  * ``storage``    — StoragePool (where recorded segments live, P3-B). Tiering and
                     RAID are the NVR's job; TierRule/RaidArray were deleted.
  * ``pattern``    — CameraPattern (video-wall rotating group sequences, P3-C)
  * ``event``      — VmsEvent (normalized camera device / system events, P5-A)
  * ``linkage``    — LinkageRule + LinkageFire (event→action rules + fire-audit, P5-B)
  * ``videowall``  — VideoWall + WallMonitor + WallPreset + WallTour (shared control-room
                     display wall + live shared-state + presets/tours, VW-A)
  * ``decoder``    — VideoDecoder (hardware video-decoder appliance the wall pushes camera
                     RTSP to over the brand SDK, VW-B)

NOT here, and each for the same reason — the recorder that owns the footage owns the
work: ``export`` (ExportJob), ``motion_search`` (MotionSearchJob) and ``ptz``
(PtzPreset + PtzPatrol). Their tables are dropped by 0031.
"""

from __future__ import annotations

from .bookmark import Bookmark
from .camera import Camera, MediaProfile
from .decoder import VideoDecoder
from .event import VmsEvent
from .evidence import EvidenceLock
from .group import CameraACL, CameraGroup
from .health import CameraHealth
from .linkage import LinkageFire, LinkageRule
from .live import PlaybackSession
from .media_node import MediaNode
from .nvr import NVR
from .pattern import CameraPattern
from .recording import Recording
from .report import ReportRun, ReportSchedule
from .storage import StoragePool
from .videowall import VideoWall, WallMonitor, WallPreset, WallTour

__all__ = [
    "Camera",
    "MediaProfile",
    "NVR",
    "CameraGroup",
    "CameraACL",
    "CameraHealth",
    "MediaNode",
    "PlaybackSession",
    "Recording",
    "StoragePool",
    "CameraPattern",
    "VmsEvent",
    "LinkageRule",
    "LinkageFire",
    "ReportSchedule",
    "ReportRun",
    "VideoWall",
    "WallMonitor",
    "WallPreset",
    "WallTour",
    "VideoDecoder",
    "Bookmark",
    "EvidenceLock",
]
