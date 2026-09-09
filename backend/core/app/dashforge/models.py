"""DashForge embed registrations ORM — one row per dashboard NeuBit will show.

One table, tenant-scoped like the rest of core: a nullable ``tenant_id`` (NULL =
a platform row), read through ``app.tenancy.scope`` / ``assert_owned``.

``tenant_id`` is a real FK with ON DELETE CASCADE, which is what erases these rows
on tenant offboard (DPDP right-to-erase). Do not copy ``sites``/``tags``, which
still carry a bare ``tenant_id`` and are a known gap.

The DashForge ids are stored as strings, not ints, so this table does not encode a
foreign product's key type — a move to uuids or slugs there needs no migration
here. The workspace ref is recorded at registration because minting is
workspace-scoped (``X-Workspace-ID``) and the service account may belong to more
than one; deriving it would mean guessing.

``scope`` is the set of filter bindings locked into the embed token's signature
(DashForge ``internal/embed/scope.go``) — what stops one token rendering another
tenant's rows. NeuBit cannot compute it: the lockable names are the DashForge
dashboard's own global-filter variables. It is recorded by whoever registers the
dashboard and passed through verbatim at mint; DashForge refuses an unlockable
name there, naming it.

Not stored here: any embed token (a per-session bearer credential — see
``client.py``), and no dashboard definition (layout, widgets and queries live in
DashForge, and a copy would drift).
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    JSON,
    DateTime,
    ForeignKey,
    Index,
    String,
    Uuid,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from ..db.base import Base


def _uuid_str() -> str:
    return str(uuid.uuid4())


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class DashForgeEmbed(Base):
    """One registered DashForge dashboard: where it is, what to call it, and what
    the embed needs."""

    __tablename__ = "dashforge_embeds"
    __table_args__ = (
        # Registering the same dashboard twice in one tenant gives two names for
        # one thing. Unique within a tenant only — two tenants embedding the same
        # shared dashboard is normal and must not collide.
        Index(
            "uq_dashforge_embeds_tenant_ref",
            "tenant_id",
            "workspace_ref",
            "dashboard_ref",
            unique=True,
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid_str)
    tenant_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("tenants.id", ondelete="CASCADE"), nullable=True, index=True
    )

    # What operators call it here. Not read from DashForge on purpose, so a rename
    # on either side never silently changes the other's navigation.
    name: Mapped[str] = mapped_column(String(160), nullable=False)
    description: Mapped[str | None] = mapped_column(String(1024))

    # DashForge's own identifiers. See the module docstring for the string choice.
    workspace_ref: Mapped[str] = mapped_column(String(64), nullable=False)
    dashboard_ref: Mapped[str] = mapped_column(String(64), nullable=False)

    # Which console shows it — see ``categories.py`` for why the set is closed.
    # Stored as a slug rather than a FK: the set is code, not operator data, and a
    # table would invite a sixth category no console has a tab for.
    category: Mapped[str] = mapped_column(
        String(32), nullable=False, default="general",
        server_default=text("'general'"), index=True,
    )

    # Locked filter bindings baked into the token signature at mint. See above.
    scope: Mapped[dict] = mapped_column(
        JSON, nullable=False, default=dict, server_default=text("'{}'")
    )

    # Who registered it. Informational only — authorisation is the permission plus
    # the tenant, never ownership. No FK on purpose: a cascade would delete a
    # working dashboard when its author leaves.
    created_by: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow, onupdate=_utcnow
    )
