"""Per-camera Go-``nvr`` routing (MN-1b) — resolve a camera's recorder-node base URL.

Multi-node estates run one Go ``nvr`` per recorder machine, each registered as a
``MediaNode`` (``media_nodes.api_url``). A camera carries a nullable
``media_node_id`` pointing at the node that fronts its live/record streams. This
helper turns that link into the base URL to hand ``NvrClient(base_url=...)``.

BACK-COMPAT (single-node): a camera with ``media_node_id = None`` (or a node whose
``api_url`` is missing / unreadable) resolves to ``None`` — the caller then lets
``NvrClient`` fall back to the global ``VE_NVR_URL``. This keeps the existing
single-node deployment byte-identical.

DEFENSIVE: a dangling ``media_node_id`` (node deleted), a cross-tenant node, or any
lookup error NEVER raises — it logs at info and returns ``None`` (fall back). Routing
a media call to the wrong node is worse handled by failing soft to the global URL.
"""

from __future__ import annotations

import logging
import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.vms.models import Camera, MediaNode

log = logging.getLogger("vision.node_routing")


async def node_base_for_camera(
    db: AsyncSession,
    tenant_id: uuid.UUID | None,
    camera_or_id: Camera | str,
) -> str | None:
    """Return the Go-``nvr`` base URL for ``camera_or_id``'s assigned MediaNode.

    * ``camera_or_id`` may be a loaded ``Camera`` (no extra query) or a camera id.
    * Returns the node's ``api_url`` when the camera is assigned to a node that
      belongs to ``tenant_id`` (or a platform/NULL-tenant node) and has an api_url.
    * Returns ``None`` — signalling "use the global ``VE_NVR_URL``" — when the camera
      is unassigned, the node is missing / cross-tenant, its api_url is blank, or any
      error occurs. NEVER raises.

    ``tenant_id`` is the caller's ``scope.tenant_id`` (``None`` = platform/super-admin).
    A node is usable when its ``tenant_id`` is ``None`` (shared) or equals the caller's
    tenant — mirroring ``kernel.auth.owns`` read semantics for by-id media routing.
    """
    try:
        node_id: str | None
        if isinstance(camera_or_id, str):
            camera = await db.get(Camera, camera_or_id)
            node_id = getattr(camera, "media_node_id", None) if camera else None
        else:
            node_id = getattr(camera_or_id, "media_node_id", None)

        if not node_id:
            return None  # unassigned → global VE_NVR_URL (single-node back-compat).

        return await node_base_for_id(db, tenant_id, node_id)
    except Exception as exc:  # noqa: BLE001 — routing must never raise; fall back soft.
        log.info("node routing lookup failed (%s) → fall back to global nvr", exc)
        return None


async def node_base_for_id(
    db: AsyncSession,
    tenant_id: uuid.UUID | None,
    media_node_id: str | None,
) -> str | None:
    """Return the Go-``nvr`` base URL for a ``MediaNode`` identified by ``media_node_id``.

    The by-id sibling of :func:`node_base_for_camera` — used to route media calls to the
    node that HOLDS a given piece of footage (a Recording's ``media_node_id``) rather than
    a camera's current assignment. Same rules as the camera resolver:

    * ``None`` / blank id → ``None`` (fall back to the global ``VE_NVR_URL``).
    * a dangling id (node deleted), a cross-tenant node, a blank ``api_url``, or any lookup
      error → ``None``. NEVER raises.

    ``tenant_id`` is the caller's ``scope.tenant_id``. A node is usable when its
    ``tenant_id`` is ``None`` (shared/platform) or equals the caller's tenant — mirroring
    ``kernel.auth.owns`` read semantics for by-id media routing.
    """
    try:
        if not media_node_id:
            return None

        node = await db.get(MediaNode, media_node_id)
        if node is None:
            log.info("media_node_id=%s not found → fall back to global nvr", media_node_id)
            return None

        # Tenant safety: a node owned by ANOTHER tenant must not be used. Platform
        # (NULL) nodes are shared; a caller's own tenant matches; superadmin
        # (tenant_id None) uses only shared nodes here — conservative by design.
        node_tenant = getattr(node, "tenant_id", None)
        if node_tenant is not None and node_tenant != tenant_id:
            log.info(
                "media node %s belongs to another tenant → fall back to global nvr",
                media_node_id,
            )
            return None

        api_url = (getattr(node, "api_url", None) or "").strip()
        if not api_url:
            log.info("media node %s has no api_url → fall back to global nvr", media_node_id)
            return None
        return api_url
    except Exception as exc:  # noqa: BLE001 — routing must never raise; fall back soft.
        log.info("node routing (by id) lookup failed (%s) → fall back to global nvr", exc)
        return None


__all__ = ["node_base_for_camera", "node_base_for_id"]
