"""Dashboard + widget persistence. Tenant-scoped, and the only place that writes.

Every read goes through ``kernel.auth.scoped`` and every by-id lookup through
``assert_owned``, so tenant isolation is expressed once per operation rather than
re-derived in each handler. ``assert_owned`` raises NOT FOUND rather than
FORBIDDEN on purpose: a caller must not be able to discover that an id exists in
somebody else's tenant by the shape of the refusal.

Nothing in this file interprets a widget spec. It stores what it is given, after
the envelope check in ``schemas``. See ``models`` for why that is the design and
not laziness.
"""

from __future__ import annotations

import re
import uuid

from kernel.auth import Scope, assert_owned, scoped
from kernel.errors import ConflictError, ValidationError
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .models import Dashboard, DashboardWidget
from .schemas import MAX_WIDGETS

_SLUG_RE = re.compile(r"[^a-z0-9]+")


def slugify(name: str) -> str:
    s = _SLUG_RE.sub("-", (name or "").strip().lower()).strip("-")
    return s[:150] or "dashboard"


class DashboardService:
    def __init__(self, db: AsyncSession, scope: Scope) -> None:
        self.db = db
        self.scope = scope

    # The tenant stamped on rows this caller creates. A super-admin has no tenant
    # claim and writes a NULL-tenant (platform) row, which is the same semantics
    # every other satellite gives them.
    @property
    def _owner(self) -> uuid.UUID | None:
        return None if self.scope.is_platform else self.scope.tenant_id

    # ── dashboards ───────────────────────────────────────────────────────────

    async def list_(self, *, search: str | None = None) -> tuple[list[dict], int]:
        """Dashboards with their widget COUNT, in one query.

        The count is a correlated scalar subquery rather than loading the widgets:
        a list of twenty dashboards must not become twenty widget fetches, and the
        list view never renders a widget anyway.
        """
        widget_count = (
            select(func.count(DashboardWidget.id))
            .where(DashboardWidget.dashboard_id == Dashboard.id)
            .correlate(Dashboard)
            .scalar_subquery()
        )
        stmt = scoped(
            select(Dashboard, widget_count.label("widget_count")), Dashboard, self.scope
        ).order_by(Dashboard.name)
        if search:
            stmt = stmt.where(Dashboard.name.ilike(f"%{search.strip()}%"))
        rows = (await self.db.execute(stmt)).all()
        items = [
            {
                "id": d.id,
                "name": d.name,
                "slug": d.slug,
                "description": d.description,
                "grid_cols": d.grid_cols,
                "row_height": d.row_height,
                "widget_count": int(count or 0),
                "created_at": d.created_at,
                "updated_at": d.updated_at,
            }
            for d, count in rows
        ]
        return items, len(items)

    async def get(self, dashboard_id: str) -> Dashboard:
        """One dashboard WITH its widgets (the relationship is selectin-loaded)."""
        row = await self.db.get(Dashboard, dashboard_id)
        assert_owned(row, self.scope, message="dashboard not found")
        return row

    async def _unique_slug(self, base: str, *, exclude_id: str | None = None) -> str:
        """A slug free within THIS tenant, suffixing -2, -3, … as needed.

        Racy in principle — two simultaneous creates could both pick `energy-2` —
        and that is why the unique index in `models` exists. This makes the common
        case pleasant; the index makes the rare case correct, surfacing as a 409
        rather than a duplicate.
        """
        candidate = base
        n = 1
        while True:
            stmt = scoped(select(Dashboard.id).where(Dashboard.slug == candidate), Dashboard, self.scope)
            if exclude_id:
                stmt = stmt.where(Dashboard.id != exclude_id)
            if (await self.db.execute(stmt)).first() is None:
                return candidate
            n += 1
            candidate = f"{base[:140]}-{n}"

    async def create(self, data, *, created_by: uuid.UUID | None) -> Dashboard:
        slug = await self._unique_slug(slugify(data.slug or data.name))
        row = Dashboard(
            tenant_id=self._owner,
            name=data.name.strip(),
            slug=slug,
            description=(data.description or None),
            grid_cols=data.grid_cols,
            row_height=data.row_height,
            config=data.config or {},
            created_by=created_by,
        )
        self.db.add(row)
        try:
            await self.db.commit()
        except Exception as exc:  # noqa: BLE001 — the unique index firing
            await self.db.rollback()
            raise ConflictError("a dashboard with that name already exists") from exc
        await self.db.refresh(row)
        return row

    async def update(self, dashboard_id: str, data) -> Dashboard:
        row = await self.get(dashboard_id)
        if data.name is not None:
            row.name = data.name.strip()
        if data.description is not None:
            row.description = data.description or None
        if data.grid_cols is not None:
            row.grid_cols = data.grid_cols
        if data.row_height is not None:
            row.row_height = data.row_height
        if data.config is not None:
            row.config = data.config
        await self.db.commit()
        await self.db.refresh(row)
        return row

    async def delete(self, dashboard_id: str) -> None:
        row = await self.get(dashboard_id)
        # The widgets go with it: cascade="all, delete-orphan" on the relationship
        # plus ON DELETE CASCADE on the FK, so neither the ORM path nor a direct
        # SQL delete can leave orphans behind.
        await self.db.delete(row)
        await self.db.commit()

    # ── widgets ──────────────────────────────────────────────────────────────

    async def _widget(self, dashboard_id: str, widget_id: str) -> DashboardWidget:
        dashboard = await self.get(dashboard_id)  # tenant check #1
        row = await self.db.get(DashboardWidget, widget_id)
        assert_owned(row, self.scope, message="widget not found")  # tenant check #2
        if row.dashboard_id != dashboard.id:
            # A widget id that exists but hangs off another dashboard is NOT FOUND
            # on this one, for the same reason cross-tenant ids are.
            from kernel.errors import NotFoundError

            raise NotFoundError("widget not found")
        return row

    async def add_widget(self, dashboard_id: str, data) -> DashboardWidget:
        dashboard = await self.get(dashboard_id)
        if len(dashboard.widgets) >= MAX_WIDGETS:
            raise ValidationError(
                f"a dashboard holds at most {MAX_WIDGETS} widgets; "
                "split it into two rather than making one page fetch fifty queries"
            )
        if data.x + data.w > dashboard.grid_cols:
            raise ValidationError(
                f"widget does not fit: x+w is {data.x + data.w}, "
                f"the canvas is {dashboard.grid_cols} columns wide"
            )
        row = DashboardWidget(
            tenant_id=dashboard.tenant_id,
            dashboard_id=dashboard.id,
            title=(data.title or "").strip(),
            spec=data.spec,
            x=data.x,
            y=data.y,
            w=data.w,
            h=data.h,
        )
        self.db.add(row)
        await self.db.commit()
        await self.db.refresh(row)
        return row

    async def update_widget(self, dashboard_id: str, widget_id: str, data) -> DashboardWidget:
        row = await self._widget(dashboard_id, widget_id)
        if data.title is not None:
            row.title = data.title.strip()
        if data.spec is not None:
            row.spec = data.spec
        for field in ("x", "y", "w", "h"):
            value = getattr(data, field)
            if value is not None:
                setattr(row, field, value)
        await self.db.commit()
        await self.db.refresh(row)
        return row

    async def delete_widget(self, dashboard_id: str, widget_id: str) -> None:
        row = await self._widget(dashboard_id, widget_id)
        await self.db.delete(row)
        await self.db.commit()

    async def save_layout(self, dashboard_id: str, items) -> Dashboard:
        """Persist the whole canvas geometry in ONE transaction.

        A drag reflows every widget below the one being moved, so a layout save is
        inherently a multi-row write. Doing it as one commit is what makes "move
        it, reload, it is still there" true even if the browser dies mid-request:
        either the arrangement is saved or none of it is.

        Ids the dashboard does not own are IGNORED rather than rejected. A stale
        tab holding a widget somebody else has since deleted should not be unable
        to save the rest of its layout.
        """
        dashboard = await self.get(dashboard_id)
        by_id = {w.id: w for w in dashboard.widgets}
        for item in items:
            widget = by_id.get(item.id)
            if widget is None:
                continue
            if item.x + item.w > dashboard.grid_cols:
                raise ValidationError(
                    f"widget {item.id} does not fit: x+w is {item.x + item.w}, "
                    f"the canvas is {dashboard.grid_cols} columns wide"
                )
            widget.x, widget.y, widget.w, widget.h = item.x, item.y, item.w, item.h
        await self.db.commit()
        await self.db.refresh(dashboard)
        return dashboard
