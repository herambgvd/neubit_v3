"""Service credentials: minting, listing, revoking, and exchanging one for a JWT.

A key is a credential of a different KIND from a person, not a person with a
different login. It can never be wider than its creator (`_resolve_scopes`), it can
never sign in to the console (`get_current_user` resolves `sub` to a users row and a
key's sub is not one), and its revocation is immediate. `tests/test_api_key_credential.py`
holds all three.

`POST /auth/token` is on the SELF-SERVICE router, not the admin one: it is how a key
becomes a usable token, and the raw key is the credential presented to it.
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
# The operator surface for the platform's SERVICE CREDENTIAL. Create / list /
# revoke, all three gated on ``apikey.manage``, which is registered in
# permissions.py — a gate whose key is not in the catalog is a gate no role can
# ever open, which is the ``ingest.read`` failure that file's own comment records.
#
# There is no read-back and no rotate-in-place: the secret is shown once by
# ``create`` and exists nowhere afterwards. Replacing a key means creating the new
# one, moving the peer onto it, and revoking the old one — three explicit steps,
# each of which is auditable, instead of one that silently invalidates whatever
# was already deployed.
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
        # The SCOPES are in the audit meta on purpose. "A key was created" is not
        # the reviewable fact; "a key that can read BI was created" is, and the key
        # row can be revoked and later purged while the trail has to stay legible.
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
    """Kill one credential. Touches no user account — that is the whole point of it.

    Effective at once for anything core serves and for any further exchange, both
    of which re-read this row. A token the key already holds keeps working at the
    SATELLITES until it expires, because a satellite verifies statelessly and has
    nothing to ask; ``api_key_token_ttl_minutes`` (15) is the width of that window
    and is why it is not 12 hours. Stated here rather than left for someone to
    discover during an incident.
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

    UNAUTHENTICATED, because the key IS the credential — the same relationship
    /auth/login has with a password. It is rate-limited for the same reason: this
    is the only endpoint in the platform where a key secret can be guessed at. The
    bucket is its own and not login's, so a scheduled integration and a human
    typing their password cannot starve each other (core/ratelimit.py).

    WHAT THIS DELIBERATELY IS NOT: a second thing for the satellites to verify. It
    returns an ordinary access token, so ingest, workflow, vision, access and the
    reading-writer authorize a key exactly as they authorize a person, with the
    code they already run and no kernel change. That is what makes the whole
    facility additive — its correctness at eight services is demonstrated by those
    services being untouched.

    Every failure is 401 with one message. Malformed, unknown, wrong secret,
    revoked and expired are indistinguishable from outside, so the endpoint cannot
    be used to learn which keys exist or which have been killed.
    """
    svc = AuthService(db)
    key = await svc.authenticate_api_key(data.api_key)
    token, ttl = await svc.issue_api_key_token(key)
    # NOT AUDITED, and that is a decision rather than an omission. A machine
    # re-exchanges every few minutes forever; writing a row each time would bury
    # the trail this platform's operators actually read under uniform noise, and
    # audit_log has a retention purge that would then start evicting real entries.
    # The facts an exchange establishes are recorded where they stay useful:
    # ``last_used_at`` on the key row (is anything still using this?), and
    # ``actor_type='apikey'`` on every entry the resulting token goes on to write.
    return ApiKeyTokenOut(
        access_token=token, expires_in=ttl, scopes=list(key.scopes or [])
    )


# Mounted last so the self-service paths above keep their declaration order; the two
# sets do not overlap (`/me…` vs `/users…`, `/roles…`, `/api-keys…`).
