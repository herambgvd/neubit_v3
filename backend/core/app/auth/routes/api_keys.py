"""Service credentials: minting, listing, revoking, and exchanging one for a JWT.

A key can never be wider than its creator (`_resolve_scopes`), can never sign in
to the console (`get_current_user` resolves `sub` to a users row, and a key's sub
is not one), and its revocation is immediate.
`tests/test_api_key_credential.py` holds all three.

`POST /auth/token` is on the self-service router, not the admin one: the raw key
is the credential presented to it.
"""

from __future__ import annotations

import uuid

from fastapi import Depends
from sqlalchemy.ext.asyncio import AsyncSession

from ...core.audit import record as audit_record
from ...core.pagination import Page, PageParams, page_params, paginate
from ...core.ratelimit import api_key_rate_limit
from ...db.base import get_db
from ...tenancy.scope import scope_of
from ..deps import require_permission
from ..models import User
from ..permissions import CorePerm
from ..schemas import (
    ApiKeyCreatedOut,
    ApiKeyCreateIn,
    ApiKeyOut,
    ApiKeyTokenIn,
    ApiKeyTokenOut,
)
from ..service import AuthService

from . import admin_router, router


# --- API keys ----------------------------------------------------------------
#
# Create / list / revoke, all gated on ``apikey.manage`` (registered in
# permissions.py — a gate whose key is not in the catalog is one no role can open).
#
# No read-back and no rotate-in-place: the secret is shown once by ``create`` and
# exists nowhere afterwards. Replacing a key is create, move the peer, revoke —
# three auditable steps rather than one that silently invalidates a deployment.
@admin_router.post("/api-keys", response_model=ApiKeyCreatedOut, status_code=201)
async def create_api_key(
    data: ApiKeyCreateIn,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_permission(CorePerm.APIKEY_MANAGE)),
) -> ApiKeyCreatedOut:
    """Mint a scoped service credential. The raw key is in this response and nowhere else."""
    key, raw = await AuthService(db).create_api_key(data, scope_of(actor), actor=actor)
    await audit_record(
        db, actor=actor, action="apikey.create", target_type="api_key",
        target_id=str(key.id),
        # Scopes go in the audit meta: the key row can be revoked and purged, but
        # "a key that could read BI was created" has to stay legible.
        meta={
            "name": key.name,
            "prefix": key.prefix,
            "scopes": list(key.scopes or []),
            "expires_at": key.expires_at.isoformat() if key.expires_at else None,
        },
    )
    return ApiKeyCreatedOut(**ApiKeyOut.model_validate(key).model_dump(), key=raw)


@admin_router.get("/api-keys", response_model=Page[ApiKeyOut])
async def list_api_keys(
    params: PageParams = Depends(page_params),
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_permission(CorePerm.APIKEY_MANAGE)),
) -> Page[ApiKeyOut]:
    # Tenant scoping: a tenant-admin only sees their own tenant's keys.
    return await paginate(
        db, AuthService(db).api_keys_query(scope_of(actor)), params, item_model=ApiKeyOut
    )


@admin_router.delete("/api-keys/{key_id}", status_code=204)
async def revoke_api_key(
    key_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_permission(CorePerm.APIKEY_MANAGE)),
) -> None:
    """Kill one credential. Touches no user account.

    Immediate for core and for any further exchange, both of which re-read this
    row. A token the key already holds keeps working at the satellites until it
    expires, since they verify statelessly — ``api_key_token_ttl_minutes`` (15) is
    the width of that window, which is why it is not 12 hours.
    """
    key = await AuthService(db).revoke_api_key(key_id, scope_of(actor))
    await audit_record(
        db, actor=actor, action="apikey.revoke", target_type="api_key", target_id=str(key_id),
        meta={"name": key.name, "prefix": key.prefix},
    )


@router.post("/token", response_model=ApiKeyTokenOut)
async def exchange_api_key(
    data: ApiKeyTokenIn,
    db: AsyncSession = Depends(get_db),
    _rl: None = Depends(api_key_rate_limit),
) -> ApiKeyTokenOut:
    """Exchange an ``nbk_...`` service key for a short-lived access token.

    Unauthenticated, because the key is the credential — as a password is at
    /auth/login. Rate-limited for the same reason, in its own bucket so a
    scheduled integration and a human signing in cannot starve each other
    (core/ratelimit.py).

    It returns an ordinary access token, so satellites authorize a key exactly as
    they authorize a person, with no kernel change.

    Every failure is 401 with one message, so the endpoint cannot be used to learn
    which keys exist or which have been killed.
    """
    svc = AuthService(db)
    key = await svc.authenticate_api_key(data.api_key)
    token, ttl = await svc.issue_api_key_token(key)
    # Deliberately not audited: a machine re-exchanges every few minutes, and a row
    # per exchange would bury the real trail and trip audit_log's retention purge.
    # The facts land where they stay useful — ``last_used_at`` on the key row, and
    # ``actor_type='apikey'`` on every entry the resulting token writes.
    return ApiKeyTokenOut(
        access_token=token, expires_in=ttl, scopes=list(key.scopes or [])
    )


# Mounted last so the self-service paths above keep their declaration order; the two
# sets do not overlap (`/me…` vs `/users…`, `/roles…`, `/api-keys…`).
