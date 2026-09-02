"""SecurityService — business logic for the enterprise security surface (P6-D).

Groups four concerns behind one service:
  * SecurityPolicy   — per-tenant 2FA-enforcement (read/update + a login-time gate).
  * DirectoryConfig  — LDAP/AD config CRUD + a sync/login-bind path (client injected).
  * SsoConfig        — OIDC config CRUD + the auth-code exchange → provision path.
  * DualAuthRequest  — the four-eyes ledger (request / approve / deny / consume).

All reads/writes are tenant-scoped via ``tenancy.scope``; secrets are encrypted at
rest via ``core.secrets``. DB writes commit explicitly (matching AuthService).
"""

from __future__ import annotations

import datetime as dt
import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth.models import Role, User
from ..auth.security import hash_password
from ..core.errors import ConflictError, NotFoundError, UnauthorizedError, ValidationError
from ..core.secrets import decrypt_secret, encrypt_secret
from ..tenancy.scope import Scope
from .ldap_client import LdapClient, LdapEntry, LdapError, build_client
from .models import DirectoryConfig, DualAuthRequest, SecurityPolicy, SsoConfig
from .oidc_client import HttpLike, HttpxAdapter, OidcClaims, exchange_code, fetch_discovery


def _now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def _aware(v: dt.datetime | None) -> dt.datetime | None:
    if v is None:
        return None
    return v if v.tzinfo is not None else v.replace(tzinfo=dt.timezone.utc)


class SecurityService:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    # === Security policy (2FA enforcement) ================================
    async def _policy_row(self, tenant_id: uuid.UUID | None) -> SecurityPolicy | None:
        return (
            await self.db.execute(
                select(SecurityPolicy).where(SecurityPolicy.tenant_id == tenant_id)
            )
        ).scalar_one_or_none()

    async def get_policy(self, scope: Scope) -> SecurityPolicy:
        """The caller's effective policy row (creating an in-memory default if none).

        A super-admin edits the platform-default (tenant_id NULL); a tenant-admin
        edits their own tenant's row.
        """
        tenant_id = None if scope.is_platform else scope.tenant_id
        row = await self._policy_row(tenant_id)
        if row is not None:
            return row
        # No stored row yet — return a transient default with concrete (non-None)
        # values so it serialises cleanly (server_defaults only fill on flush).
        return SecurityPolicy(
            tenant_id=tenant_id, require_2fa=False, require_2fa_roles=[], session_idle_minutes=0
        )

    async def update_policy(self, scope: Scope, data) -> SecurityPolicy:
        tenant_id = None if scope.is_platform else scope.tenant_id
        row = await self._policy_row(tenant_id)
        if row is None:
            row = SecurityPolicy(tenant_id=tenant_id)
            self.db.add(row)
        if data.require_2fa is not None:
            row.require_2fa = data.require_2fa
        if data.require_2fa_roles is not None:
            row.require_2fa_roles = list(data.require_2fa_roles)
        if data.session_idle_minutes is not None:
            row.session_idle_minutes = max(0, int(data.session_idle_minutes))
        await self.db.commit()
        await self.db.refresh(row)
        return row

    async def user_must_enroll_2fa(self, user: User) -> bool:
        """True if policy REQUIRES 2FA for this user but they haven't enrolled.

        Called at login (after the password passes). Super-admins fall under the
        platform-default policy (tenant_id NULL) unless overridden by
        ``require_superadmin_2fa`` in config (handled by the deps layer).
        """
        if user.totp_enabled:
            return False
        policy = await self._policy_row(user.tenant_id)
        if policy is None or not policy.require_2fa:
            return False
        roles = policy.require_2fa_roles or []
        if roles:
            role_name = getattr(getattr(user, "role", None), "name", None)
            return role_name in roles
        return True

    # === LDAP / AD directory =============================================
    async def get_directory(self, scope: Scope) -> DirectoryConfig | None:
        tenant_id = None if scope.is_platform else scope.tenant_id
        return (
            await self.db.execute(
                select(DirectoryConfig).where(DirectoryConfig.tenant_id == tenant_id)
            )
        ).scalar_one_or_none()

    async def upsert_directory(self, scope: Scope, data) -> DirectoryConfig:
        tenant_id = None if scope.is_platform else scope.tenant_id
        row = await self.get_directory(scope)
        if row is None:
            row = DirectoryConfig(tenant_id=tenant_id, server_uri=data.server_uri,
                                  base_dn=data.base_dn, bind_dn=data.bind_dn)
            self.db.add(row)
        row.name = data.name
        row.enabled = data.enabled
        row.server_uri = data.server_uri
        row.base_dn = data.base_dn
        row.bind_dn = data.bind_dn
        # Only re-encrypt if a new secret was supplied (blank keeps the stored one).
        if data.bind_password:
            row.bind_password = encrypt_secret(data.bind_password)
        row.use_ssl = data.use_ssl
        row.user_dn_base = data.user_dn_base
        row.user_filter = data.user_filter
        row.email_attr = data.email_attr
        row.name_attr = data.name_attr
        row.group_attr = data.group_attr
        row.group_role_map = dict(data.group_role_map or {})
        row.default_role = data.default_role
        await self.db.commit()
        await self.db.refresh(row)
        return row

    async def delete_directory(self, scope: Scope) -> None:
        row = await self.get_directory(scope)
        if row is None:
            raise NotFoundError("no directory configured")
        await self.db.delete(row)
        await self.db.commit()

    def _map_role_name(self, groups: list[str], group_role_map: dict, default_role: str | None) -> str | None:
        """Resolve a core role NAME from directory groups via the config map."""
        for g in groups or []:
            # match on full DN or on a CN=... fragment (case-insensitive)
            for key, role_name in (group_role_map or {}).items():
                if key.lower() == g.lower() or key.lower() in g.lower():
                    return role_name
        return default_role

    async def _role_by_name(self, name: str, tenant_id: uuid.UUID | None) -> Role | None:
        return (
            await self.db.execute(select(Role).where(Role.name == name))
        ).scalar_one_or_none()

    async def _provision_from_entry(
        self, entry: LdapEntry, cfg: DirectoryConfig, tenant_id: uuid.UUID | None
    ) -> tuple[str, bool]:
        """Create/update a core user from an LDAP entry. Returns (status, created)."""
        if not entry.email:
            return "skipped", False
        role_name = self._map_role_name(entry.groups, cfg.group_role_map, cfg.default_role)
        if role_name is None:
            return "skipped", False
        role = await self._role_by_name(role_name, tenant_id)
        if role is None:
            return "skipped", False
        existing = (
            await self.db.execute(select(User).where(User.email == entry.email))
        ).scalar_one_or_none()
        if existing is not None:
            # Keep the directory as the source of truth for name + role.
            existing.full_name = entry.display_name or existing.full_name
            existing.role_id = role.id
            return "updated", False
        user = User(
            email=entry.email,
            full_name=entry.display_name,
            role_id=role.id,
            # Directory-authenticated: no local password is ever used, but the column
            # is NOT NULL, so store a random unusable hash.
            password_hash=hash_password(uuid.uuid4().hex),
            tenant_id=tenant_id,
            email_verified=True,
            is_active=True,
        )
        self.db.add(user)
        return "created", True

    async def sync_directory(self, scope: Scope, client: LdapClient | None = None):
        """Sync users/groups from the directory into core roles.

        ``client`` is injectable — tests pass a FakeLdapClient. In production it is
        built from the stored config (LIVE-VALIDATE: needs the ldap3 extra + a real
        server). Returns a SyncResult-shaped dict.
        """
        from .schemas import DirectorySyncResult

        cfg = await self.get_directory(scope)
        if cfg is None:
            raise NotFoundError("no directory configured")
        tenant_id = None if scope.is_platform else scope.tenant_id
        live = client is None
        if client is None:
            client = build_client(cfg, decrypt_secret(cfg.bind_password) if cfg.bind_password else None)
        try:
            entries = client.search_users()
        except LdapError as exc:
            raise ValidationError(f"directory search failed: {exc}")
        created = updated = skipped = 0
        errors: list[dict] = []
        for e in entries:
            try:
                status, _ = await self._provision_from_entry(e, cfg, tenant_id)
                if status == "created":
                    created += 1
                elif status == "updated":
                    updated += 1
                else:
                    skipped += 1
            except Exception as exc:  # noqa: BLE001
                skipped += 1
                errors.append({"dn": e.dn, "error": str(exc)})
        cfg.last_sync_at = _now()
        await self.db.commit()
        return DirectorySyncResult(
            created=created, updated=updated, skipped=skipped, errors=errors, live=live
        )

    async def ldap_authenticate(
        self, cfg: DirectoryConfig, username: str, password: str, client: LdapClient | None = None
    ) -> User:
        """Bind the user against LDAP, provision/update them, and return the core User.

        Used by an LDAP-backed login. ``client`` injectable for tests.
        """
        tenant_id = cfg.tenant_id
        if client is None:
            client = build_client(cfg, decrypt_secret(cfg.bind_password) if cfg.bind_password else None)
        try:
            entry = client.authenticate(username, password)
        except LdapError as exc:
            raise UnauthorizedError(f"directory login failed: {exc}")
        status, _ = await self._provision_from_entry(entry, cfg, tenant_id)
        if status == "skipped":
            raise UnauthorizedError("no matching role mapping for this directory user")
        await self.db.commit()
        user = (
            await self.db.execute(select(User).where(User.email == entry.email))
        ).scalar_one_or_none()
        if user is None:
            raise UnauthorizedError("directory login could not resolve a user")
        return user

    # === OIDC SSO ========================================================
    async def get_sso(self, scope: Scope) -> SsoConfig | None:
        tenant_id = None if scope.is_platform else scope.tenant_id
        return (
            await self.db.execute(select(SsoConfig).where(SsoConfig.tenant_id == tenant_id))
        ).scalar_one_or_none()

    async def get_sso_for_tenant(self, tenant_id: uuid.UUID | None) -> SsoConfig | None:
        return (
            await self.db.execute(select(SsoConfig).where(SsoConfig.tenant_id == tenant_id))
        ).scalar_one_or_none()

    async def upsert_sso(self, scope: Scope, data) -> SsoConfig:
        tenant_id = None if scope.is_platform else scope.tenant_id
        row = await self.get_sso(scope)
        if row is None:
            row = SsoConfig(tenant_id=tenant_id, issuer=data.issuer, client_id=data.client_id)
            self.db.add(row)
        row.provider = data.provider
        row.enabled = data.enabled
        row.issuer = data.issuer
        row.client_id = data.client_id
        if data.client_secret:
            row.client_secret = encrypt_secret(data.client_secret)
        row.scopes = data.scopes
        row.redirect_uri = data.redirect_uri
        row.email_claim = data.email_claim
        row.name_claim = data.name_claim
        row.groups_claim = data.groups_claim
        row.group_role_map = dict(data.group_role_map or {})
        row.default_role = data.default_role
        row.auto_provision = data.auto_provision
        await self.db.commit()
        await self.db.refresh(row)
        return row

    async def delete_sso(self, scope: Scope) -> None:
        row = await self.get_sso(scope)
        if row is None:
            raise NotFoundError("no SSO configured")
        await self.db.delete(row)
        await self.db.commit()

    async def sso_exchange(
        self, cfg: SsoConfig, code: str, http: HttpLike | None = None
    ) -> User:
        """Complete the OIDC auth-code flow → provision/match a core user.

        ``http`` is injectable — tests pass a mock IdP; production uses httpx.
        Returns the resolved core User (the router then issues the core JWT).
        """
        http = http or HttpxAdapter()
        discovery = await fetch_discovery(http, cfg.issuer)
        secret = decrypt_secret(cfg.client_secret) if cfg.client_secret else None
        claims: OidcClaims = await exchange_code(http, discovery, cfg, code, secret)
        return await self._provision_from_claims(claims, cfg)

    async def _provision_from_claims(self, claims: OidcClaims, cfg: SsoConfig) -> User:
        tenant_id = cfg.tenant_id
        existing = (
            await self.db.execute(select(User).where(User.email == claims.email))
        ).scalar_one_or_none()
        role_name = self._map_role_name(claims.groups or [], cfg.group_role_map, cfg.default_role)
        role = await self._role_by_name(role_name, tenant_id) if role_name else None
        if existing is not None:
            if role is not None:
                existing.role_id = role.id
            if claims.name:
                existing.full_name = claims.name
            await self.db.commit()
            return existing
        if not cfg.auto_provision:
            raise UnauthorizedError("SSO user is not provisioned and auto-provisioning is off")
        if role is None:
            raise UnauthorizedError("SSO login has no role mapping — cannot provision user")
        user = User(
            email=claims.email,
            full_name=claims.name,
            role_id=role.id,
            password_hash=hash_password(uuid.uuid4().hex),
            tenant_id=tenant_id,
            email_verified=True,
            is_active=True,
        )
        self.db.add(user)
        await self.db.commit()
        await self.db.refresh(user)
        return user

    # === Dual authorization (four-eyes) ==================================
    async def create_dual_auth(self, actor: User, data) -> DualAuthRequest:
        expires_at = None
        if data.expires_in_minutes:
            expires_at = _now() + dt.timedelta(minutes=int(data.expires_in_minutes))
        req = DualAuthRequest(
            tenant_id=actor.tenant_id,
            action=data.action,
            target_type=data.target_type,
            target_id=data.target_id,
            reason=data.reason,
            payload=dict(data.payload or {}),
            status="pending",
            requested_by=actor.id,
            requested_by_email=actor.email,
            expires_at=expires_at,
        )
        self.db.add(req)
        await self.db.commit()
        await self.db.refresh(req)
        return req

    async def get_dual_auth(self, scope: Scope, req_id: uuid.UUID) -> DualAuthRequest:
        req = await self.db.get(DualAuthRequest, req_id)
        if req is None:
            raise NotFoundError("request not found")
        if not scope.is_platform and req.tenant_id != scope.tenant_id:
            raise NotFoundError("request not found")
        return req

    def _expired(self, req: DualAuthRequest) -> bool:
        exp = _aware(req.expires_at)
        return exp is not None and exp <= _now()

    async def decide_dual_auth(
        self, approver: User, scope: Scope, req_id: uuid.UUID, approve: bool, note: str | None
    ) -> DualAuthRequest:
        req = await self.get_dual_auth(scope, req_id)
        if req.status != "pending":
            raise ConflictError(f"request is already {req.status}")
        if self._expired(req):
            req.status = "expired"
            await self.db.commit()
            raise ConflictError("request has expired")
        # FOUR-EYES: the approver must be someone OTHER than the requester.
        if req.requested_by is not None and approver.id == req.requested_by:
            raise ValidationError("a request cannot be approved by its own requester")
        req.status = "approved" if approve else "denied"
        req.decided_by = approver.id
        req.decided_by_email = approver.email
        req.decided_at = _now()
        req.decision_note = note
        await self.db.commit()
        await self.db.refresh(req)
        return req

    async def check_and_consume(
        self, scope: Scope, action: str, target_id: str | None, req_id: uuid.UUID
    ) -> DualAuthRequest:
        """Verify a request is APPROVED + matches the action/target, then CONSUME it.

        This is the primitive a sensitive endpoint (in core OR vision) calls right
        before performing the action, so an approval can't be replayed for a
        different action or used twice.
        """
        req = await self.get_dual_auth(scope, req_id)
        if req.status == "consumed":
            raise ConflictError("approval has already been used")
        if req.status != "approved":
            raise UnauthorizedError("action is not approved")
        if self._expired(req):
            req.status = "expired"
            await self.db.commit()
            raise UnauthorizedError("approval has expired")
        if req.action != action:
            raise ValidationError("approval does not match this action")
        if target_id is not None and req.target_id not in (None, target_id):
            raise ValidationError("approval does not match this target")
        req.status = "consumed"
        await self.db.commit()
        await self.db.refresh(req)
        return req

    def list_dual_auth_query(self, scope: Scope, status: str | None = None):
        stmt = select(DualAuthRequest).order_by(DualAuthRequest.created_at.desc())
        if not scope.is_platform:
            stmt = stmt.where(DualAuthRequest.tenant_id == scope.tenant_id)
        if status:
            stmt = stmt.where(DualAuthRequest.status == status)
        return stmt
