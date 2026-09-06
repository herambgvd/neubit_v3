"""Super-admin infrastructure API — full path ``{api_prefix}/admin/infra/...``.

Every endpoint is gated by ``require_superadmin`` (403 for anyone else) and forwards
to the privileged ops-agent sidecar over the internal network, adding the shared
``X-Ops-Token``. Lifecycle + scale actions are audit-logged like the rest of the
platform (via ``app.core.audit.record``).

This module NEVER touches the Docker socket — only the ops-agent does.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, File, Query, Response, UploadFile
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth.models import User
from ..core.uploads import read_capped
from ..core.audit import record as audit_record
from ..db.base import get_db
from ..tenancy.deps import require_superadmin
from .client import OpsAgentClient

# Mounted by create_app under the app's api_prefix, so the full path is
# {api_prefix}/admin/infra/... (e.g. /api/v1/admin/infra/containers).
#: Cap on an uploaded SQL dump: big enough for a real backup, finite so a
#: mis-selected file cannot decide the process's memory use.
MAX_DUMP_BYTES = 512 * 1024 * 1024

router = APIRouter(prefix="/admin/infra", tags=["admin", "infra"])


def _agent() -> OpsAgentClient:
    return OpsAgentClient()


@router.get("/containers")
async def list_containers(
    _: User = Depends(require_superadmin),
) -> list[dict]:
    """List all neubit-v3 compose containers with live cpu/mem/health stats."""
    return await _agent().list_containers()


@router.get("/containers/{name}/logs")
async def container_logs(
    name: str,
    tail: int = Query(200, ge=1, le=5000),
    _: User = Depends(require_superadmin),
) -> dict:
    """Tail the last `tail` log lines of a container (read-only, not audited)."""
    return await _agent().logs(name, tail=tail)


@router.post("/containers/{name}/restart")
async def restart_container(
    name: str,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_superadmin),
) -> dict:
    """Restart a container. Audited."""
    result = await _agent().restart(name)
    await audit_record(
        db, actor=actor, action="infra.container.restart",
        target_type="container", target_id=name,
    )
    return result


@router.post("/containers/{name}/stop")
async def stop_container(
    name: str,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_superadmin),
) -> dict:
    """Stop a container. Audited."""
    result = await _agent().stop(name)
    await audit_record(
        db, actor=actor, action="infra.container.stop",
        target_type="container", target_id=name,
    )
    return result


@router.post("/containers/{name}/start")
async def start_container(
    name: str,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_superadmin),
) -> dict:
    """Start a stopped container. Audited."""
    result = await _agent().start(name)
    await audit_record(
        db, actor=actor, action="infra.container.start",
        target_type="container", target_id=name,
    )
    return result


class ScaleIn(BaseModel):
    replicas: int


@router.post("/services/{name}/scale")
async def scale_service(
    name: str,
    body: ScaleIn,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_superadmin),
) -> dict:
    """Best-effort scale of a stateless worker service (see ops-agent caveat).

    Returns ok=false until real worker services exist; still audited so the intent
    is recorded.
    """
    result = await _agent().scale(name, body.replicas)
    await audit_record(
        db, actor=actor, action="infra.service.scale",
        target_type="service", target_id=name, meta={"replicas": body.replicas},
    )
    return result


@router.get("/host")
async def host_summary(
    _: User = Depends(require_superadmin),
) -> dict:
    """Host/stack summary: container counts (+ host cpu/mem/disk if available)."""
    return await _agent().host()


# --- database backup / restore ----------------------------------------------
@router.get("/db/export")
async def db_export(
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_superadmin),
) -> Response:
    """Download a plain-SQL backup of the control database. Audited."""
    data = await _agent().db_export()
    await audit_record(
        db, actor=actor, action="infra.db.export",
        target_type="database", target_id="neubit_control", meta={"bytes": len(data)},
    )
    return Response(
        content=data,
        media_type="application/sql",
        headers={"Content-Disposition": 'attachment; filename="neubit_control.sql"'},
    )


@router.post("/db/import")
async def db_import(
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_superadmin),
) -> dict:
    """Restore the control database from an uploaded SQL backup. Audited.

    Destructive: the dump does DROP ... IF EXISTS and recreate, overwriting current
    control-plane data. The UI gates it behind an explicit confirmation.
    """
    # Capped: the risk is a wrong file, not malice. An unbounded `file.read()`
    # lets a mistaken selection decide how much memory this process allocates.
    sql = await read_capped(file, MAX_DUMP_BYTES, field="SQL backup")
    actor_id = actor.id  # capture before we drop the session's identity map
    # This request holds an AccessShareLock on `users` (from require_superadmin)
    # for the life of its transaction, and the restore needs AccessExclusiveLock to
    # rebuild that table. Roll back first or the restore blocks on us and times out.
    await db.rollback()
    result = await _agent().db_import(sql)
    # The restore just rebuilt the audit/users tables, so re-fetch the actor. Audit
    # is best-effort here: it must not fail a restore that already succeeded.
    try:
        fresh_actor = await db.get(User, actor_id)
        if fresh_actor is not None:
            await audit_record(
                db, actor=fresh_actor, action="infra.db.import",
                target_type="database", target_id="neubit_control",
                meta={"ok": result.get("ok"), "bytes": len(sql)},
            )
    except Exception:  # noqa: BLE001 — audit is best-effort post-restore
        await db.rollback()
    return result
