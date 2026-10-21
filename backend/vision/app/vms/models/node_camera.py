"""A recorder's cameras, as this VMS last saw them (SCRUM-334).

The recorder owns its cameras; the VMS never onboards them. It used to keep no copy
of them at all: every camera list was a live fan-out to every recorder, and a
recorder the heartbeat had marked offline was skipped. So the moment one stopped
answering, every screen read as though its cameras had never existed: an empty
wall, "0 cameras", a recorder card saying it ran nothing.

That is not how any VMS behaves. A camera is part of the system's configuration,
not the answer to a live query: when its recording server goes down, it stays in the
device tree and in every layout, shown offline, and comes back by itself.

This is that copy. The heartbeat, which already reads each recorder's full camera
list every cycle, writes it here; a list read while the recorder is down is served
from here with the reason. A row goes only when the recorder, answering, no longer
lists the camera, or when the recorder itself is deleted (CASCADE).

It is deliberately NOT the ``cameras`` table. A row there means "a camera this VMS
owns": it would be dialled over our own RTSP path, probed by the health sampler,
failed over, and listed a second time beside its federated self.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import JSON, DateTime, ForeignKey, String, UniqueConstraint, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base

from ._common import _utcnow, _uuid_str


class NodeCamera(Base):
    """One camera of one recorder, last seen at ``synced_at``."""

    __tablename__ = "node_cameras"
    __table_args__ = (
        UniqueConstraint("node_id", "remote_id", name="uq_node_cameras_node_remote"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid_str)
    tenant_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True, index=True)
    node_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("media_nodes.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # The camera's id ON THE RECORDER — what every federated call names it by.
    remote_id: Mapped[str] = mapped_column(String(64), nullable=False)
    name: Mapped[str] = mapped_column(String(255), nullable=False, default="")
    # The recorder's own camera row, whole, as it last served it — so a list read
    # while the recorder is down has the same shape as one read from it.
    data: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    synced_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )
