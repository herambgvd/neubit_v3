"""Camera-health request/response schemas (pydantic v2).

The frozen OpenAPI contract the health-dashboard + the Cameras-table "health"
column build against. Mirrors the camera/nvr domain shapes:

  * ``CameraHealthPublic`` — one health sample (status + stream metrics). P1 fills
    ``status`` from the reachability sampler; ``bitrate_kbps`` / ``fps_actual`` /
    ``packet_loss`` / ``latency_ms`` stay null until the Go ``nvr`` + MediaMTX feed
    real stream telemetry (P2).
  * ``CameraHealthListResponse`` — the latest-per-camera snapshot list
    (health-dashboard / table column).
  * ``CameraHealthHistoryResponse`` — the paginated time-series for one camera.

``CameraHealthPublic`` / ``CameraHealthListResponse`` were formerly parked in
``cameras/schemas.py``; the reorg relocates them here (this domain owns them). The
camera domain no longer references them.
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field


class CameraHealthPublic(BaseModel):
    """One camera health sample (time-series row)."""

    model_config = ConfigDict(extra="ignore")
    id: str
    camera_id: str
    status: str
    bitrate_kbps: Optional[int] = None
    fps_actual: Optional[float] = None
    packet_loss: Optional[float] = None
    latency_ms: Optional[int] = None
    captured_at: datetime

    @classmethod
    def from_row(cls, row) -> "CameraHealthPublic":
        return cls.model_validate(
            {
                "id": row.id,
                "camera_id": row.camera_id,
                "status": row.status,
                "bitrate_kbps": row.bitrate_kbps,
                "fps_actual": row.fps_actual,
                "packet_loss": row.packet_loss,
                "latency_ms": row.latency_ms,
                "captured_at": row.captured_at,
            }
        )


class CameraHealthListResponse(BaseModel):
    """Latest health snapshot per camera (health-dashboard / Cameras-table column)."""

    items: list[CameraHealthPublic]
    total: int


class CameraHealthHistoryResponse(BaseModel):
    """Paginated health time-series for a single camera."""

    items: list[CameraHealthPublic]
    total: int
    skip: int
    limit: int
