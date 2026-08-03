"""POS ingest + live-stream router.

Two endpoints, BOTH mounted on the PUBLIC vms router (no session-JWT module/license
gate) because each self-authenticates — mirroring the ingest/webhook services which
authorise off a shared secret rather than an operator session:

  * ``POST /vms/pos/ingest`` — a POS terminal / middleware pushes transaction lines.
    Auth: a shared ingest token (``Authorization: Bearer $VE_POS_INGEST_TOKEN``) for
    machine-to-machine push, OR a normal operator access-token that grants
    ``vms.config.manage``. Tenant scope comes from the JWT, or (shared-token push)
    from the target camera's ``tenant_id``.
  * ``GET  /vms/pos/stream?camera_id=...&token=<jwt>`` — the browser player subscribes
    over SSE. EventSource can't set headers, so the access token rides as ``?token=``.
    The endpoint resolves ``camera_id → pos_overlay.source`` (terminal), enforces tenant
    isolation, replays the recent ring buffer, then streams matching lines live.

Realtime transport reuses the app's SSE pattern (``StreamingResponse`` +
``text/event-stream`` + keepalive comments) exactly like the core ``realtime_vms``
bridge — the difference is the fan-out source is this service's in-process
``PosHub`` (ingest and stream share one process), which works with zero external
infra. A ``host:port`` source (TCP-pull collector) is documented as future work.
"""

from __future__ import annotations

import asyncio
import json
import os
from typing import Annotated

import jwt
from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from kernel.auth import Principal, verify_token
from kernel.errors import UnauthorizedError
from kernel.events import subject

from app.db import get_db
from app.vms.common.events import bus
from app.vms.models.camera import Camera
from app.vms.pos.hub import hub, hub_key
from app.vms.pos.schemas import (
    PosIngestBody,
    PosIngestResult,
    PosLine,
    _now_iso,
)

# Gated router kept for symmetry with the other vms domains, but POS lives on the
# public router (self-authenticating) so headerless middleware can push.
router = APIRouter(prefix="/vms", tags=["VMS POS"])
public_router = APIRouter(prefix="/vms", tags=["VMS POS (public)"])

KEEPALIVE_SECONDS = 20.0
PERM_INGEST = "vms.config.manage"
SSE_EVENT_NAME = "pos.line"


# --------------------------------------------------------------------------- auth


def _bearer_token(request: Request) -> str | None:
    auth = request.headers.get("authorization") or request.headers.get("Authorization")
    if auth and auth.lower().startswith("bearer "):
        return auth[7:].strip() or None
    return None


def _shared_ingest_token() -> str | None:
    """The optional shared POS-ingest secret (``VE_POS_INGEST_TOKEN``), or None if unset."""
    tok = os.getenv("VE_POS_INGEST_TOKEN", "").strip()
    return tok or None


async def _authenticate_ingest(request: Request) -> tuple[str, Principal | None]:
    """Authorise an ingest push. Returns ``(mode, principal)``.

    ``mode`` is ``"shared"`` (machine token — tenant resolved per line from the camera)
    or ``"jwt"`` (operator token — tenant fixed by the principal). Raises 401 otherwise.
    """
    token = _bearer_token(request)
    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "UNAUTHORIZED", "message": "POS ingest auth required"},
        )
    shared = _shared_ingest_token()
    if shared and token == shared:
        return "shared", None
    # Fall back to a normal operator access token that may configure the VMS.
    try:
        principal = verify_token(token)
    except (UnauthorizedError, jwt.PyJWTError):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "UNAUTHORIZED", "message": "invalid POS ingest token"},
        )
    if not principal.grants(PERM_INGEST):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"code": "FORBIDDEN", "message": f"missing permission {PERM_INGEST}"},
        )
    return "jwt", principal


def _principal_from_query(token: str | None) -> Principal:
    """Verify a ``?token=`` access token (browser EventSource) → Principal, else 401."""
    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "UNAUTHORIZED", "message": "SSE auth required"},
        )
    try:
        return verify_token(token)
    except (UnauthorizedError, jwt.PyJWTError):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "UNAUTHORIZED", "message": "invalid or expired token"},
        )


# --------------------------------------------------------------------- resolution


async def _load_camera(db: AsyncSession, camera_id: str) -> Camera | None:
    return (
        await db.execute(select(Camera).where(Camera.id == camera_id))
    ).scalar_one_or_none()


def _source_terminal(cam: Camera) -> str | None:
    """The POS terminal a camera listens to = its ``pos_overlay.source`` (trimmed)."""
    cfg = cam.pos_overlay or {}
    src = (cfg.get("source") or "").strip()
    return src or None


# ------------------------------------------------------------------------- ingest


async def _ingest(body: PosIngestBody, request: Request, db: AsyncSession) -> PosIngestResult:
    mode, principal = await _authenticate_ingest(request)

    # Normalise single-line vs batch into a flat list of (terminal, camera_id, text, ts).
    raw: list[dict] = []
    if body.lines:
        raw = [line.model_dump() for line in body.lines]
    elif body.text is not None:
        raw = [
            {
                "terminal": body.terminal,
                "camera_id": body.camera_id,
                "text": body.text,
                "ts": body.ts,
            }
        ]
    if not raw:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": "EMPTY", "message": "no POS lines in payload"},
        )

    accepted = 0
    terminals: set[str] = set()
    # Cache camera lookups within the request (batch may repeat a camera).
    cam_cache: dict[str, Camera | None] = {}

    for item in raw:
        text = (item.get("text") or "").strip()
        if not text:
            continue
        terminal = (item.get("terminal") or "").strip() or None
        camera_id = item.get("camera_id")

        cam: Camera | None = None
        if camera_id:
            if camera_id not in cam_cache:
                cam_cache[camera_id] = await _load_camera(db, camera_id)
            cam = cam_cache[camera_id]
        # Resolve the terminal from the camera's configured source when omitted.
        if not terminal and cam is not None:
            terminal = _source_terminal(cam)
        if not terminal:
            # No terminal and none derivable → we can't route this line.
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail={
                    "code": "NO_TERMINAL",
                    "message": "line needs a terminal or a camera_id with a pos_overlay.source",
                },
            )

        # Tenant scope: operator JWT fixes the tenant; a shared-token push inherits the
        # target camera's tenant (or platform/NULL when no camera is given).
        if mode == "jwt":
            tenant_id = str(principal.tenant_id) if principal and principal.tenant_id else None
        else:
            tenant_id = str(cam.tenant_id) if cam is not None and cam.tenant_id else None

        line = PosLine(
            terminal=terminal,
            camera_id=camera_id,
            text=text,
            ts=(item.get("ts") or _now_iso()),
        ).model_dump()

        hub.publish(hub_key(tenant_id, terminal), line)
        # Best-effort NATS mirror (no-op when NATS disabled) — parity/observability.
        try:
            await bus.publish(subject(tenant_id, "vms", "pos"), line)
        except Exception:  # noqa: BLE001 — never let the mirror break ingest
            pass
        accepted += 1
        terminals.add(terminal)

    return PosIngestResult(accepted=accepted, terminals=sorted(terminals))


@public_router.post("/pos/ingest", response_model=PosIngestResult)
async def ingest_pos(
    body: PosIngestBody,
    request: Request,
    db: Annotated[AsyncSession, Depends(get_db)],
) -> PosIngestResult:
    """Receive POS transaction lines (single or batch) and fan them out live."""
    return await _ingest(body, request, db)


# ------------------------------------------------------------------------- stream


@public_router.get("/pos/stream")
async def stream_pos(
    request: Request,
    camera_id: str = Query(..., description="camera whose pos_overlay.source to follow"),
    token: str | None = Query(None, description="access token (browser EventSource)"),
    db: AsyncSession = Depends(get_db),
) -> StreamingResponse:
    """SSE stream of POS lines for a camera's configured terminal (recent + live).

    Emits ``event: pos.line`` frames plus periodic ``: keepalive`` comments. Resolves
    ``camera_id → pos_overlay.source`` (terminal) and enforces tenant isolation. If the
    overlay is disabled or has no source, the stream stays open with keepalives only
    (nothing to show) — honest: no source, no text.
    """
    principal = _principal_from_query(token)

    cam = await _load_camera(db, camera_id)
    if cam is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "NOT_FOUND", "message": "camera not found"},
        )
    # Tenant isolation: a tenant may only watch its own cameras (super-admin sees all).
    if not principal.is_superadmin and cam.tenant_id != principal.tenant_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"code": "FORBIDDEN", "message": "camera not in tenant"},
        )

    cfg = cam.pos_overlay or {}
    terminal = _source_terminal(cam) if cfg.get("enabled") else None
    tenant_id = str(cam.tenant_id) if cam.tenant_id else None
    key = hub_key(tenant_id, terminal) if terminal else None

    async def event_stream():
        queue = hub.subscribe(key) if key else None
        try:
            yield ": connected\n\n"
            # Replay the recent ring buffer so a late-joining player has context.
            if key:
                for line in hub.recent(key):
                    yield f"event: {SSE_EVENT_NAME}\ndata: {json.dumps(line)}\n\n"
            while True:
                if await request.is_disconnected():
                    break
                if queue is None:
                    # No terminal configured — keepalive only (honest: nothing to stream).
                    await asyncio.sleep(KEEPALIVE_SECONDS)
                    yield ": keepalive\n\n"
                    continue
                try:
                    line = await asyncio.wait_for(queue.get(), timeout=KEEPALIVE_SECONDS)
                    yield f"event: {SSE_EVENT_NAME}\ndata: {json.dumps(line)}\n\n"
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
        finally:
            if key and queue is not None:
                hub.unsubscribe(key, queue)

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )
