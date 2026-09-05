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

THE TWO PATHS DO NOT MEET, and that is the safety property this module exists to
hold. ``get_current_user`` — the INTERACTIVE path, behind /auth/me, the session
endpoints and everything the console SPA touches — looks a ``users`` row up by
``sub`` and 401s when there is none. A key's ``sub`` is never a user id, so a key
can hold a perfectly valid signed token and still not be able to sign in to the
console. There is no branch to remove to change that; the refusal is a
consequence of the shape, not a check someone has to remember to write.
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


async def get_current_user(
    cred: HTTPAuthorizationCredentials | None = Depends(_bearer),
    db: AsyncSession = Depends(get_db),
) -> User:
    """The signed-in PERSON. Unchanged, and unchanged on purpose.

    This is the console's path. It resolves ``sub`` to a ``users`` row and refuses
    when there is none, so a key-derived token (``sub`` = an api_keys id) is a 401
    here no matter how valid its signature or how wide its scopes. Do not teach
    this function about API keys: "a service credential cannot open the UI" is
    enforced by the fact that nothing on this path knows what one is.
    """
    if cred is None:
        raise UnauthorizedError("missing bearer token")
    try:
        payload = decode_token(cred.credentials)
    except jwt.PyJWTError:
        raise UnauthorizedError("invalid or expired token")
    if payload.get("type") != "access":
        raise UnauthorizedError("not an access token")
    user = await db.get(User, uuid.UUID(payload["sub"]))  # role selectin-loaded
    if user is None or not user.is_active:
        raise UnauthorizedError("user not found or inactive")
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

    Core routes read ``actor.role.grants(...)`` and ``actor.role.name`` in a dozen
    places. This satisfies both WITHOUT being an ORM ``Role``: a detached mapped
    object handed to a request's session is one autoflush away from an INSERT, and
    a phantom role row named after an API key is not a bug anybody would find
    quickly. It is a plain object, so it cannot be persisted by accident.
    """

    __slots__ = ("name", "permissions")

    def __init__(self, name: str, permissions: list[str]) -> None:
        self.name = name
        self.permissions = list(permissions)

    def grants(self, permission: str) -> bool:
        # No wildcard branch — a key holding "*" cannot be created. See ApiKey.grants.
        return permission in self.permissions


class ApiKeyPrincipal:
    """The caller when the credential is a service key, shaped like the ``User``
    the routes expect.

    It answers the attributes core reads off an actor — ``id``, ``email``,
    ``full_name``, ``tenant_id``, ``is_superadmin``, ``is_active``, ``role`` — so
    ``scope_of(actor)`` and ``audit.record(actor=...)`` work unchanged. ``email``
    is None because a key HAS no email, and leaving it None is what makes the
    audit row visibly not a person even before you read ``actor_type``.

    It deliberately does NOT impersonate a user any further than that. A core
    route that reaches for something only a real user has (a password hash, a
    preferences blob, a site scope) raises an AttributeError and returns 500. That
    is loud and it is the right failure: the alternative is inventing a plausible
    value and letting a machine credential walk a path written for a person.
    ``is_superadmin`` is a constant False, not a field, so there is nowhere for a
    caller to set it.
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

    Read fresh on EVERY request, exactly as ``get_current_user`` re-reads the user
    row, and for the same reason inverted: revocation has to bite before the token
    expires. This is the half of "revoked immediately" that core can actually
    guarantee — a satellite verifies statelessly and cannot know, which is why the
    key-token TTL is 15 minutes and not 12 hours (core/config.py says so at the
    setting).
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

    The person branch is ``get_current_user``'s body, character for character; the
    key branch is entered ONLY when the token carries ``act == "apikey"``. A token
    without that claim — every token minted before this existed, and every login
    token minted after — takes a path that is unchanged, which is the whole basis
    for calling this additive. An unrecognised ``act`` value is refused rather than
    falling through to the user branch: an unknown credential kind must not be
    quietly downgraded to the one with more reach.
    """
    if cred is None:
        raise UnauthorizedError("missing bearer token")
    try:
        payload = decode_token(cred.credentials)
    except jwt.PyJWTError:
        raise UnauthorizedError("invalid or expired token")
    if payload.get("type") != "access":
        raise UnauthorizedError("not an access token")
    act = payload.get("act")
    if act == "apikey":
        return await _resolve_key_actor(payload, db)
    if act is not None:
        raise UnauthorizedError("unknown credential kind")
    user = await db.get(User, uuid.UUID(payload["sub"]))  # role selectin-loaded
    if user is None or not user.is_active:
        raise UnauthorizedError("user not found or inactive")
    return user


def require_permission(*permissions: str):
    """Dependency factory: the caller must grant ALL of these permissions.

    For a PERSON this is ``user.role.grants(...)`` against the role loaded fresh
    from the database — identical to what it has always been. For a SERVICE KEY it
    is the key row's own ``scopes``, also loaded fresh. A BI-read key asking to
    create a user gets the same 403, from the same line, as an under-privileged
    human: the credential kind changes where the permission list comes from and
    nothing else.
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


def require_service_permission(*permissions: str):
    """Like ``require_permission``, but also accepts a SERVICE token.

    Every other satellite on this platform authorises locally by VERIFYING the
    core-minted JWT with the shared secret — there is no user row behind a
    background caller (`vision`'s `mint_service_token` is the worked example: a
    superadmin token with a fixed system `sub`). Core itself has always required a
    real `users` row, which is right for an operator surface and wrong for a
    service-to-service one: the reading-writer registering its dataset permissions
    has no user to be.

    So: a token that carries `is_superadmin` (or the permission itself) in its
    CLAIMS is accepted without a user lookup. The signature is the authority —
    minting one already requires the platform secret. A normal operator bearer
    still goes down the user path and is checked against their role.
    """

    async def _dep(
        cred: HTTPAuthorizationCredentials | None = Depends(_bearer),
        db: AsyncSession = Depends(get_db),
    ) -> User | None:
        if cred is None:
            raise UnauthorizedError("missing bearer token")
        try:
            payload = decode_token(cred.credentials)
        except jwt.PyJWTError:
            raise UnauthorizedError("invalid or expired token")
        if payload.get("type") != "access":
            raise UnauthorizedError("not an access token")
        # A SERVICE KEY presenting itself here goes down the same live-row check
        # as it does in require_permission, so a revoked key is refused on this
        # route too. Without this it would fall through to the claims branch
        # below and keep working until its token expired — a revocation that is
        # honoured on most of core and not on the service-to-service routes is a
        # revocation nobody can reason about.
        if payload.get("act") == "apikey":
            actor = await _resolve_key_actor(payload, db)
            missing = [p for p in permissions if not actor.role.grants(p)]
            if missing:
                raise ForbiddenError(f"missing permission(s): {', '.join(missing)}")
            return None
        claims = payload.get("permissions") or []
        if payload.get("is_superadmin") or "*" in claims:
            return None
        user = await db.get(User, uuid.UUID(payload["sub"]))
        if user is None or not user.is_active:
            # Fall back to the claims themselves for a service principal that has
            # been granted the key explicitly rather than as a superadmin.
            if all(p in claims for p in permissions):
                return None
            raise UnauthorizedError("user not found or inactive")
        missing = [p for p in permissions if not user.role.grants(p)]
        if missing:
            raise ForbiddenError(f"missing permission(s): {', '.join(missing)}")
        return user

    return _dep


def user_has(user: User, permission: str) -> bool:
    return user.role.grants(permission)


# ``get_api_key`` — an X-API-Key header dependency that authenticated a caller
# with the key's ROLE — stood here from the 0001 baseline until 2026-09-05. It is
# REMOVED rather than left dormant. No route ever depended on it (checked across
# every backend before deleting), so it authorized nothing; what it was was a
# second, role-powered verification path sitting one `Depends(...)` away from
# being wired to something, next to a scoped path that looks similar and is not.
# The scopes now live on the key row and the only way to present one is
# POST /auth/token — one path, and it fails closed.
