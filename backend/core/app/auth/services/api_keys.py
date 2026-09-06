"""Service credentials: minting, scoping, authenticating and revoking API keys.

`_resolve_scopes` refuses to make a key wider than its creator.
`authenticate_api_key` fails closed with one identical error for every rejection
reason, so a caller cannot tell "no such key" from "revoked" from "wrong secret".
The prefix lookup relies on the UNIQUE index — a duplicate prefix 500s every
token exchange.
"""


from __future__ import annotations


import datetime as dt
import hmac
import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ...core.errors import NotFoundError, UnauthorizedError, ValidationError
from ...tenancy.scope import Scope, assert_owned
from ..models import ApiKey, User
from .. import dynamic_permissions
from ..permissions import WILDCARD
from ..schemas import ApiKeyCreateIn
from ..security import api_key_prefix, create_api_key_token, generate_api_key, hash_api_key

class ApiKeyMixin:
    """Part of :class:`AuthService`; see `services/__init__.py`."""

    db: AsyncSession

    # --- API keys ----------------------------------------------------------
    async def _resolve_scopes(
        self, data: ApiKeyCreateIn, actor: User | None, scope: Scope | None
    ) -> list[str]:
        """The permission list a new key will carry, or refuse to make one.

        Three rules:

        1. Never the wildcard, not even for a super-admin — there must be no
           privilege level at which an unbounded machine credential reopens.
        2. Never more than the creator holds, or the facility becomes a
           privilege-escalation primitive.
        3. Never a scope outside the catalog (static plus runtime registrations):
           a permission nothing checks reads as a restriction and is not one.

        ``role_id`` is accepted but only SNAPSHOTS that role's permissions into
        ``scopes`` — not a live link, so editing the role later cannot widen the
        key. Passing the Administrator role therefore hits rule 1 and is refused.
        """
        requested = list(data.scopes or [])
        if not requested and data.role_id is not None:
            role = await self._require_role(data.role_id, scope)
            requested = list(role.permissions or [])
        if not requested:
            raise ValidationError("an API key must be given at least one scope")
        if WILDCARD in requested:
            raise ValidationError(
                "an API key cannot hold the '*' wildcard — list the permissions it needs"
            )
        unknown = await dynamic_permissions.unknown(self.db, requested)
        if unknown:
            raise ValidationError(
                f"unknown permission(s): {', '.join(sorted(unknown))}"
            )
        if actor is not None and not getattr(actor, "is_superadmin", False):
            role = getattr(actor, "role", None)
            if role is None or not role.grants(WILDCARD):
                held = set(getattr(role, "permissions", None) or [])
                over = [p for p in requested if p not in held]
                if over:
                    raise ValidationError(
                        "an API key cannot be given permissions you do not hold: "
                        + ", ".join(sorted(over))
                    )
        # Order-stable and de-duplicated so two keys created from the same request
        # compare equal in a listing and in the audit meta.
        return sorted(set(requested))

    async def create_api_key(
        self,
        data: ApiKeyCreateIn,
        scope: Scope | None = None,
        actor: User | None = None,
    ) -> tuple[ApiKey, str]:
        scopes = await self._resolve_scopes(data, actor, scope)
        raw, prefix, key_hash = generate_api_key()
        # Stamp the key with the creating admin's tenant (NULL for a super-admin's
        # platform key). Scoped listing + scoped auth then keep keys tenant-isolated.
        tenant_id = None if scope is None or scope.is_platform else scope.tenant_id
        key = ApiKey(
            name=data.name,
            description=data.description,
            scopes=scopes,
            role_id=None,
            prefix=prefix,
            key_hash=key_hash,
            tenant_id=tenant_id,
            expires_at=data.expires_at,
            created_by=getattr(actor, "id", None),
        )
        self.db.add(key)
        await self.db.commit()
        await self.db.refresh(key)
        return key, raw

    def api_keys_query(self, scope: Scope | None = None):
        stmt = select(ApiKey).order_by(ApiKey.created_at.desc())
        if scope is not None and not scope.is_platform:
            stmt = stmt.where(ApiKey.tenant_id == scope.tenant_id)
        return stmt

    async def revoke_api_key(self, key_id: uuid.UUID, scope: Scope | None = None) -> ApiKey:
        key = await self.db.get(ApiKey, key_id)
        if key is None:
            raise NotFoundError("api key not found")
        # Isolation: a tenant-admin can only revoke their own tenant's keys.
        if scope is not None:
            assert_owned(key, scope, message="api key not found")
        key.is_active = False
        # Stamped only on the first revocation, so re-revoking cannot rewrite when
        # the credential actually stopped being trusted.
        if key.revoked_at is None:
            key.revoked_at = dt.datetime.now(dt.timezone.utc)
        await self.db.commit()
        await self.db.refresh(key)
        return key

    async def authenticate_api_key(self, raw: str) -> ApiKey:
        """Verify a presented ``nbk_...`` key and stamp its last-used time.

        Every refusal returns the same message, so the endpoint cannot be used to
        enumerate which prefixes exist or which have been revoked.

        SHA-256 rather than argon2 is fine: the input is a 256-bit random secret,
        not a password. The comparison must still be constant-time.
        """
        prefix = api_key_prefix(raw)
        if prefix is None:
            raise UnauthorizedError("invalid API key")
        key = (
            await self.db.execute(select(ApiKey).where(ApiKey.prefix == prefix))
        ).scalar_one_or_none()
        if key is None:
            raise UnauthorizedError("invalid API key")
        if not hmac.compare_digest(key.key_hash, hash_api_key(raw)):
            raise UnauthorizedError("invalid API key")
        now = dt.datetime.now(dt.timezone.utc)
        if not key.usable_at(now):
            raise UnauthorizedError("invalid API key")
        # Stamped on the exchange, not on every request the resulting token makes
        # (satellites verify statelessly and never see the key). So it means "last
        # exchanged" — within a token TTL of last use, which is enough to answer
        # "is anything still using this?" without a write per request.
        key.last_used_at = now
        await self.db.commit()
        await self.db.refresh(key)
        return key

    async def issue_api_key_token(self, key: ApiKey) -> tuple[str, int]:
        """Exchange a verified key for a short-lived access token → (token, ttl_s).

        Entitlements are baked in exactly as at login, so a key belonging to a
        suspended or expired tenant is not a way around the gate on that tenant's
        users.

        No refresh token, deliberately: the key already is the long-lived
        credential, and a refresh token would let a revoked key keep minting.
        """
        from ...tenancy.entitlements import token_entitlements

        # ``token_entitlements`` reads only ``is_superadmin`` (False for a key) and
        # ``tenant_id``, so the key row resolves the same entitlements its tenant's
        # users get. Reuse it rather than writing a parallel resolver that drifts.
        features, limits, license_state, tenant_status = await token_entitlements(
            self.db, key
        )
        return create_api_key_token(
            key,
            features=features,
            limits=limits,
            license_state=license_state,
            tenant_status=tenant_status,
        )
