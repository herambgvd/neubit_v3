"""Auth dependencies: resolve the caller and enforce PERMISSIONS (not role names).

Two kinds of caller, both arriving as a Bearer access token:

  - a PERSON, whose token was minted by /auth/login and whose ``sub`` is a
    ``users`` row → get_current_user;
  - a SERVICE KEY, whose token was minted by /auth/token in exchange for an
    ``nbk_...`` credential and whose ``sub`` is an ``api_keys`` row, marked by the
    ``act="apikey"`` claim → resolved inside require_permission.

Access control is permission-based: ``require_permission("user.manage")``. A
person's permissions come from their (dynamic) role, loaded fresh each request; a
key's come from the key row's own ``scopes``, also read fresh, which is what makes
a revoked key stop working on the next request rather than at token expiry.

The two paths must not meet. ``get_current_user`` (the interactive path behind
/auth/me, the session endpoints, everything the console SPA touches) resolves
``sub`` to a ``users`` row and 401s when there is none. A key's ``sub`` is never
a user id, so a key with a valid token still cannot sign in to the console.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

import jwt
from fastapi import Depends
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.errors import ForbiddenError, UnauthorizedError
from ..db.base import get_db
from .models import ApiKey, User
from .security import decode_token

_bearer = HTTPBearer(auto_error=False)

# Three code paths reject a caller — the user token, the API key, and the websocket
# handshake — and each must answer the same sentence for the same cause. A path that
# said something more specific would tell an attacker which half of the credential
# was wrong, and which one they had reached.
_MISSING_BEARER = "missing bearer token"
_BAD_TOKEN = "invalid or expired token"
_NOT_ACCESS_TOKEN = "not an access token"
_NO_SUCH_USER = "user not found or inactive"


async def get_current_user(
    cred: HTTPAuthorizationCredentials | None = Depends(_bearer),
    db: AsyncSession = Depends(get_db),
) -> User:
    """The signed-in user. Resolves ``sub`` to a ``users`` row, 401 if there is none.

    Do not add API-key support here — a service credential must not open the UI,
    and that is enforced by this path not knowing what a key is.
    """
    if cred is None:
        raise UnauthorizedError(_MISSING_BEARER)
    try:
        payload = decode_token(cred.credentials)
    except jwt.PyJWTError:
        raise UnauthorizedError(_BAD_TOKEN)
    if payload.get("type") != "access":
        raise UnauthorizedError(_NOT_ACCESS_TOKEN)
    user = await db.get(User, uuid.UUID(payload["sub"]))  # role selectin-loaded
    if user is None or not user.is_active:
        raise UnauthorizedError(_NO_SUCH_USER)
    return user


async def get_current_sid(
    cred: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> str | None:
    """Return the session id (``sid``) claim from the caller's access token, or None.

    Lets an endpoint highlight which listed session is the one making the request.
    Never raises — a missing/legacy token (no sid) simply yields None.
    """
    if cred is None:
        return None
    try:
        return decode_token(cred.credentials).get("sid")
    except jwt.PyJWTError:
        return None


# --- API-key principal -------------------------------------------------------
class _KeyScopes:
    """The ``.role``-shaped view of a key's scopes.

    Satisfies the ``actor.role.grants(...)`` / ``actor.role.name`` that routes
    read. Deliberately not an ORM ``Role``: a mapped object in the request's
    session is one autoflush away from inserting a phantom role row.
    """

    __slots__ = ("name", "permissions")

    def __init__(self, name: str, permissions: list[str]) -> None:
        self.name = name
        self.permissions = list(permissions)

    def grants(self, permission: str) -> bool:
        # No wildcard branch — a key holding "*" cannot be created. See ApiKey.grants.
        return permission in self.permissions


class ApiKeyPrincipal:
    """The caller when the credential is a service key, shaped like a ``User``.

    Answers only the attributes core reads off an actor (``id``, ``email``,
    ``full_name``, ``tenant_id``, ``is_superadmin``, ``is_active``, ``role``) so
    ``scope_of`` and ``audit.record`` work unchanged. ``email`` stays None: a key
    has none, and it makes the audit row visibly not a person.

    Do not widen it. A route reaching for something only a real user has
    (password hash, preferences, site scope) should AttributeError and 500 rather
    than get an invented value. ``is_superadmin`` is a constant, not a field.
    """

    audit_actor_type = "apikey"
    is_superadmin = False

    def __init__(self, key: ApiKey) -> None:
        self.key = key
        self.id = key.id
        self.email = None
        self.full_name = key.name
        self.tenant_id = key.tenant_id
        self.is_active = True
        self.role = _KeyScopes(key.name, list(key.scopes or []))


async def _resolve_key_actor(payload: dict, db: AsyncSession) -> ApiKeyPrincipal:
    """Load the live ``api_keys`` row a key-derived token names, or refuse.

    Read fresh every request so revocation bites before the token expires. Only
    core can do this; satellites verify statelessly, which is why the key-token
    TTL is 15 minutes (see core/config.py).
    """
    raw_sub = payload.get("sub")
    try:
        key_id = uuid.UUID(str(raw_sub))
    except (ValueError, TypeError, AttributeError):
        raise UnauthorizedError("invalid api key token")
    key = await db.get(ApiKey, key_id)
    if key is None or not key.usable_at(datetime.now(timezone.utc)):
        raise UnauthorizedError("api key revoked or expired")
    return ApiKeyPrincipal(key)


async def _resolve_actor(
    cred: HTTPAuthorizationCredentials | None, db: AsyncSession
) -> User | ApiKeyPrincipal:
    """The authenticated caller behind a Bearer token — person or service key.

    The key branch is entered only for ``act == "apikey"``; a token with no
    ``act`` takes the unchanged user path. An unrecognised ``act`` is refused
    rather than falling through — an unknown credential kind must not be
    downgraded to the one with more reach.
    """
    if cred is None:
        raise UnauthorizedError(_MISSING_BEARER)
    try:
        payload = decode_token(cred.credentials)
    except jwt.PyJWTError:
        raise UnauthorizedError(_BAD_TOKEN)
    if payload.get("type") != "access":
        raise UnauthorizedError(_NOT_ACCESS_TOKEN)
    act = payload.get("act")
    if act == "apikey":
        return await _resolve_key_actor(payload, db)
    if act is not None:
        raise UnauthorizedError("unknown credential kind")
    user = await db.get(User, uuid.UUID(payload["sub"]))  # role selectin-loaded
    if user is None or not user.is_active:
        raise UnauthorizedError(_NO_SUCH_USER)
    return user


def require_permission(*permissions: str):
    """Dependency factory: the caller must grant all of these permissions.

    A person is checked against their role, a service key against the key row's
    own ``scopes`` — both loaded fresh. The credential kind only changes where
    the permission list comes from.
    """

    async def _dep(
        cred: HTTPAuthorizationCredentials | None = Depends(_bearer),
        db: AsyncSession = Depends(get_db),
    ) -> User | ApiKeyPrincipal:
        actor = await _resolve_actor(cred, db)
        missing = [p for p in permissions if not actor.role.grants(p)]
        if missing:
            raise ForbiddenError(f"missing permission(s): {', '.join(missing)}")
        return actor

    return _dep


def is_service_token(cred: HTTPAuthorizationCredentials | None) -> bool:
    """True for a valid SERVICE token — a platform principal with no ``users`` row.

    That is vision's `mint_service_token` shape: a signed access token carrying
    ``is_superadmin`` (or ``"*"`` in ``permissions``) and a reserved system ``sub``.
    Minting one needs the platform JWT secret, so the signature is the authority.

    Says nothing about PERMISSIONS — the route's own
    ``require_service_permission`` still decides. This exists so a guard that
    resolves an actor (see tenancy/features.require_tenant_active) can let a
    service call through instead of 401-ing it before the route is reached.
    """
    if cred is None:
        return False
    try:
        payload = decode_token(cred.credentials)
    except jwt.PyJWTError:
        return False
    if payload.get("type") != "access" or payload.get("act") is not None:
        return False
    return bool(payload.get("is_superadmin")) or "*" in (payload.get("permissions") or [])


def require_service_permission(*permissions: str):
    """Like ``require_permission``, but also accepts a service token.

    A background caller has no `users` row (see vision's `mint_service_token`), so
    a token carrying `is_superadmin` or the permission itself in its CLAIMS is
    accepted without a user lookup — the signature is the authority, and minting
    one needs the platform secret. An operator bearer still goes down the user
    path and is checked against their role.
    """

    async def _dep(
        cred: HTTPAuthorizationCredentials | None = Depends(_bearer),
        db: AsyncSession = Depends(get_db),
    ) -> User | None:
        if cred is None:
            raise UnauthorizedError(_MISSING_BEARER)
        try:
            payload = decode_token(cred.credentials)
        except jwt.PyJWTError:
            raise UnauthorizedError(_BAD_TOKEN)
        if payload.get("type") != "access":
            raise UnauthorizedError(_NOT_ACCESS_TOKEN)
        # A service key gets the same live-row check as in require_permission, so
        # a revoked key is refused here too. Without this it falls through to the
        # claims branch below and keeps working until its token expires.
        if payload.get("act") == "apikey":
            actor = await _resolve_key_actor(payload, db)
            missing = [p for p in permissions if not actor.role.grants(p)]
            if missing:
                raise ForbiddenError(f"missing permission(s): {', '.join(missing)}")
            return None
        claims = payload.get("permissions") or []
        privileged = bool(payload.get("is_superadmin")) or "*" in claims
        # LOOK THE USER UP FIRST, even for a privileged token.
        #
        # This used to `return None` on `is_superadmin` / `*` without touching the
        # DB — the same None a service token yields. Every real deployment's
        # Administrator role holds `*`, so on the routes that read `caller` the
        # account that actually uses them arrived as "no caller" and was treated
        # as the PLATFORM: `POST /messaging/templates/{name}/render` resolved the
        # platform tenant instead of theirs, which made a custom template 422
        # "unknown template" after it had stored, listed and previewed fine, and
        # made an override of a BUILT-IN render the code default with no error at
        # all. A service principal (no `users` row) still resolves to None below,
        # which is what those routes' fallbacks are for.
        try:
            user = await db.get(User, uuid.UUID(str(payload.get("sub"))))
        except (ValueError, TypeError):
            user = None  # a service `sub` that is not a uuid
        if user is not None and user.is_active:
            # A privileged claim still authorises; the live role is checked only
            # when it is not, so a superadmin without an explicit grant is not
            # locked out of a route their own token already carries.
            if not privileged:
                missing = [p for p in permissions if not user.role.grants(p)]
                if missing:
                    raise ForbiddenError(f"missing permission(s): {', '.join(missing)}")
            return user
        if privileged:
            return None
        # Fall back to the claims themselves for a service principal that has
        # been granted the key explicitly rather than as a superadmin.
        if all(p in claims for p in permissions):
            return None
        raise UnauthorizedError(_NO_SUCH_USER)

    return _dep


def user_has(user: User, permission: str) -> bool:
    return user.role.grants(permission)


# ``get_api_key`` (an X-API-Key dependency that authenticated with the key's
# ROLE) was removed, not left dormant: no route used it, and a second
# role-powered verification path next to the scoped one is a trap. Scopes live on
# the key row and POST /auth/token is the only way to present a key.
