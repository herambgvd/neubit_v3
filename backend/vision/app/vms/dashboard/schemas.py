"""Dashboard summary response schemas (pydantic v2) — the G2 OpenAPI contract.

The frozen shape the G2-frontend binds to. Every sub-section is best-effort: an
empty/unreachable source yields zeros (or ``unknown`` for the nvr-fed node section),
never an error. Nothing here is persisted — it is computed per request.
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field


class CameraRollup(BaseModel):
    """Camera reachability rollup (from ``Camera.status``)."""

    total: int = 0
    online: int = 0
    offline: int = 0
    degraded: int = 0
    # Any status outside the three above (connecting/error/unknown) — surfaced so the
    # frontend can show "other" without the rollup silently under-counting.
    other: int = 0


class RecordingRollup(BaseModel):
    """Recording status rollup + estate recording throughput."""

    recording: int = 0  # cameras with a finalized segment in the recent window
    idle: int = 0  # enabled cameras not currently recording (mode off / no recent seg)
    failed: int = 0  # cameras with a recording_error event in the last 24h
    total_segments: int = 0  # all recordings rows (tenant-scoped)
    bytes_last_24h: int = 0  # sum(file_size) of segments created in the last 24h


class StoragePoolSummary(BaseModel):
    """One storage pool's capacity/usage + optional days-to-full forecast."""

    id: str
    name: str
    type: str
    capacity_bytes: Optional[int] = None  # max_size_bytes; null = unlimited/unknown
    used_bytes: int = 0
    used_pct: Optional[float] = None  # null when capacity unknown
    # Simple linear forecast from the last-7d growth; null when it can't be computed
    # (unlimited pool, no recent growth, or already full).
    days_to_full: Optional[float] = None


class StorageRollup(BaseModel):
    """Per-pool storage + an estate total."""

    pools: list[StoragePoolSummary] = Field(default_factory=list)
    total_capacity_bytes: Optional[int] = None  # sum of known capacities; null if none
    total_used_bytes: int = 0
    used_pct: Optional[float] = None  # overall, null when no capacities known


class MediaNodeSummary(BaseModel):
    """One media node's health (from the local ``media_nodes`` registry)."""

    id: str
    name: str
    healthy: bool
    status: str
    used_channels: int = 0
    capacity_channels: int = 0
    last_heartbeat: Optional[datetime] = None


class NodesRollup(BaseModel):
    """Media-node + failover/resilience state.

    ``data_plane`` is ``"ok"`` when the Go nvr answered, else ``"unknown"`` (nvr
    unreachable) — the frontend shows the node section greyed when unknown. The node
    LIST always comes from vision's own ``media_nodes`` table (so it renders even when
    the nvr is down); ``resilience`` / ``streaming`` / ``recording`` flags come from
    the live nvr ``/status`` (null when unknown).
    """

    data_plane: str = "unknown"  # ok | unknown
    nodes: list[MediaNodeSummary] = Field(default_factory=list)
    total: int = 0
    healthy: int = 0
    unhealthy: int = 0
    resilience: Optional[bool] = None  # heartbeat/rebalance + redundant record + ANR
    streaming: Optional[bool] = None
    recording: Optional[bool] = None
    nvr_node: Optional[str] = None  # the local nvr node id it reported
    nats: Optional[bool] = None


class EventItem(BaseModel):
    """One recent event for the dashboard alarms strip."""

    id: str
    camera_id: Optional[str] = None
    event_type: str
    severity: str
    title: str
    occurred_at: datetime
    acknowledged: bool = False


class CountBucket(BaseModel):
    """A ``{key, count}`` pair (by-severity / by-type breakdown)."""

    key: str
    count: int


class AlarmsRollup(BaseModel):
    """VmsEvent counts over the last 24h + a small recent list."""

    total: int = 0
    unacknowledged: int = 0
    by_severity: list[CountBucket] = Field(default_factory=list)
    by_type: list[CountBucket] = Field(default_factory=list)  # top few
    recent: list[EventItem] = Field(default_factory=list)


class NvrRollup(BaseModel):
    """Registered-NVR health rollup (from ``NVR.status``)."""

    total: int = 0
    healthy: int = 0
    unhealthy: int = 0


class DashboardSummary(BaseModel):
    """The full ops-dashboard payload — one request, all best-effort sections."""

    cameras: CameraRollup = Field(default_factory=CameraRollup)
    recording: RecordingRollup = Field(default_factory=RecordingRollup)
    storage: StorageRollup = Field(default_factory=StorageRollup)
    nodes: NodesRollup = Field(default_factory=NodesRollup)
    alarms: AlarmsRollup = Field(default_factory=AlarmsRollup)
    nvrs: NvrRollup = Field(default_factory=NvrRollup)
    generated_at: datetime
