"""DashForge embed registry API — `{api_prefix}/dashforge/...`.

Mounted by ``create_base_app`` with the other always-on core routers, so full
paths are `/api/v1/dashforge/dashboards...`.

    dashforge.read     list registrations, open one (mint a viewing session)
    dashforge.manage   register, edit and remove them

Both keys live in core's permission catalog (``app/auth/permissions.py``, group
"Dashboards") so a tenant admin can grant them in the role editor. A key the
catalog does not know about can only be held by a wildcard admin.

Module and tenant gating are declared once on the ``APIRouter`` below, not per
route, so a route added later inherits them:

  * ``require_feature("analytics")``  — the "Dashboards & Reports" module.
  * ``require_tenant_active()``       — suspended tenant / expired licence.

Keep ``require_tenant_active``: core only refuses a suspended tenant at login, so
without it a token minted before a suspension keeps minting embed tokens until it
expires. It checks the live row.

`POST /{id}/session` is the security boundary of this module. DashForge's
`GET /public/embed/:token` is unauthenticated — the token is the credential — so
the permission check in front of the mint is the only thing between a dashboard
and anyone who can load a NeuBit page. Never expose a token where a browser can
read it without passing `require_permission` first (baked into the page, a public
config endpoint, the LIST response); the registration list carries no token for
that reason.

The session is gated on `dashforge.read`, not `manage`: viewing is a read, and the
privilege being exercised on the mint belongs to the service account, not the
caller. `manage` gates which dashboards exist here at all.

It is a POST despite reading because it mints a credential and meters quota on the
peer — not cacheable, and not something a proxy or prefetch may replay.
"""

from __future__ import annotations

from typing import Annotated, Optional

from fastapi import APIRouter, Depends, Query, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth.deps import get_current_user, require_permission
from ..auth.models import User
from ..db.base import get_db
from ..tenancy.features import require_feature, require_tenant_active
from ..tenancy.scope import Scope, get_scope
from .client import DashForgeUnavailable, client as dashforge
from .config import get_dashforge_settings
from .schemas import (
    EmbedCreate,
    EmbedListResponse,
    EmbedPublic,
    EmbedSession,
    EmbedUpdate,
)
from .service import EmbedRegistryService

PERM_READ = "dashforge.read"
PERM_MANAGE = "dashforge.manage"

router = APIRouter(
    prefix="/dashforge",
    tags=["DashForge"],
    dependencies=[
        Depends(require_feature("analytics")),
        Depends(require_tenant_active()),
    ],
)


async def _service(
    db: Annotated[AsyncSession, Depends(get_db)],
    scope: Annotated[Scope, Depends(get_scope)],
    user: Annotated[User, Depends(get_current_user)],
) -> EmbedRegistryService:
    # The user rides along for attribution only; authorisation is the permission
    # plus the tenant.
    return EmbedRegistryService(db, scope, actor=user.id)


Svc = Annotated[EmbedRegistryService, Depends(_service)]


# ── registrations ────────────────────────────────────────────────────────────


@router.get(
    "/dashboards",
    response_model=EmbedListResponse,
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def list_embeds(
    svc: Svc,
    search: Optional[str] = Query(None, max_length=160),
) -> EmbedListResponse:
    """Every DashForge dashboard this caller's tenant shows.

    Carries no token — one here would make the session gate below decorative.
    """
    items, total = await svc.list_(search=search)
    return EmbedListResponse(
        items=[EmbedPublic.model_validate(r) for r in items], total=total
    )


@router.post(
    "/dashboards",
    response_model=EmbedPublic,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_permission(PERM_MANAGE))],
)
async def register_embed(svc: Svc, body: EmbedCreate) -> EmbedPublic:
    return EmbedPublic.model_validate(await svc.create(body))


@router.get(
    "/dashboards/{embed_id}",
    response_model=EmbedPublic,
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def get_embed(svc: Svc, embed_id: str) -> EmbedPublic:
    return EmbedPublic.model_validate(await svc.get(embed_id))


@router.patch(
    "/dashboards/{embed_id}",
    response_model=EmbedPublic,
    dependencies=[Depends(require_permission(PERM_MANAGE))],
)
async def update_embed(svc: Svc, embed_id: str, body: EmbedUpdate) -> EmbedPublic:
    return EmbedPublic.model_validate(await svc.update(embed_id, body))


@router.delete(
    "/dashboards/{embed_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(require_permission(PERM_MANAGE))],
)
async def delete_embed(svc: Svc, embed_id: str) -> Response:
    """Remove the registration. NeuBit-side only; the dashboard itself is untouched.

    Does not revoke outstanding embed tokens: DashForge's revoke bumps a
    dashboard-wide epoch and would break every other consumer of it. They expire
    on their own within the TTL (see `client.py`).
    """
    await svc.delete(embed_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ── viewing session ──────────────────────────────────────────────────────────


@router.post(
    "/dashboards/{embed_id}/session",
    response_model=EmbedSession,
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def open_session(svc: Svc, embed_id: str) -> EmbedSession:
    """Mint one short-lived embed token for this viewer.

    Order is the security property: `require_permission` runs, then the
    registration is loaded through the tenant scope (a foreign tenant's id reads
    as not-found), and only then does a token exist.
    """
    row = await svc.get(embed_id)
    cfg = get_dashforge_settings()
    if not cfg.public_url:
        # Without a browser-resolvable origin the iframe URL would use an internal
        # service name and silently never load. Refuse with the reason instead.
        raise DashForgeUnavailable(
            "VE_DASHFORGE_PUBLIC_URL is not set, so no browser-resolvable embed "
            "URL can be built for this deployment"
        )

    minted = await dashforge.mint_embed_token(
        workspace_ref=row.workspace_ref,
        dashboard_ref=row.dashboard_ref,
        scope=row.scope or None,
    )
    token = minted.get("embedToken") or ""
    if not token:
        raise DashForgeUnavailable("DashForge returned no embed token")

    return EmbedSession(
        embed_id=row.id,
        token=token,
        iframe_url=f"{cfg.public_url.rstrip('/')}/embed/{token}",
        # DashForge's own expiry, passed through. Do not restate it from this
        # platform's clock — it would drift against the signature that decides.
        expires_at=str(minted.get("expiresAt") or ""),
        # Echoed so an operator can see what the token is locked to. Already
        # readable inside the token (base64, not encrypted), so it leaks nothing.
        scope=minted.get("scope") or {},
    )
