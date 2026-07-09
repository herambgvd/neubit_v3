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
  * ``recording``  — Recording (finalized recording-segment metadata, P3)
  * ``storage``    — StoragePool + TierRule (where segments live + tiering, P3-B)
  * ``pattern``    — CameraPattern (video-wall rotating group sequences, P3-C)
  * ``export``     — ExportJob (clip-export: concat recorded segments → mp4, P4-B)
  * ``event``      — VmsEvent (normalized camera device / system events, P5-A)
  * ``linkage``    — LinkageRule + LinkageFire (event→action rules + fire-audit, P5-B)
  * ``videowall``  — VideoWall + WallMonitor + WallPreset + WallTour (shared control-room
                     display wall + live shared-state + presets/tours, VW-A)
  * ``decoder``    — VideoDecoder (hardware video-decoder appliance the wall pushes camera
                     RTSP to over the brand SDK, VW-B)
"""

from __future__ import annotations

from .camera import Camera, MediaProfile
from .decoder import VideoDecoder
from .event import VmsEvent
from .export import ExportJob
from .group import CameraACL, CameraGroup
from .health import CameraHealth
from .linkage import LinkageFire, LinkageRule
from .live import PlaybackSession
from .media_node import MediaNode, StreamShard
from .nvr import NVR
from .onvif_server import OnvifServerConfig
from .pattern import CameraPattern
from .recording import Recording
from .report import ReportSchedule
from .storage import StoragePool, TierRule
from .videowall import VideoWall, WallMonitor, WallPreset, WallTour

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
    "Recording",
    "StoragePool",
    "TierRule",
    "CameraPattern",
    "ExportJob",
    "VmsEvent",
    "LinkageRule",
    "LinkageFire",
    "ReportSchedule",
    "OnvifServerConfig",
    "VideoWall",
    "WallMonitor",
    "WallPreset",
    "WallTour",
    "VideoDecoder",
]
