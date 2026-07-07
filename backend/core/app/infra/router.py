"""Super-admin infrastructure API — full path ``{api_prefix}/admin/infra/...``.

Every endpoint is gated by ``require_superadmin`` (403 for anyone else) and forwards
to the privileged ops-agent sidecar over the internal network, adding the shared
``X-Ops-Token``. Lifecycle + scale actions are audit-logged like the rest of the
platform (via ``app.core.audit.record``).

This module NEVER touches the Docker socket — only the ops-agent does.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth.models import User
from ..core.audit import record as audit_record
from ..db.base import get_db
from ..tenancy.deps import require_superadmin
from .client import OpsAgentClient

# Mounted by create_app under the app's api_prefix, so the full path is
# {api_prefix}/admin/infra/... (e.g. /api/v1/admin/infra/containers).
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

    Currently returns ok=false until real worker services exist; the call is
    still audited so the intent is recorded.
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
