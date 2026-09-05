"""Creating, editing and administering user accounts, plus the bootstrap admin.

The highest-risk surface in core: every method here takes a user id, and every one
needs an explicit ownership check. `scope.owns()` treating a NULL tenant_id as
"owned by everyone" turned exactly these into a tenant-to-platform privilege
escalation, because on `users` a NULL tenant_id is the SUPER-ADMIN. The `scope`
argument is not optional in spirit — passing None means "no isolation", which is
correct only on the bootstrap path.
"""


from __future__ import annotations

from ._constants import ADMIN_ROLE_NAME, _now


import datetime as dt
import uuid

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ...core.errors import ConflictError, NotFoundError
from ...tenancy.scope import Scope, assert_owned, scoped
from ..models import RefreshToken, Role, User
from ..permissions import WILDCARD
from ..schemas import CreateUserIn, UpdateMeIn, UpdateUserIn
from ..security import hash_password, validate_password, verify_password

class UsersMixin:
    """Part of :class:`AuthService`; see `services/__init__.py`."""

    db: AsyncSession

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

