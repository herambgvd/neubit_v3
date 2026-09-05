"""DashForge embed registrations ORM — one row per dashboard NeuBit will show.

One table, tenant-scoped the way the rest of core is: a nullable ``tenant_id``
(NULL = a platform/super-admin row), read through ``app.tenancy.scope`` /
``assert_owned`` so isolation lives in one place rather than in every handler.

**Why the tenant_id is a real FOREIGN KEY here and was a bare column before.**
As a satellite this table lived in ``neubit_dashforge`` and ``tenants`` lived in
core's database, so no FK could span them; the erase on tenant offboard was done
instead by a NATS subscription (``kernel.lifecycle.subscribe_tenant_offboard``),
which walked every table carrying a ``tenant_id``. That subscription does not
survive the fold-in — core PUBLISHES the offboard event, it does not consume its
own — and dropping it without a replacement would have left this table holding a
deleted tenant's rows, which is the DPDP right-to-erase failing quietly. The two
tables are now in one database, so ``ON DELETE CASCADE`` does the same job with
no bus, no durable consumer and no way for it to be down when it is needed.
(``sites`` and ``tags`` still carry a bare ``tenant_id`` and are NOT erased this
way. That is a real gap and a pre-existing one; it is not this change's to fix,
but do not read their column as the convention to copy.)

**Why the reference is a string, not an integer.** DashForge's dashboard id is
today a ``uint`` and its workspace id likewise. Storing them as strings costs
nothing and stops this table from encoding a foreign product's key type — if
DashForge ever moves to a uuid or a slug, this column keeps working and no
migration of somebody else's identifier lands in NeuBit's release notes.

**Why the workspace reference is stored at all.** Minting is workspace-scoped on
the DashForge side (``X-Workspace-ID``), and a service account may be a member of
more than one. Deriving it would mean listing workspaces and guessing; recording
it at registration time makes the mint call unambiguous, and a wrong value fails
loudly at registration rather than silently later.

**Why ``scope`` lives here and is not computed.** It is the set of filter
bindings locked into the embed token's signature (DashForge
``internal/embed/scope.go``) — the thing that stops one token from rendering
another tenant's rows. NeuBit cannot invent it: the lockable names are the
DashForge dashboard's own global-filter control variables, which this platform
has no view of. So it is recorded by whoever registers the dashboard (they hold
``dashforge.manage``), stored verbatim, and passed through at mint. An
unlockable name is refused by DashForge at mint with a message naming it, which
is the right place for that check because it is the only side that knows.

Deliberately NOT here: any embed token. A token is a bearer credential minted per
viewing session (see ``client.py``); storing one would turn this table into a
credential store whose rows outlive the session that needed them. Nor any
dashboard definition — layout, widgets and queries live in DashForge, and a
second copy here would be free to drift from the real one, with the first symptom
a page that renders one thing and is described here as another.
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
        # Registering the same DashForge dashboard twice within a tenant is a
        # mistake, not a use case: it produces two names for one thing and a
        # viewer with no way to tell which is current. Unique WITHIN a tenant and
        # only within one — two tenants embedding the same shared dashboard is
        # normal and must not collide.
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

    # What operators call it HERE. Deliberately not read from DashForge: the name
    # a dashboard carries in its authoring tool is chosen by whoever built it,
    # and the name on a NeuBit console is a NeuBit decision. Keeping them
    # separate also means a rename on either side never silently changes the
    # other's navigation.
    name: Mapped[str] = mapped_column(String(160), nullable=False)
    description: Mapped[str | None] = mapped_column(String(1024))

    # DashForge's own identifiers. See the module docstring for the string choice.
    workspace_ref: Mapped[str] = mapped_column(String(64), nullable=False)
    dashboard_ref: Mapped[str] = mapped_column(String(64), nullable=False)

    # Locked filter bindings baked into the token signature at mint. See above.
    scope: Mapped[dict] = mapped_column(
        JSON, nullable=False, default=dict, server_default=text("'{}'")
    )

    # Who registered it. Informational — authorisation is the permission plus the
    # tenant, never ownership, because an embedded dashboard is a team artefact.
    # No FK: the registration outliving the operator who made it is correct, and
    # the alternative (cascade) would delete a working dashboard when its author
    # leaves.
    created_by: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow, onupdate=_utcnow
    )
