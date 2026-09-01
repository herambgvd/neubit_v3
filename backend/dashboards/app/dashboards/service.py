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

import logging
import re
import uuid

from kernel.auth import Scope, assert_owned, scoped
from kernel.errors import ConflictError, ValidationError
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .models import Dashboard, DashboardVersion, DashboardWidget
from .schemas import MAX_VERSIONS, MAX_WIDGETS

_SLUG_RE = re.compile(r"[^a-z0-9]+")


def slugify(name: str) -> str:
    s = _SLUG_RE.sub("-", (name or "").strip().lower()).strip("-")
    return s[:150] or "dashboard"


log = logging.getLogger(__name__)


class DashboardService:
    def __init__(self, db: AsyncSession, scope: Scope, actor: uuid.UUID | None = None) -> None:
        self.db = db
        self.scope = scope
        # WHO is making the change, for the version history's attribution. It is
        # informational only — authorisation is the permission plus the tenant,
        # never ownership, because a dashboard is a team artefact.
        self.actor = actor

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
        await self._record_version(row, "created")
        await self.db.commit()
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
        changed_config = data.config is not None
        if changed_config:
            row.config = data.config
        await self._record_version(row, "filters saved" if changed_config else "settings changed")
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

    # ── version history ──────────────────────────────────────────────────────
    #
    # A snapshot is taken AFTER every change that saved, so version N is "what the
    # dashboard looked like once change N had landed" — which is the thing a
    # person means when they say "put it back to how it was this morning".
    #
    # Two decisions worth stating:
    #
    # * **The snapshot is the whole dashboard, not a delta.** Restoring from a
    #   delta chain means every link has to survive; a snapshot restores on its
    #   own. A dashboard is a few kilobytes of JSON and this is not a hot path.
    # * **Restoring WRITES a new version first.** The state you are about to
    #   discard is itself somebody's work, and an undo that cannot be undone is
    #   how you lose an afternoon twice.

    @staticmethod
    def _snapshot(dashboard: Dashboard) -> dict:
        return {
            "name": dashboard.name,
            "description": dashboard.description,
            "grid_cols": dashboard.grid_cols,
            "row_height": dashboard.row_height,
            "config": dashboard.config or {},
            "widgets": [
                {
                    "id": w.id,
                    "title": w.title,
                    "spec": w.spec,
                    "x": w.x,
                    "y": w.y,
                    "w": w.w,
                    "h": w.h,
                }
                for w in sorted(dashboard.widgets, key=lambda w: (w.y, w.x, w.id))
            ],
        }

    async def _record_version(self, dashboard: Dashboard, label: str) -> None:
        """Snapshot the dashboard as it stands. Called INSIDE the caller's
        transaction, before its commit, so a change and its history entry land
        together or not at all — a version that records a change that was rolled
        back is worse than no version.

        Best effort in one respect only: it never raises past the caller. A
        history write failing must not fail the edit somebody just made.
        """
        try:
            await self.db.refresh(dashboard)
            latest = (
                await self.db.execute(
                    select(func.max(DashboardVersion.version)).where(
                        DashboardVersion.dashboard_id == dashboard.id
                    )
                )
            ).scalar()
            self.db.add(
                DashboardVersion(
                    tenant_id=dashboard.tenant_id,
                    dashboard_id=dashboard.id,
                    version=int(latest or 0) + 1,
                    label=label[:120],
                    snapshot=self._snapshot(dashboard),
                    created_by=self.actor,
                )
            )
            await self._prune_versions(dashboard.id)
        except Exception:  # noqa: BLE001 — history must not break editing
            # LOGGED, not swallowed silently. A history that quietly stopped
            # recording is indistinguishable from a dashboard nobody edited, and
            # the first time anyone finds out is when they need to restore.
            log.warning("could not record a version for dashboard %s", dashboard.id, exc_info=True)
            return

    async def _prune_versions(self, dashboard_id: str) -> None:
        """Keep the newest `MAX_VERSIONS`. Unbounded history on a dashboard
        somebody drags around all afternoon is a table that grows without limit
        for a feature nobody scrolls that far back in."""
        rows = (
            await self.db.execute(
                select(DashboardVersion.id)
                .where(DashboardVersion.dashboard_id == dashboard_id)
                .order_by(DashboardVersion.version.desc())
                .offset(MAX_VERSIONS - 1)
            )
        ).scalars().all()
        if rows:
            await self.db.execute(delete(DashboardVersion).where(DashboardVersion.id.in_(rows)))

    async def versions(self, dashboard_id: str) -> list[DashboardVersion]:
        dashboard = await self.get(dashboard_id)  # tenant check
        return list(
            (
                await self.db.execute(
                    select(DashboardVersion)
                    .where(DashboardVersion.dashboard_id == dashboard.id)
                    .order_by(DashboardVersion.version.desc())
                )
            ).scalars()
        )

    async def version(self, dashboard_id: str, number: int) -> DashboardVersion:
        from kernel.errors import NotFoundError

        dashboard = await self.get(dashboard_id)
        row = (
            await self.db.execute(
                select(DashboardVersion).where(
                    DashboardVersion.dashboard_id == dashboard.id,
                    DashboardVersion.version == number,
                )
            )
        ).scalar_one_or_none()
        if row is None:
            raise NotFoundError(f"this dashboard has no version {number}")
        assert_owned(row, self.scope, message="version not found")
        return row

    async def current_snapshot(self, dashboard_id: str) -> dict:
        """What the dashboard looks like RIGHT NOW, in snapshot shape — so the
        diff view can compare a stored version against the live dashboard without
        the browser having to reassemble it from two different response shapes."""
        return self._snapshot(await self.get(dashboard_id))

    async def restore(self, dashboard_id: str, number: int) -> Dashboard:
        """Put a dashboard back to a stored version.

        The state being discarded is snapshotted FIRST, as its own version, so a
        restore is undoable. Widgets are matched by id: one that exists in both is
        updated in place (keeping its id, so anything that references it still
        does), one only in the snapshot is recreated with its original id, and one
        only in the present is removed.
        """
        dashboard = await self.get(dashboard_id)
        target = await self.version(dashboard_id, number)
        await self._record_version(dashboard, f"before restoring version {number}")

        snap = target.snapshot or {}
        dashboard.name = snap.get("name") or dashboard.name
        dashboard.description = snap.get("description")
        dashboard.grid_cols = int(snap.get("grid_cols") or dashboard.grid_cols)
        dashboard.row_height = int(snap.get("row_height") or dashboard.row_height)
        dashboard.config = snap.get("config") or {}

        wanted = {w["id"]: w for w in (snap.get("widgets") or []) if isinstance(w, dict) and w.get("id")}
        present = {w.id: w for w in dashboard.widgets}

        for wid, w in present.items():
            if wid not in wanted:
                await self.db.delete(w)
        for wid, data in wanted.items():
            row = present.get(wid)
            if row is None:
                # Recreated with its ORIGINAL id. A restore that renumbers every
                # widget would make a second restore of the same version produce
                # a different dashboard.
                row = DashboardWidget(id=wid, tenant_id=dashboard.tenant_id, dashboard_id=dashboard.id)
                self.db.add(row)
            row.title = str(data.get("title") or "")[:160]
            row.spec = data.get("spec") or row.spec
            row.x, row.y = int(data.get("x") or 0), int(data.get("y") or 0)
            row.w, row.h = int(data.get("w") or 4), int(data.get("h") or 4)

        await self.db.commit()
        await self.db.refresh(dashboard)
        # The restored state gets its own version too, so the history reads as a
        # sequence of states rather than skipping the one that is now live.
        await self._record_version(dashboard, f"restored version {number}")
        await self.db.commit()
        await self.db.refresh(dashboard)
        return dashboard

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
        await self.db.refresh(dashboard)
        await self._record_version(dashboard, f"added “{row.title or 'untitled'}”")
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
        dashboard = await self.get(dashboard_id)
        await self._record_version(dashboard, f"edited “{row.title or 'untitled'}”")
        await self.db.commit()
        await self.db.refresh(row)
        return row

    async def delete_widget(self, dashboard_id: str, widget_id: str) -> None:
        row = await self._widget(dashboard_id, widget_id)
        title = row.title or "untitled"
        await self.db.delete(row)
        await self.db.commit()
        dashboard = await self.get(dashboard_id)
        await self._record_version(dashboard, f"removed “{title}”")
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
        await self._record_version(dashboard, "layout saved")
        await self.db.commit()
        await self.db.refresh(dashboard)
        return dashboard
