"""AuthService — all auth business logic (DB writes commit explicitly).

Handles authentication, dynamic role CRUD, users, and API keys. Kept separate from
the router so it is unit-testable and reusable (CLI, startup bootstrap).
"""

from __future__ import annotations

import datetime as dt
import hmac
import uuid

import jwt
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.errors import ConflictError, NotFoundError, UnauthorizedError, ValidationError
from ..tenancy.scope import Scope, assert_owned, scoped
from .models import ApiKey, PasswordResetToken, RefreshToken, Role, User
from . import dynamic_permissions
from .permissions import PERMISSIONS, WILDCARD
from .schemas import (
    ApiKeyCreateIn,
    CreateRoleIn,
    CreateUserIn,
    UpdateMeIn,
    UpdateRoleIn,
    UpdateUserIn,
)
from .security import (
    REFRESH_TTL,
    api_key_prefix,
    create_access_token,
    create_api_key_token,
    create_mfa_challenge_token,
    create_refresh_token,
    decode_token,
    generate_api_key,
    generate_recovery_codes,
    generate_reset_token,
    generate_totp_secret,
    hash_api_key,
    hash_password,
    normalize_recovery_code,
    totp_provisioning_uri,
    validate_password,
    verify_password,
    verify_totp,
)

RESET_TTL = dt.timedelta(hours=1)

ADMIN_ROLE_NAME = "Administrator"


def _now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def _aware(value: dt.datetime) -> dt.datetime:
    """Coerce a DB datetime to UTC-aware (SQLite returns naive; Postgres aware)."""
    return value if value.tzinfo is not None else value.replace(tzinfo=dt.timezone.utc)


class AuthService:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    # --- authentication ----------------------------------------------------
    async def authenticate(self, email: str, password: str) -> User:
        from ..core.config import get_settings

        settings = get_settings()
        user = (
            await self.db.execute(select(User).where(User.email == email))
        ).scalar_one_or_none()
        if user is None or not user.is_active:
            raise UnauthorizedError("invalid email or password")
        # Per-account lockout: reject while locked (don't even check the password).
        if user.locked_until is not None and _aware(user.locked_until) > _now():
            raise UnauthorizedError("account temporarily locked after failed logins; try again later")
        if not verify_password(password, user.password_hash):
            user.failed_login_count = (user.failed_login_count or 0) + 1
            if (
                settings.lockout_max_attempts > 0
                and settings.lockout_minutes > 0
                and user.failed_login_count >= settings.lockout_max_attempts
            ):
                user.locked_until = _now() + dt.timedelta(minutes=settings.lockout_minutes)
            await self.db.commit()
            raise UnauthorizedError("invalid email or password")
        # Tenant gate: a tenant-scoped user cannot sign in while their organization
        # is suspended or its license has fully expired (super-admins bypass — they
        # have no tenant). Checked only after the password is verified.
        if user.tenant_id is not None and not user.is_superadmin:
            from ..tenancy.models import Tenant, effective_license_state

            tenant = await self.db.get(Tenant, user.tenant_id)
            if tenant is not None:
                if tenant.status != "active":
                    raise UnauthorizedError("your organization is suspended — contact support")
                if effective_license_state(tenant) == "expired":
                    raise UnauthorizedError(
                        "your organization's license has expired — contact support"
                    )
        # Success — clear the lockout counters and stamp the login.
        user.failed_login_count = 0
        user.locked_until = None
        user.last_login_at = _now()
        await self.db.commit()
        return user

    def _set_password(self, user: User, new: str) -> None:
        """Validate + apply a new password with reuse-prevention + timestamping.

        Blocks reuse of the current or last N passwords (config), records the
        change time (for expiry), and clears the force-change flag.
        """
        from ..core.config import get_settings

        validate_password(new)
        n = get_settings().password_history_count
        if n > 0:
            history = list(user.password_history or [])
            if verify_password(new, user.password_hash) or any(
                verify_password(new, h) for h in history
            ):
                raise ValidationError("password was used recently — choose a different one")
            history.insert(0, user.password_hash)  # archive the outgoing hash
            user.password_history = history[:n]
        user.password_hash = hash_password(new)
        user.password_changed_at = _now()
        user.must_change_password = False

    async def issue_tokens(
        self, user: User, *, user_agent: str | None = None, ip: str | None = None
    ) -> tuple[str, str]:
        """Issue an access token + a REVOCABLE refresh token (persisted by jti).

        The refresh token row doubles as a "session": it records the device
        (user_agent) and ip so the user can review and revoke it later.
        """
        jti = uuid.uuid4()
        self.db.add(
            RefreshToken(
                id=jti,
                user_id=user.id,
                expires_at=_now() + REFRESH_TTL,
                user_agent=user_agent,
                ip=ip,
                last_used_at=_now(),
            )
        )
        await self.db.commit()
        from ..tenancy.entitlements import token_entitlements

        features, limits, license_state, tenant_status = await token_entitlements(self.db, user)
        return (
            create_access_token(
                user, sid=str(jti), features=features, limits=limits,
                license_state=license_state, tenant_status=tenant_status,
            ),
            create_refresh_token(user, str(jti)),
        )

    async def refresh_access(self, refresh_token: str) -> str:
        try:
            payload = decode_token(refresh_token)
        except jwt.PyJWTError:
            raise UnauthorizedError("invalid or expired refresh token")
        if payload.get("type") != "refresh":
            raise UnauthorizedError("not a refresh token")
        jti = payload.get("jti")
        row = await self.db.get(RefreshToken, uuid.UUID(jti)) if jti else None
        if row is None or row.revoked_at is not None or _aware(row.expires_at) <= _now():
            raise UnauthorizedError("refresh token is invalid, expired, or revoked")
        user = await self.db.get(User, uuid.UUID(payload["sub"]))
        if user is None or not user.is_active:
            raise UnauthorizedError("user not found or inactive")
        # Touch the session so "last active" stays fresh in the sessions list.
        row.last_used_at = _now()
        await self.db.commit()
        from ..tenancy.entitlements import token_entitlements

        features, limits, license_state, tenant_status = await token_entitlements(self.db, user)
        return create_access_token(
            user, sid=str(row.id), features=features, limits=limits,
            license_state=license_state, tenant_status=tenant_status,
        )

    async def logout(self, refresh_token: str) -> None:
        """Revoke a single refresh token (idempotent; silently ignores bad tokens)."""
        try:
            payload = decode_token(refresh_token)
        except jwt.PyJWTError:
            return
        jti = payload.get("jti")
        row = await self.db.get(RefreshToken, uuid.UUID(jti)) if jti else None
        if row is not None and row.revoked_at is None:
            row.revoked_at = _now()
            await self.db.commit()

    async def revoke_all_refresh(self, user_id: uuid.UUID) -> None:
        """Revoke every live refresh token for a user (used after a password change)."""
        rows = (
            await self.db.execute(
                select(RefreshToken).where(
                    RefreshToken.user_id == user_id, RefreshToken.revoked_at.is_(None)
                )
            )
        ).scalars().all()
        for row in rows:
            row.revoked_at = _now()
        await self.db.commit()

    async def change_password(self, user: User, current: str, new: str) -> None:
        if not verify_password(current, user.password_hash):
            raise UnauthorizedError("current password is incorrect")
        self._set_password(user, new)
        await self.db.commit()
        await self.revoke_all_refresh(user.id)  # force re-login on other devices

    async def request_password_reset(self, email: str) -> tuple[User, str] | None:
        """Create a reset token if the email maps to an active user. Returns
        (user, raw_token) for the caller to email, or None (caller replies 200 either
        way so attackers can't probe which emails exist)."""
        user = (
            await self.db.execute(select(User).where(User.email == email))
        ).scalar_one_or_none()
        if user is None or not user.is_active:
            return None
        raw, token_hash = generate_reset_token()
        self.db.add(
            PasswordResetToken(user_id=user.id, token_hash=token_hash, expires_at=_now() + RESET_TTL)
        )
        await self.db.commit()
        return user, raw

    async def reset_password(self, token: str, new: str) -> None:
        row = (
            await self.db.execute(
                select(PasswordResetToken).where(PasswordResetToken.token_hash == hash_api_key(token))
            )
        ).scalar_one_or_none()
        if row is None or row.used_at is not None or _aware(row.expires_at) <= _now():
            raise ValidationError("invalid or expired reset token")
        user = await self.db.get(User, row.user_id)
        self._set_password(user, new)
        # Completing an emailed reset/invite link proves the user controls the inbox.
        user.email_verified = True
        # A successful reset also clears any brute-force lockout.
        user.failed_login_count = 0
        user.locked_until = None
        row.used_at = _now()
        await self.db.commit()
        await self.revoke_all_refresh(user.id)

    # --- two-factor auth (TOTP) -------------------------------------------
    def _check_mfa(self, user: User, code: str) -> bool:
        """True if ``code`` is a valid TOTP OR an unused recovery code.

        A matching recovery code is CONSUMED (removed from the list) as a side
        effect — the caller is responsible for committing the session.
        """
        from ..core.secrets import decrypt_secret

        if user.totp_secret and verify_totp(decrypt_secret(user.totp_secret), code):
            return True
        target = hash_api_key(normalize_recovery_code(code))
        codes = list(user.mfa_recovery_codes or [])
        if target in codes:
            codes.remove(target)
            user.mfa_recovery_codes = codes
            return True
        return False

    def issue_mfa_challenge(self, user: User) -> str:
        """First factor passed but 2FA is on — hand back a short-lived challenge
        token the client exchanges (with a TOTP/recovery code) for real tokens."""
        return create_mfa_challenge_token(user)

    async def verify_mfa_challenge(self, mfa_token: str, code: str) -> User:
        try:
            payload = decode_token(mfa_token)
        except jwt.PyJWTError:
            raise UnauthorizedError("invalid or expired 2FA session")
        if payload.get("type") != "mfa":
            raise UnauthorizedError("not a 2FA token")
        user = await self.db.get(User, uuid.UUID(payload["sub"]))
        if user is None or not user.is_active or not user.totp_enabled:
            raise UnauthorizedError("2FA session is no longer valid")
        if not self._check_mfa(user, code):
            raise UnauthorizedError("invalid authentication or recovery code")
        await self.db.commit()  # persist a consumed recovery code
        return user

    async def begin_totp_setup(self, user: User) -> tuple[str, str]:
        """Generate + stash a new (still-disabled) TOTP secret; return
        (secret, otpauth_uri) for the client to show as text + QR."""
        from ..core.config import get_settings
        from ..core.secrets import encrypt_secret

        secret = generate_totp_secret()
        user.totp_secret = encrypt_secret(secret)
        user.totp_enabled = False
        await self.db.commit()
        issuer = get_settings().app_name or "Vizor"
        return secret, totp_provisioning_uri(secret, user.email, issuer)

    async def confirm_totp_setup(self, user: User, code: str) -> list[str]:
        """Verify the first code against the pending secret, enable 2FA, and
        return freshly generated one-time recovery codes (shown once)."""
        from ..core.secrets import decrypt_secret

        if not user.totp_secret or user.totp_enabled:
            raise ValidationError("no pending 2FA setup — start setup first")
        if not verify_totp(decrypt_secret(user.totp_secret), code):
            raise ValidationError("invalid authentication code")
        user.totp_enabled = True
        raw, hashed = generate_recovery_codes()
        user.mfa_recovery_codes = hashed
        await self.db.commit()
        return raw

    async def disable_totp(self, user: User, code: str) -> None:
        if not user.totp_enabled:
            return
        if not self._check_mfa(user, code):
            raise UnauthorizedError("invalid authentication or recovery code")
        user.totp_enabled = False
        user.totp_secret = None
        user.mfa_recovery_codes = []
        await self.db.commit()

    async def regenerate_recovery_codes(self, user: User, code: str) -> list[str]:
        if not user.totp_enabled:
            raise ValidationError("2FA is not enabled")
        if not self._check_mfa(user, code):
            raise UnauthorizedError("invalid authentication or recovery code")
        raw, hashed = generate_recovery_codes()
        user.mfa_recovery_codes = hashed
        await self.db.commit()
        return raw

    # --- roles (dynamic RBAC) ---------------------------------------------
    async def create_role(self, data: CreateRoleIn, scope: Scope | None = None) -> Role:
        # Static catalog PLUS whatever satellites registered — a per-dataset
        # dashboard permission is grantable exactly like a built-in one.
        unknown = await dynamic_permissions.unknown(self.db, data.permissions)
        if unknown:
            raise ValidationError(f"unknown permissions: {unknown}")
        if WILDCARD in data.permissions:
            raise ValidationError("wildcard '*' is reserved for the system Administrator role")
        # Role.name carries a GLOBAL unique constraint (unchanged by 0007), so names
        # stay unique across the whole platform. (Per-tenant name reuse would need a
        # composite unique + migration; not required here.)
        if await self._role_by_name(data.name):
            raise ConflictError("a role with this name already exists")
        # A tenant-admin's roles are stamped with their tenant; a super-admin (no
        # scope, or a platform scope) creates a shared platform role (tenant_id NULL).
        tenant_id = None if scope is None or scope.is_platform else scope.tenant_id
        role = Role(
            name=data.name, description=data.description,
            permissions=list(data.permissions), tenant_id=tenant_id,
        )
        self.db.add(role)
        await self.db.commit()
        await self.db.refresh(role)
        return role

    async def update_role(self, role_id: uuid.UUID, data: UpdateRoleIn,
                          scope: Scope | None = None) -> Role:
        role = await self.db.get(Role, role_id)
        if role is None:
            raise NotFoundError("role not found")
        # Tenant isolation: a tenant-admin may only touch their own tenant's roles.
        # Shared system roles (tenant_id NULL) are read-only to tenant-admins anyway
        # (blocked by is_system below), and invisible-as-editable to other tenants.
        if scope is not None and not scope.is_platform and role.tenant_id != scope.tenant_id:
            raise NotFoundError("role not found")
        if role.is_system:
            raise ValidationError("the system Administrator role cannot be modified")
        if data.permissions is not None:
            unknown = await dynamic_permissions.unknown(self.db, data.permissions)
            if unknown:
                raise ValidationError(f"unknown permissions: {unknown}")
            if WILDCARD in data.permissions:
                raise ValidationError("wildcard '*' is reserved for the system role")
            role.permissions = list(data.permissions)
        if data.name is not None:
            role.name = data.name
        if data.description is not None:
            role.description = data.description
        await self.db.commit()
        await self.db.refresh(role)
        return role

    async def delete_role(self, role_id: uuid.UUID, scope: Scope | None = None) -> None:
        role = await self.db.get(Role, role_id)
        if role is None:
            raise NotFoundError("role not found")
        # A tenant-admin may only delete their own tenant's roles (a shared system
        # role has tenant_id NULL and is blocked by is_system regardless).
        if scope is not None and not scope.is_platform and role.tenant_id != scope.tenant_id:
            raise NotFoundError("role not found")
        if role.is_system:
            raise ValidationError("the system Administrator role cannot be deleted")
        in_use = await self.db.scalar(
            select(func.count()).select_from(User).where(User.role_id == role_id)
        )
        if in_use:
            raise ConflictError("role is assigned to users; reassign them first")
        await self.db.delete(role)
        await self.db.commit()

    def roles_query(self, scope: Scope | None = None):
        """Roles visible to the caller: their own tenant's roles + shared system
        roles (tenant_id NULL). Super-admins see every role."""
        stmt = select(Role).order_by(Role.name)
        if scope is not None and not scope.is_platform:
            # Own-tenant roles OR shared platform/system roles (NULL tenant).
            stmt = stmt.where(
                (Role.tenant_id == scope.tenant_id) | (Role.tenant_id.is_(None))
            )
        return stmt

    async def _role_by_name(self, name: str) -> Role | None:
        return (
            await self.db.execute(select(Role).where(Role.name == name))
        ).scalar_one_or_none()

    async def _require_role(self, role_id: uuid.UUID, scope: Scope | None = None) -> Role:
        role = await self.db.get(Role, role_id)
        if role is None:
            raise ValidationError("role_id does not reference an existing role")
        # A tenant-admin may only assign a role they can see: their own tenant's
        # roles or a shared system role (tenant_id NULL). Assigning another tenant's
        # role would leak/borrow its permissions, so it's rejected as invalid.
        if scope is not None and not scope.is_platform:
            if role.tenant_id is not None and role.tenant_id != scope.tenant_id:
                raise ValidationError("role_id does not reference an existing role")
        return role

    # --- users -------------------------------------------------------------
    async def create_user(self, data: CreateUserIn, scope: Scope | None = None) -> User:
        if (await self.db.execute(select(User).where(User.email == data.email))).scalar_one_or_none():
            raise ConflictError("email already registered")
        validate_password(data.password)
        await self._require_role(data.role_id, scope)
        # Multi-tenancy: decide the new user's tenant.
        #   * tenant-admin → FORCED into their own tenant (data.tenant_id ignored).
        #   * super-admin  → may target data.tenant_id (or None for a platform user).
        #   * no scope (bootstrap/import from a super-admin path) → data.tenant_id.
        if scope is not None and not scope.is_platform:
            tenant_id = scope.tenant_id  # tenant-admins can only create in-tenant
        else:
            tenant_id = data.tenant_id
        user = User(
            email=data.email,
            full_name=data.full_name,
            role_id=data.role_id,
            password_hash=hash_password(data.password),
            is_active=True if data.is_active is None else data.is_active,
            tenant_id=tenant_id,
            site_ids=list(data.site_ids or []),
            # A tenant-admin can NEVER mint a super-admin. Only a bootstrap/seed path
            # (no scope) promotes explicitly elsewhere (seed_tenancy). Always False here.
            is_superadmin=False,
        )
        self.db.add(user)
        await self.db.commit()
        await self.db.refresh(user)
        return user

    async def get_user(self, user_id: uuid.UUID, scope: Scope | None = None) -> User:
        """Fetch one user, enforcing tenant ownership (404 if in another tenant)."""
        user = await self.db.get(User, user_id)
        if user is None:
            raise NotFoundError("user not found")
        if scope is not None:
            assert_owned(user, scope, message="user not found")
        return user

    async def update_user(self, user_id: uuid.UUID, data: UpdateUserIn,
                          scope: Scope | None = None) -> User:
        user = await self.db.get(User, user_id)
        if user is None:
            raise NotFoundError("user not found")
        # Isolation: a tenant-admin can only update users in their own tenant.
        if scope is not None:
            assert_owned(user, scope, message="user not found")
        if data.role_id is not None:
            await self._require_role(data.role_id, scope)
            user.role_id = data.role_id
        if data.is_active is not None:
            user.is_active = data.is_active
        if data.full_name is not None:
            user.full_name = data.full_name
        if data.email is not None and data.email != user.email:
            taken = (
                await self.db.execute(
                    select(User).where(User.email == data.email, User.id != user.id)
                )
            ).scalar_one_or_none()
            if taken is not None:
                raise ConflictError("email already registered")
            user.email = data.email
            # A new address is an unproven inbox again — re-verification is the only
            # thing that says this person can actually receive mail there.
            user.email_verified = False
        # An admin-set password goes through the same gate as a self-service change
        # (policy + reuse history + timestamp); an empty/absent value changes nothing.
        password_set = bool(data.password)
        if password_set:
            self._set_password(user, data.password)
        if data.site_ids is not None:
            user.site_ids = list(data.site_ids)
        await self.db.commit()
        # Someone else now knows this password — every existing session must go.
        if password_set:
            await self.revoke_all_refresh(user.id)
        await self.db.refresh(user)
        return user

    # --- admin account actions (STQC / operational recovery) --------------
    async def _admin_target(self, user_id: uuid.UUID, scope: Scope | None) -> User:
        """Load a target user, enforcing tenant ownership (404 across tenants)."""
        user = await self.db.get(User, user_id)
        if user is None:
            raise NotFoundError("user not found")
        if scope is not None:
            assert_owned(user, scope, message="user not found")
        return user

    async def admin_lock_user(self, user_id: uuid.UUID, scope: Scope | None = None) -> User:
        """Manually lock an account: block sign-in until an admin unlocks it. Encoded
        as a far-future ``locked_until`` (the same field auto-lockout uses), so the
        existing login check enforces it with no new code path."""
        user = await self._admin_target(user_id, scope)
        user.locked_until = _now() + dt.timedelta(days=3650)
        await self.db.commit()
        await self.db.refresh(user)
        return user

    async def admin_unlock_user(self, user_id: uuid.UUID, scope: Scope | None = None) -> User:
        """Clear a lock (manual or brute-force) and reset the failed-attempt counter."""
        user = await self._admin_target(user_id, scope)
        user.locked_until = None
        user.failed_login_count = 0
        await self.db.commit()
        await self.db.refresh(user)
        return user

    async def admin_reset_mfa(self, user_id: uuid.UUID, scope: Scope | None = None) -> User:
        """Disable a user's TOTP second factor (lost-device recovery). If a security
        policy requires 2FA, they'll be forced to re-enrol at next login."""
        user = await self._admin_target(user_id, scope)
        user.totp_enabled = False
        user.totp_secret = None
        user.mfa_recovery_codes = []
        await self.db.commit()
        await self.db.refresh(user)
        return user

    async def admin_revoke_sessions(self, user_id: uuid.UUID, scope: Scope | None = None) -> User:
        """Force sign-out: revoke every live refresh token for the target user."""
        user = await self._admin_target(user_id, scope)
        await self.revoke_all_refresh(user.id)
        return user

    async def clone_user(self, user_id: uuid.UUID, data, scope: Scope | None = None) -> User:
        """Create a new user inheriting the source's role, status and site scope.
        Identity is fresh (new email/name); a random password is set — the new user
        chooses their own via the emailed invite, so no credential is ever copied."""
        src = await self._admin_target(user_id, scope)
        if (await self.db.execute(select(User).where(User.email == data.email))).scalar_one_or_none():
            raise ConflictError("email already registered")
        import secrets as _secrets

        user = User(
            email=data.email,
            full_name=data.full_name,
            role_id=src.role_id,
            password_hash=hash_password(_secrets.token_urlsafe(16) + "aA1!"),
            is_active=src.is_active,
            tenant_id=src.tenant_id,
            site_ids=list(src.site_ids or []),
            is_superadmin=False,
        )
        self.db.add(user)
        await self.db.commit()
        await self.db.refresh(user)
        return user

    async def active_session_counts(self, user_ids: list[uuid.UUID]) -> dict[uuid.UUID, int]:
        """Map user_id → count of live (non-revoked, unexpired) sessions, in one query."""
        if not user_ids:
            return {}
        rows = (
            await self.db.execute(
                select(RefreshToken.user_id, func.count())
                .where(
                    RefreshToken.user_id.in_(user_ids),
                    RefreshToken.revoked_at.is_(None),
                    RefreshToken.expires_at > _now(),
                )
                .group_by(RefreshToken.user_id)
            )
        ).all()
        return {uid: n for uid, n in rows}

    # --- roles: clone -----------------------------------------------------
    async def clone_role(self, role_id: uuid.UUID, name: str, scope: Scope | None = None) -> Role:
        """Copy a role's permissions + description under a new name (own tenant)."""
        src = await self.db.get(Role, role_id)
        if src is None:
            raise NotFoundError("role not found")
        if scope is not None and not scope.is_platform and src.tenant_id not in (None, scope.tenant_id):
            raise NotFoundError("role not found")
        if await self._role_by_name(name):
            raise ConflictError("a role with this name already exists")
        tenant_id = None if scope is None or scope.is_platform else scope.tenant_id
        # Never carry the wildcard into a custom clone (reserved for the system role).
        perms = [p for p in (src.permissions or []) if p != WILDCARD]
        role = Role(
            name=name,
            description=(src.description or None),
            permissions=perms,
            tenant_id=tenant_id,
        )
        self.db.add(role)
        await self.db.commit()
        await self.db.refresh(role)
        return role

    def users_query(self, scope: Scope):
        """Users list, optionally scoped to a single tenant.

        Takes the caller's Scope, not a bare tenant_id, and delegates to
        ``scoped()``. The bare-tenant_id version could not express the difference
        between "super-admin, no filter" and "a caller whose own tenant_id is NULL",
        because both arrived as None — so a non-superadmin platform user got the
        whole platform's directory. Scope carries ``is_superadmin`` separately and
        cannot be flattened that way.

        (v1 shared-DB row-scoping; DB-per-tenant would drop the filter since each
        tenant DB only holds its own users.)
        """
        return scoped(select(User).order_by(User.created_at.desc()), User, scope)

    async def delete_user(self, user_id: uuid.UUID, scope: Scope | None = None) -> User:
        """Hard-delete a user. Refresh/reset tokens cascade automatically."""
        user = await self.db.get(User, user_id)
        if user is None:
            raise NotFoundError("user not found")
        # Isolation: a tenant-admin can only delete users in their own tenant.
        if scope is not None:
            assert_owned(user, scope, message="user not found")
        await self.db.delete(user)
        await self.db.commit()
        return user

    def verify_actor_password(self, actor: User, password: str) -> bool:
        """Confirm the acting admin re-entered their own password (for sensitive ops)."""
        return verify_password(password, actor.password_hash)

    async def set_avatar(self, user: User, key: str | None) -> User:
        """Point a user at a new avatar storage key (or None to clear it)."""
        user.avatar_key = key
        await self.db.commit()
        await self.db.refresh(user)
        return user

    # --- self-service account -------------------------------------------------
    async def update_me(self, user: User, data: UpdateMeIn) -> User:
        """Let the signed-in user edit their own profile (name for now)."""
        if data.full_name is not None:
            user.full_name = data.full_name
        await self.db.commit()
        await self.db.refresh(user)
        return user

    async def set_preferences(self, user: User, prefs: dict) -> User:
        """Shallow-merge ``prefs`` into the user's preferences (only sent keys change)."""
        user.preferences = {**(user.preferences or {}), **prefs}
        await self.db.commit()
        await self.db.refresh(user)
        return user

    async def list_sessions(self, user_id: uuid.UUID) -> list[RefreshToken]:
        """Live (non-revoked) sessions for a user, most-recently-active first."""
        rows = (
            await self.db.execute(
                select(RefreshToken)
                .where(RefreshToken.user_id == user_id, RefreshToken.revoked_at.is_(None))
                .order_by(RefreshToken.created_at.desc())
            )
        ).scalars().all()
        return list(rows)

    async def revoke_session(self, user_id: uuid.UUID, session_id: uuid.UUID) -> None:
        """Revoke one of the user's own sessions (idempotent)."""
        row = await self.db.get(RefreshToken, session_id)
        if row is None or row.user_id != user_id:
            raise NotFoundError("session not found")
        if row.revoked_at is None:
            row.revoked_at = _now()
            await self.db.commit()

    async def revoke_other_sessions(self, user_id: uuid.UUID, keep_id: uuid.UUID | None) -> int:
        """Revoke all of a user's sessions except ``keep_id``. Returns the count."""
        rows = (
            await self.db.execute(
                select(RefreshToken).where(
                    RefreshToken.user_id == user_id, RefreshToken.revoked_at.is_(None)
                )
            )
        ).scalars().all()
        n = 0
        for row in rows:
            if keep_id is not None and row.id == keep_id:
                continue
            row.revoked_at = _now()
            n += 1
        if n:
            await self.db.commit()
        return n

    # --- bootstrap ---------------------------------------------------------
    async def user_count(self) -> int:
        return int(await self.db.scalar(select(func.count()).select_from(User)) or 0)

    async def ensure_admin(
        self, email: str, password: str, full_name: str = "Administrator"
    ) -> User | None:
        """Create the built-in Administrator role + first admin if there are no users."""
        if await self.db.scalar(select(func.count()).select_from(User)):
            return None
        role = await self._role_by_name(ADMIN_ROLE_NAME)
        if role is None:
            role = Role(
                name=ADMIN_ROLE_NAME,
                description="Full access (system role)",
                permissions=[WILDCARD],
                is_system=True,
            )
            self.db.add(role)
            await self.db.commit()
            await self.db.refresh(role)
        admin = await self.create_user(
            CreateUserIn(
                email=email, password=password, full_name=full_name or "Administrator",
                role_id=role.id,
            )
        )
        # The bootstrap admin is trusted — mark it verified.
        admin.email_verified = True
        await self.db.commit()
        await self.db.refresh(admin)
        return admin

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
        from ..tenancy.entitlements import token_entitlements

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
