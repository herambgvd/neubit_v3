"""DashForge embed registry API — `{api_prefix}/dashforge/...`.

Mounted by ``create_base_app`` alongside the other always-on core routers, so the
full paths are `/api/v1/dashforge/dashboards...`. That prefix used to be peeled
off at the gateway to a `dashforge` container; it now falls through to core with
the rest of `/api/`, and the routes and their permissions are unchanged.

    dashforge.read     list registrations, open one (mint a viewing session)
    dashforge.manage   register, edit and remove them

Both keys are in core's permission catalog (``app/auth/permissions.py``, group
"Dashboards") so a tenant admin can actually grant them in the role editor. A key
the catalog does not know about can only ever be held by a wildcard admin, which
is not a permission model — the ``ingest.*`` keys were exactly that mistake and
the catalog comment records it.

MODULE AND TENANT GATING ARE ON THE ROUTER, NOT THE ROUTES. Declared once in the
``APIRouter`` below so a route added later inherits them and cannot forget:

  * ``require_feature("analytics")``  — the "Dashboards & Reports" module.
  * ``require_tenant_active()``       — suspended tenant / expired licence.

The second one is worth a sentence because it is the piece that had to be
rebuilt. As a satellite this router was mounted behind the kernel's
``require_active_license``, which reads the tenant's state from the JWT CLAIM
because a satellite has no tenants table to ask. Core does have one, and had no
equivalent per-route gate at all — it refuses a suspended tenant at LOGIN and
otherwise trusts the token. Dropping the check on the way in would have widened
this route: a token minted before a suspension would keep minting embed tokens
until it expired. ``app.tenancy.features.require_tenant_active`` closes the same
window against the live row.

WHY `POST /{id}/session` IS THE WHOLE POINT OF THIS MODULE
----------------------------------------------------------
DashForge's `GET /public/embed/:token` is unauthenticated: the token IS the
credential. So the ONLY thing standing between a NeuBit-visible dashboard and
anyone who can load a NeuBit page is the check that happens before a token
exists. That check is here, on this route, in front of a mint that never happens
otherwise.

The failure mode being prevented, concretely: put the token anywhere a browser
can read it without passing `require_permission` first — bake it into the page,
serve it from a public config endpoint, attach it to the registration in the LIST
response — and every account that can reach the console, including one whose role
grants nothing, holds a working credential to that dashboard's data. The
registration list deliberately carries NO token for that reason; a session is a
separate, gated call.

`dashforge.read` and not `dashforge.manage`: viewing a dashboard is a read.
Minting is a privileged act on the DashForge side, but the privilege being
exercised belongs to the SERVICE account, not the caller — so gating the session
on the manage key would mean only editors could look at a dashboard, which is
backwards. What `manage` gates is deciding WHICH dashboards exist here at all.

A note on POST for something that reads: it mints a credential and has a
DashForge-side side effect (quota metering on the peer), so it is not cacheable
and must not be a GET that a proxy or a prefetch can replay.
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
    # The user rides along for attribution only. Authorisation stays the
    # permission plus the tenant.
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

    Carries no token. See the module docstring — a token in this response would
    make the session gate below decorative.
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
    """Remove the registration.

    NeuBit-side only: the dashboard itself is DashForge's and is untouched. This
    also does NOT revoke outstanding embed tokens — DashForge's revoke bumps a
    dashboard-wide epoch and would break every other consumer of that dashboard,
    which is not a decision unregistering it from one platform gets to make. The
    outstanding tokens expire on their own within the TTL (see `client.py`).
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
    """Mint one short-lived embed token for this viewer, right now.

    Order matters and is the security property: `require_permission` runs, then
    the registration is loaded THROUGH the tenant scope (a foreign tenant's id
    reads as not-found), and only then does a token come into existence.
    """
    row = await svc.get(embed_id)
    cfg = get_dashforge_settings()
    if not cfg.public_url:
        # Without a browser-resolvable origin the iframe URL would be built from
        # an internal service name and silently never load. Refuse with the
        # reason instead of returning a URL that cannot work.
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
        # DashForge's own expiry, passed through — never restated from this
        # platform's clock, which would drift against the signature that actually
        # decides.
        expires_at=str(minted.get("expiresAt") or ""),
        # Echoed so an operator can see on screen what the token is locked to.
        # It is already readable inside the token (the payload is base64, not
        # encrypted), so this reveals nothing the holder does not have.
        scope=minted.get("scope") or {},
    )
