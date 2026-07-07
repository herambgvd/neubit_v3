"""Dynamic per-channel notification config, stored in the DB (secrets encrypted).

Each delivery channel (email / push / webhook) is configured from the admin UI —
NOT from .env — because credentials differ per deployment and change at runtime.
So the config lives in one small table (``channel_configs``): one row per channel,
an ``enabled`` flag, and a free-form JSON ``config`` blob whose shape depends on the
channel.

Sensitive fields inside that JSON (the SMTP password, the FCM server key, the
webhook signing secret) MUST NOT sit in the DB as plaintext. We encrypt exactly
those fields on the way in (``upsert_channel``) and decrypt them on the way out
(``get_config_decrypted``). For GET responses shown in the UI we ``masked`` them to
``"***"`` so a secret is never returned over the wire.

Which fields are secret, per channel, is declared once in ``SECRET_FIELDS``.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    ForeignKey,
    String,
    UniqueConstraint,
    Uuid,
    func,
    select,
)
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Mapped, mapped_column

from ..core.secrets import decrypt_secret, encrypt_secret
from ..db.base import Base

# Which JSON keys hold secrets, per channel. Only these are encrypted at rest and
# masked in GET responses; everything else (host, port, url, ...) is plain config.
SECRET_FIELDS: dict[str, list[str]] = {
    "email": ["password"],
    "push": ["server_key"],
    "webhook": ["secret"],
}


class ChannelConfig(Base):
    """One row per delivery channel. ``config`` is a JSON blob (secrets encrypted)."""

    __tablename__ = "channel_configs"

    # One config per channel PER TENANT, plus one platform-default (tenant_id NULL).
    __table_args__ = (
        UniqueConstraint("channel", "tenant_id", name="uq_channel_configs_channel_tenant"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    # "email" | "push" | "webhook". One config per channel PER TENANT (uniqueness is
    # (channel, tenant_id), enforced in the service + a per-tenant unique index).
    channel: Mapped[str] = mapped_column(String, nullable=False, index=True)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    # --- multi-tenancy -----------------------------------------------------
    # The tenant this channel config belongs to. NULL = the PLATFORM-DEFAULT config
    # a tenant falls back to when it has not configured its own channel.
    tenant_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("tenants.id", ondelete="SET NULL"), nullable=True, index=True,
    )
    # Free-form per-channel settings. Secret fields are stored ENCRYPTED here.
    config: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )


# --- service functions -------------------------------------------------------
# Multi-tenancy: channel configs are per-tenant with a platform-default (tenant_id
# NULL) fall-back. ``get_channel`` resolves the caller's tenant row first, else the
# platform-default row. Writes target the caller's OWN scope.
def _scoped_stmt(channel: str, tenant_id: uuid.UUID | None):
    stmt = select(ChannelConfig).where(ChannelConfig.channel == channel)
    if tenant_id is None:
        return stmt.where(ChannelConfig.tenant_id.is_(None))
    return stmt.where(ChannelConfig.tenant_id == tenant_id)


async def _row_exact(
    db: AsyncSession, channel: str, tenant_id: uuid.UUID | None
) -> ChannelConfig | None:
    """The row for EXACTLY (channel, tenant_id) — no fallback."""
    return (await db.execute(_scoped_stmt(channel, tenant_id))).scalar_one_or_none()


async def get_channel(
    db: AsyncSession, channel: str, tenant_id: uuid.UUID | None = None
) -> ChannelConfig | None:
    """Resolve the effective config row for ``channel``: the caller's tenant row if
    any, else the platform-default (tenant_id NULL) row. None if neither exists."""
    if tenant_id is not None:
        row = await _row_exact(db, channel, tenant_id)
        if row is not None:
            return row
    return await _row_exact(db, channel, None)


async def upsert_channel(
    db: AsyncSession, channel: str, enabled: bool, config: dict,
    tenant_id: uuid.UUID | None = None,
) -> ChannelConfig:
    """Create or update a channel's config in the caller's scope, encrypting secrets.

    ``config`` comes from the admin UI with secrets in PLAINTEXT; we encrypt the
    declared ``SECRET_FIELDS`` for that channel before persisting.
    """
    # Copy so we never mutate the caller's dict, and encrypt the secret fields.
    stored = dict(config)
    for field in SECRET_FIELDS.get(channel, []):
        if stored.get(field):  # only encrypt non-empty values
            stored[field] = encrypt_secret(str(stored[field]))

    row = await _row_exact(db, channel, tenant_id)
    if row is None:
        row = ChannelConfig(
            channel=channel, enabled=enabled, config=stored, tenant_id=tenant_id
        )
        db.add(row)
    else:
        row.enabled = enabled
        row.config = stored
    await db.commit()
    await db.refresh(row)
    return row


async def get_config_decrypted(
    db: AsyncSession, channel: str, tenant_id: uuid.UUID | None = None
) -> dict | None:
    """Return the channel's config (resolved with tenant fallback) with secret fields
    DECRYPTED — for senders. None if the channel has never been configured."""
    row = await get_channel(db, channel, tenant_id)
    if row is None:
        return None
    decrypted = dict(row.config or {})
    for field in SECRET_FIELDS.get(channel, []):
        if decrypted.get(field):
            decrypted[field] = decrypt_secret(str(decrypted[field]))
    return decrypted


def masked(config: dict, channel: str) -> dict:
    """Return a copy of ``config`` with secret fields replaced by ``"***"``.

    Used for GET responses so a stored secret is never sent back to the client.
    """
    safe = dict(config or {})
    for field in SECRET_FIELDS.get(channel, []):
        if field in safe and safe.get(field):
            safe[field] = "***"
    return safe
