"""Live-streaming router — permission-gated, tenant-scoped (P2-B).

Mounted under the service api_prefix (``/api/v1``) with the ``/vms`` domain prefix.
Endpoints:
  * ``POST   /vms/cameras/{id}/live``                → issue a PlaybackSession.
  * ``POST   /vms/cameras/{id}/live/{session}/renew``→ re-mint the media token.
  * ``DELETE /vms/live/{session}``                   → release (nvr path + row).
  * ``GET    /vms/media/verify``                     → Traefik ForwardAuth hot path.

Session issue/renew/release gate on ``vms.live.view`` (``*`` wildcard grants it);
they run inside the caller's tenant scope. ``/media/verify`` is PUBLIC (no bearer
required) — it authorizes purely off the short-lived media token in ``?token=`` or a
forwarded header, because Traefik calls it un-authenticated on every HLS segment.

The caller's JWT is captured (``_bearer``) and forwarded to the Go ``nvr`` for the
ensure/drop service call, so nvr authorizes under the caller's own grants.
"""

from __future__ import annotations

import os
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, Query, Request, Response, status
from fastapi.security import HTTPAuthorizationCredentials
from sqlalchemy.ext.asyncio import AsyncSession

from kernel.auth import Principal, Scope, get_scope, require_permission
from kernel.auth import _bearer  # raw bearer credentials (forwarded to nvr)
from kernel.errors import ForbiddenError

from app.db import get_db
from app.vms.common.core_audit import fire_and_forget_video_audit
from app.vms.groups.acl import enforce_camera_privilege

from .schemas import LiveStartBody, PlaybackSessionPublic
from .service import LiveService

PERM_VIEW = "vms.live.view"

router = APIRouter(prefix="/vms", tags=["VMS Live"])


def _audit_live_view() -> bool:
    """Whether live-session issue is audited (env ``VE_AUDIT_LIVE_VIEW``, default OFF).

    Live view is very high-volume + low-sensitivity, so auditing every session issue
    would flood the trail; it's opt-in. Set ``VE_AUDIT_LIVE_VIEW`` to ``1``/``true``/
    ``yes``/``on`` to enable. Recorded playback + export are ALWAYS audited (unflagged).
    """
    return (os.environ.get("VE_AUDIT_LIVE_VIEW") or "").strip().lower() in (
        "1",
        "true",
        "yes",
        "on",
    )


def _bearer_token(
    cred: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> str | None:
    return cred.credentials if cred else None


async def get_live_service(
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
    bearer: Annotated[Optional[str], Depends(_bearer_token)],
) -> LiveService:
    return LiveService(db, scope, bearer=bearer)


# ── session issue / renew / release ─────────────────────────────────────


@router.post(
    "/cameras/{camera_id}/live",
    response_model=PlaybackSessionPublic,
    status_code=status.HTTP_201_CREATED,
)
async def start_live(
    camera_id: str,
    svc: Annotated[LiveService, Depends(get_live_service)],
    body: LiveStartBody | None = None,
    actor: Principal = Depends(require_permission(PERM_VIEW)),
) -> PlaybackSessionPublic:
    # Per-camera ACL: role gate passed; now the fine-grained view_live grant (if any).
    await enforce_camera_privilege(
        svc.db, scope=svc.scope, principal=actor, camera_id=camera_id, privilege="view_live"
    )
    profile = (body.profile if body else None) or "sub"
    session = await svc.start_live(camera_id, profile, actor=actor)
    # Live-view audit is OPTIONAL (high-volume, low-sensitivity) — only when the
    # VE_AUDIT_LIVE_VIEW flag is on. Fire-and-forget; adds zero latency, never fails.
    if _audit_live_view():
        fire_and_forget_video_audit(
            action="vms.live.view",
            camera_id=camera_id,
            principal=actor,
            meta={"profile": profile},
        )
    return session


@router.post(
    "/cameras/{camera_id}/live/{session_id}/renew",
    response_model=PlaybackSessionPublic,
)
async def renew_live(
    camera_id: str,
    session_id: str,
    svc: Annotated[LiveService, Depends(get_live_service)],
    actor: Principal = Depends(require_permission(PERM_VIEW)),
) -> PlaybackSessionPublic:
    # Per-camera ACL: re-minting a media token still requires the view_live grant.
    await enforce_camera_privilege(
        svc.db, scope=svc.scope, principal=actor, camera_id=camera_id, privilege="view_live"
    )
    return await svc.renew(session_id, actor=actor)


@router.delete("/live/{session_id}", status_code=status.HTTP_204_NO_CONTENT)
async def release_live(
    session_id: str,
    svc: Annotated[LiveService, Depends(get_live_service)],
    actor: Principal = Depends(require_permission(PERM_VIEW)),
) -> Response:
    await svc.release(session_id, actor=actor)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ── media-verify (Traefik ForwardAuth) — PUBLIC, token-authorized ───────


@router.get("/media/verify", status_code=status.HTTP_200_OK)
async def media_verify(
    request: Request,
    db: Annotated[AsyncSession, Depends(get_db)],
    token: str | None = Query(default=None),
) -> Response:
    """Validate the media token → 200 (empty) when valid, 401/403 otherwise.

    The token comes from ``?token=`` (the URL the browser plays) OR, when Traefik
    strips the query, from an ``Authorization: Bearer`` / ``X-Forwarded-*`` header it
    forwards. Fast + stateless: a single HMAC verify, no DB on the hot path.
    """
    tok = token or _token_from_headers(request)
    if not tok:
        # No credential at all → 401 (Traefik blocks the MediaMTX request).
        from kernel.errors import UnauthorizedError

        raise UnauthorizedError("missing media token")

    # Platform scope: verify is stateless (no caller scope). A tenant/ACL cross-check
    # is best-effort — disabled on the hot path (camera-in-tenant is baked into the
    # token at issue time). Enable via ?check=1 for an explicit DB cross-check.
    svc = LiveService(db, _PLATFORM_SCOPE, bearer=None)
    check = request.query_params.get("check") in ("1", "true", "yes")
    try:
        await svc.verify(tok, check_camera=check)
    except Exception as exc:  # noqa: BLE001 — map to 401/403 below
        from kernel.errors import AppError, UnauthorizedError

        if isinstance(exc, AppError):
            # NotFound (camera/tenant mismatch) → 403 for Traefik; auth failures → 401.
            if exc.status_code == status.HTTP_404_NOT_FOUND:
                raise ForbiddenError("media token not authorized for this camera") from exc
            raise
        raise UnauthorizedError("invalid media token") from exc
    return Response(status_code=status.HTTP_200_OK)


# ── helpers ──────────────────────────────────────────────────────────────

from kernel.auth import Scope as _Scope  # noqa: E402

# A platform scope for the stateless verify path (no caller — it authorizes off the
# media token, not a session). Never used to WRITE.
_PLATFORM_SCOPE = _Scope(tenant_id=None, is_superadmin=True)


def _token_from_headers(request: Request) -> str | None:
    """Extract the media token from headers Traefik ForwardAuth may forward."""
    auth = request.headers.get("authorization") or request.headers.get("Authorization")
    if auth and auth.lower().startswith("bearer "):
        return auth[7:].strip()
    # Traefik can pass the original request via X-Forwarded-Uri (with ?token=).
    fwd_uri = request.headers.get("x-forwarded-uri")
    if fwd_uri and "token=" in fwd_uri:
        from urllib.parse import parse_qs, urlsplit

        qs = parse_qs(urlsplit(fwd_uri).query)
        vals = qs.get("token")
        if vals:
            return vals[0]
    return None
