"""Service credentials: minting, scoping, authenticating and revoking API keys.

A key is a credential of a different KIND from a person. `_resolve_scopes` refuses
to make one wider than its creator; `authenticate_api_key` fails closed with an
identical error for every rejection reason so a caller cannot distinguish "no such
key" from "revoked" from "wrong secret"; and the prefix lookup relies on a UNIQUE
index, so two rows sharing a prefix would turn every token exchange into a 500.
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

        Three rules, and every one of them is a thing a key must not be able to do:

        1. NEVER THE WILDCARD. ``*`` is the built-in Administrator's grant and an
           unbounded machine credential is precisely what this facility replaces.
           Refused even for a super-admin, so there is no privilege level at which
           the escape hatch reopens.
        2. NEVER MORE THAN THE CREATOR HOLDS. A tenant admin who cannot manage
           users cannot mint a key that can. Without this the facility becomes a
           privilege-escalation primitive: "I cannot do X, but I can issue a
           credential that does X and then use it."
        3. NEVER AN UNENFORCED KEY. A scope outside the catalog (static plus the
           runtime registrations) is refused, because a key granting a permission
           nothing checks reads as a restriction and is not one — the same failure
           the ``ingest.read`` note in permissions.py records.

        ``role_id`` is still accepted, and SNAPSHOTS that role's permissions into
        ``scopes``. It is not stored as a live link: a role is edited over the
        years and every key wearing it would silently widen with it. Granting the
        Administrator role this way therefore hits rule 1 and is refused, which is
        a deliberate behaviour change from the pre-2026-09-05 form where exactly
        that produced a wildcard machine credential.
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
        # Stamped only on the FIRST revocation, so re-revoking cannot rewrite when
        # the credential actually stopped being trusted — which is the one fact an
        # incident review needs from this row.
        if key.revoked_at is None:
            key.revoked_at = dt.datetime.now(dt.timezone.utc)
        await self.db.commit()
        await self.db.refresh(key)
        return key

    async def authenticate_api_key(self, raw: str) -> ApiKey:
        """Verify a presented ``nbk_...`` key and stamp its last-used time.

        FAIL-CLOSED AT EVERY STEP, and each refusal returns the same message. A
        malformed key, an unknown prefix, a wrong secret, a revoked key and an
        expired key are indistinguishable to the caller, so this endpoint cannot
        be used to enumerate which prefixes exist or which have been revoked.

        The hash comparison is constant-time. It is a SHA-256 of a 256-bit random
        secret rather than a password hash — there is no low-entropy input to slow
        an attacker down against, so argon2 would buy nothing here and would cost
        a CPU-bound hash on a path a machine hits every few minutes — but the
        comparison itself still must not leak by timing.
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
        # The last-used stamp is written on the EXCHANGE, not on every request the
        # resulting token makes: the token is verified statelessly by nine services
        # and only this endpoint sees the key at all. It therefore means "last
        # exchanged", which for a 15-minute token is within 15 minutes of last use
        # — accurate enough to answer the question it exists for ("is anything
        # still using this?") without a write on every authorized request.
        key.last_used_at = now
        await self.db.commit()
        await self.db.refresh(key)
        return key

    async def issue_api_key_token(self, key: ApiKey) -> tuple[str, int]:
        """Exchange a verified key for a short-lived access token → (token, ttl_s).

        The tenant's entitlements are resolved here and baked in exactly as they
        are at login, so a satellite gates a key's request on the same module
        flags, quotas, licence state and suspension as a person's. A key belonging
        to a suspended or expired tenant must not be a way around the gate that
        stops that tenant's users.

        NO REFRESH TOKEN is issued, deliberately. A refresh token is a second
        long-lived credential with its own revocation story, and the key already
        IS the long-lived credential — re-exchanging costs one request and needs
        no human. Adding one would mean a revoked key whose refresh token still
        mints access tokens, i.e. re-creating the problem this facility exists to
        remove.
        """
        from ...tenancy.entitlements import token_entitlements

        # ``token_entitlements`` reads only ``is_superadmin`` (getattr → False for a
        # key, which is the truth) and ``tenant_id``, so the key row resolves the
        # same entitlements its tenant's users get. Passing the key here rather
        # than writing a parallel resolver is what stops the two from drifting.
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
