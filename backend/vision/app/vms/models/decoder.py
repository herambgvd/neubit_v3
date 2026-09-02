"""Video-decoder model — hardware decoder push (VW-B).

An enterprise Video Wall (VW-A) can drive two kinds of monitor: a ``browser`` kiosk
(renders its cells client-side via MediaMTX) and a ``decoder`` — a physical hardware
video decoder (Hikvision / Dahua-CP-Plus) whose HDMI/BNC outputs each drive one control-
room screen. When an operator pushes a camera to a decoder-backed monitor cell, the wall
service (VW-B) reaches the decoder over its brand SDK and tells the decoder to pull that
camera's RTSP onto the corresponding output/cell.

``VideoDecoder`` is the tenant-scoped catalog row for one such decoder appliance:

  * ``brand`` — ``hikvision`` (ISAPI dynamic-decoding) or ``dahua_cpplus`` (Dahua CGI;
    CP-Plus is a Dahua OEM, one driver covers both).
  * ``host`` / ``port`` — the decoder's HTTP/ISAPI/CGI management endpoint.
  * ``username`` / ``enc_password`` — decoder management creds, password REVERSIBLY
    encrypted at rest exactly like a camera's ``onvif_enc_pass`` (``common.crypto``).
  * ``channel_count`` — number of decode outputs the appliance exposes (informational /
    UI hint; a ``WallMonitor.decoder_channel`` indexes into it).

⭐ Migration gotcha (project memory): this module is imported by ``models/__init__``
(which ``migrations/env.py`` imports wholesale) AND must be listed in
``0001_vision_baseline._tables()`` AND landed on deployed DBs by ``0013_video_decoder``
— a model whose table isn't in all three is silently dropped on a fresh deploy.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean,
    DateTime,
    Index,
    Integer,
    String,
    Uuid,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base

from ._common import _utcnow, _uuid_str


class VideoDecoder(Base):
    """A tenant-scoped hardware video-decoder appliance (Hik / Dahua-CP-Plus).

    Mirrors the camera creds-at-rest discipline: ``enc_password`` is stored REVERSIBLY
    encrypted (``common.crypto.encrypt_secret``) and decrypted in-memory only when the
    wall service constructs a ``DecoderDriver`` call.
    """

    __tablename__ = "video_decoders"
    __table_args__ = (
        Index("ix_video_decoders_tenant", "tenant_id"),
        Index("ix_video_decoders_tenant_name", "tenant_id", "name"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid_str)
    tenant_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True, index=True)

    name: Mapped[str] = mapped_column(String(255), nullable=False)
    # 'hikvision' (ISAPI dynamic-decoding) | 'dahua_cpplus' (Dahua CGI).
    brand: Mapped[str] = mapped_column(
        String(32), nullable=False, server_default=text("'hikvision'")
    )

    host: Mapped[str] = mapped_column(String(255), nullable=False)
    port: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("80"))

    username: Mapped[str | None] = mapped_column(String(255))
    # Reversibly-encrypted management password (common.crypto ``enc:...`` form).
    enc_password: Mapped[str | None] = mapped_column(String(1024))

    # Number of decode outputs the appliance exposes (UI hint; WallMonitor.decoder_channel
    # indexes into it). 0 = unknown.
    channel_count: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default=text("0")
    )

    is_enabled: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("true")
    )

    created_by: Mapped[str | None] = mapped_column(String(36))
    updated_by: Mapped[str | None] = mapped_column(String(36))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )
