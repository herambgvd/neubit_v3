"""Dashboards ORM — a dashboard, and the widgets placed on it.

Two tables, tenant-scoped the way every other satellite is: a nullable
``tenant_id`` (NULL = a platform/super-admin row), read through
``kernel.auth.scoped`` / ``assert_owned`` so isolation lives in one place rather
than in every handler.

**Why `tenant_id` is on the WIDGET too, not just the dashboard.** It is
denormalised on purpose and it earns its keep twice:

* ``kernel.lifecycle.erase_tenant_data`` implements DPDP right-to-erase
  generically — it deletes from every table that HAS a ``tenant_id`` column, in
  reverse dependency order, with no per-service model list. A widget table
  without the column would be skipped, and an offboarded tenant's widgets would
  survive the erase of their own dashboards. (The FK cascade would in fact take
  them, but relying on that means the erase is correct by accident.)
* It is a second lock on the widget-by-id routes: a widget is reachable only when
  BOTH its dashboard and its own row belong to the caller.

**Why the spec is opaque here.** ``DashboardWidget.spec`` is JSON and this service
validates only its ENVELOPE (see ``schemas.WidgetSpecEnvelope``). It deliberately
does not understand what a spec means — that belongs to the reading-writer, which
owns the readings schema and is the only thing that executes a spec (contract §7).
Two consequences, both wanted:

* the query language can gain a widget type, a metric or a scope kind without a
  migration or a redeploy HERE, so old dashboards keep loading;
* there is exactly one implementation of what a spec means, so the store and the
  executor cannot drift into disagreeing about a saved dashboard.

Geometry (``x``/``y``/``w``/``h``) is stored in GRID CELLS, not pixels — the same
units the canvas works in — so a dashboard laid out on a 27-inch monitor opens
identically on a laptop.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    JSON,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    UniqueConstraint,
    Uuid,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base


def _uuid_str() -> str:
    return str(uuid.uuid4())


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Dashboard(Base):
    """One canvas: a name, a grid, and the widgets on it."""

    __tablename__ = "dashboards"
    __table_args__ = (
        # A slug is the human-readable handle in a URL, so it must be unique
        # WITHIN a tenant — and only within one. Two tenants naming a dashboard
        # "energy" is normal and must not collide.
        Index("uq_dashboards_tenant_slug", "tenant_id", "slug", unique=True),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid_str)
    tenant_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True, index=True)

    name: Mapped[str] = mapped_column(String(160), nullable=False)
    slug: Mapped[str] = mapped_column(String(160), nullable=False)
    description: Mapped[str | None] = mapped_column(String(1024))

    # The canvas geometry, stored so a dashboard reopens the shape it was built
    # in. Columns are the unit x/w are expressed in; row height is the unit y/h
    # are expressed in.
    grid_cols: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("12"))
    row_height: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("56"))

    # The page-level builder state: its global filters, its variables, and the
    # window they share. OPAQUE here, exactly as ``DashboardWidget.spec`` is
    # opaque, and for the same reason — a filter names a dataset dimension, and
    # the dataset registry lives in the reading-writer. This service would have
    # to open ``neubit_reporting`` to have an opinion about it, which is the
    # cross-service read the platform bans.
    #
    # What it therefore stores is DEFINITIONS, never values-in-flight: which
    # filters this dashboard offers, what each is bound to, and what it defaults
    # to. The chosen value of a filter right now is session state and lives in the
    # URL, so a filtered view is a shareable link rather than a thing one person
    # saved onto everyone else's page.
    config: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict, server_default=text("'{}'"))

    # Who made it. Informational — authorisation is the permission + the tenant,
    # never ownership, because a dashboard is a team artefact.
    created_by: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow, onupdate=_utcnow
    )

    widgets: Mapped[list["DashboardWidget"]] = relationship(
        back_populates="dashboard",
        cascade="all, delete-orphan",
        order_by="DashboardWidget.y, DashboardWidget.x",
        lazy="selectin",
    )


class DashboardWidget(Base):
    """One widget: a title, a place on the grid, and an opaque query spec."""

    __tablename__ = "dashboard_widgets"
    __table_args__ = (Index("ix_dashboard_widgets_dashboard", "dashboard_id"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid_str)
    # Denormalised deliberately — see the module docstring.
    tenant_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True, index=True)

    dashboard_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("dashboards.id", ondelete="CASCADE"), nullable=False
    )

    title: Mapped[str] = mapped_column(String(160), nullable=False, server_default=text("''"))

    # The widget query spec. Opaque here; executed by the reading-writer.
    spec: Mapped[dict] = mapped_column(JSON, nullable=False)

    # Grid cells, not pixels.
    x: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("0"))
    y: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("0"))
    w: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("4"))
    h: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("4"))

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow, onupdate=_utcnow
    )

    dashboard: Mapped[Dashboard] = relationship(back_populates="widgets")


class DashboardVersion(Base):
    """One SNAPSHOT of a whole dashboard, taken after every change that saved.

    A saved dashboard is work somebody did. The failure this table prevents is
    the ordinary one: an edit that seemed right, a reload, and the previous
    arrangement gone with no way back. It is not an audit log — it exists to be
    RESTORED from.

    **The snapshot is the whole dashboard, not a delta.** Deltas need every
    intermediate version to be intact to reconstruct one, so a pruned or corrupt
    row poisons everything after it; a snapshot is independently restorable and a
    dashboard is a few kilobytes of JSON. The diff is computed BETWEEN two
    snapshots when somebody asks for it (client-side, `version-diff.ts`), which
    keeps this table free of any opinion about what a change means.

    `version` is a per-dashboard counter, not a global one, so "version 3" is a
    thing a person can say out loud. The unique constraint is what makes two
    concurrent writes fail loudly rather than both claiming the same number.

    ``tenant_id`` is here for the same two reasons it is on the widget: generic
    right-to-erase (``kernel.lifecycle.erase_tenant_data`` walks tables that HAVE
    the column), and a second lock on every by-id route.
    """

    __tablename__ = "dashboard_versions"
    __table_args__ = (
        UniqueConstraint("dashboard_id", "version", name="uq_dashboard_versions_number"),
        Index("ix_dashboard_versions_dashboard", "dashboard_id", "version"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid_str)
    tenant_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True, index=True)

    dashboard_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("dashboards.id", ondelete="CASCADE"), nullable=False
    )
    version: Mapped[int] = mapped_column(Integer, nullable=False)

    # What changed, in a few words, written by the service that made the change
    # ("widget added", "layout saved"). Not free text from the client: a label
    # nobody can trust is worse than a timestamp on its own.
    label: Mapped[str] = mapped_column(String(120), nullable=False, server_default=text("''"))

    # The whole dashboard at that moment: name, description, geometry, config and
    # every widget. Opaque, like `DashboardWidget.spec` and for the same reason.
    snapshot: Mapped[dict] = mapped_column(JSON, nullable=False)

    created_by: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow, index=True
    )
