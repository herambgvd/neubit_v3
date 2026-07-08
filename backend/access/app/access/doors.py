"""Local door catalog CRUD + door commands — ported from neubit_v2 gates.

v3 port of ``neubit_v2/backend/gates/app/module/door/routes.py`` (+ ``door/models``
/ ``door/repository``). Doors are LOCAL rows (``access_doors``), tenant-scoped; a
door's ``remote_ref`` points at the controller-side door/reader UID (v2's
``controller_door_id``). CRUD is fully local (testable without a live controller).
Door commands (unlock / lock) push to the controller via the brand connector's
OData actions (v2 used ``dds_adapter.unlock_door``/``lock_door``); on an
unreachable controller they surface a CLEAN error, never a 500.

Tenant-scoping: list/get/create/update/delete all go through ``scoped`` /
``assert_owned`` so a door in another tenant is invisible (reads as 404).
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from kernel.auth import Scope, assert_owned, scoped
from kernel.errors import ConflictError

from ..connectors.dds import DDSHTTPError
from ..connectors.factory import get_connector
from .crypto import decrypt_secret
from .models import Door, Instance


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _actor_id(actor) -> str | None:
    if actor is None:
        return None
    return str(getattr(actor, "user_id", "")) or None


class DoorCommandError(Exception):
    """Signals a door command failure to the router (carries a status)."""

    def __init__(self, status_code: int, detail: Any) -> None:
        self.status_code = status_code
        self.detail = detail
        super().__init__(str(detail)[:200])


class DoorService:
    """Tenant-scoped local door CRUD + connector-driven door commands."""

    def __init__(self, db: AsyncSession, scope: Scope) -> None:
        self.db = db
        self.scope = scope

    async def _door(self, door_id: str) -> Door:
        row = await self.db.get(Door, door_id)
        assert_owned(row, self.scope, message="Door not found")
        return row

    async def _instance(self, instance_id: str) -> Instance:
        row = await self.db.get(Instance, instance_id)
        assert_owned(row, self.scope, message="Instance not found")
        return row

    # ── CRUD ────────────────────────────────────────────────────────────
    async def create(self, payload: dict, *, actor) -> Door:
        # Validate the target instance is owned (ties the door to a real controller).
        await self._instance(payload["instance_id"])
        actor_id = _actor_id(actor)
        row = Door(
            tenant_id=self.scope.tenant_id,
            instance_id=payload["instance_id"],
            name=payload["name"],
            remote_ref=payload.get("remote_ref"),
            site_id=payload.get("site_id"),
            floor_id=payload.get("floor_id"),
            zone_id=payload.get("zone_id"),
            is_active=payload.get("is_active", True),
            metadata_json=payload.get("metadata") or {},
            created_by=actor_id,
            updated_by=actor_id,
        )
        self.db.add(row)
        await self.db.commit()
        await self.db.refresh(row)
        return row

    async def list_(
        self,
        *,
        instance_id: str | None = None,
        site_id: str | None = None,
        skip: int = 0,
        limit: int = 100,
    ) -> tuple[list[Door], int]:
        stmt = scoped(select(Door), Door, self.scope)
        count_stmt = scoped(select(func.count()).select_from(Door), Door, self.scope)
        if instance_id:
            stmt = stmt.where(Door.instance_id == instance_id)
            count_stmt = count_stmt.where(Door.instance_id == instance_id)
        if site_id:
            stmt = stmt.where(Door.site_id == site_id)
            count_stmt = count_stmt.where(Door.site_id == site_id)
        stmt = stmt.order_by(Door.created_at.desc()).offset(skip).limit(limit)
        rows = (await self.db.execute(stmt)).scalars().all()
        total = int(await self.db.scalar(count_stmt) or 0)
        return list(rows), total

    async def get(self, door_id: str) -> Door:
        return await self._door(door_id)

    async def update(self, door_id: str, payload: dict, *, actor) -> Door:
        row = await self._door(door_id)
        for k in ("name", "remote_ref", "site_id", "floor_id", "zone_id", "is_active"):
            if k in payload and payload[k] is not None:
                setattr(row, k, payload[k])
        if payload.get("metadata") is not None:
            row.metadata_json = payload["metadata"]
        actor_id = _actor_id(actor)
        if actor_id:
            row.updated_by = actor_id
        row.updated_at = _utcnow()
        await self.db.commit()
        await self.db.refresh(row)
        return row

    async def delete(self, door_id: str) -> None:
        row = await self._door(door_id)
        await self.db.delete(row)
        await self.db.commit()

    # ── Commands (unlock / lock via the controller) ─────────────────────
    async def command(self, door_id: str, action: str) -> dict:
        """Unlock/lock a door through the controller (v2 door _door_action).

        DDS has no generic per-door unlock action in the OData surface; v2 mapped
        this to an Outputs Activate/ReturnToNormal on the door's relay UID. We use
        the same output actions keyed by the door's ``remote_ref``. Graceful on an
        unreachable controller: raises DoorCommandError (→ clean HTTP error)."""
        door = await self._door(door_id)
        if not door.remote_ref:
            raise DoorCommandError(
                409, {"code": "door_not_mapped", "message": "door has no remote_ref"}
            )
        inst = await self.db.get(Instance, door.instance_id)
        assert_owned(inst, self.scope, message="Instance not found")

        # unlock → activate the relay (pulse); lock → return the relay to normal.
        action_key = (
            "output.activate" if action == "unlock" else "output.return_to_normal"
        )
        params = {"uids": [door.remote_ref]}
        connector = get_connector(inst, secret=decrypt_secret(inst.secret_enc))
        try:
            result = await connector.invoke_action(action_key, params)
        except DDSHTTPError as exc:
            raise DoorCommandError(exc.status_code, exc.body_text) from None
        except Exception as exc:  # noqa: BLE001 — never 500 on a dead controller
            raise DoorCommandError(
                502, {"code": f"{action}_failed", "message": str(exc) or type(exc).__name__}
            ) from None
        finally:
            await connector.aclose()
        return {"ok": True, "door_id": door_id, "action": action, "result": result}
