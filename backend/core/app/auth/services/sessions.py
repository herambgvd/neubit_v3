"""Signing in, issuing and revoking tokens, and changing a password.

Everything that decides WHETHER someone is who they say they are, and everything
that ends that decision. `_set_password` lives here rather than with the user
admin because the policy it enforces — strength, reuse history, the timestamp
that invalidates older sessions — is the same whether a person changes their own
password or an admin resets it, and two copies of that would drift.
"""


from __future__ import annotations

from ._constants import RESET_TTL, _aware, _now


import datetime as dt
import uuid

import jwt
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ...core.errors import UnauthorizedError, ValidationError
from ..models import PasswordResetToken, RefreshToken, User
from ..security import (
    REFRESH_TTL,
    create_access_token,
    create_refresh_token,
    decode_token,
    generate_reset_token,
    hash_api_key,
    hash_password,
    validate_password,
    verify_password,
)

class SessionMixin:
    """Part of :class:`AuthService`; see `services/__init__.py`."""

    db: AsyncSession

    # --- authentication ----------------------------------------------------
    async def authenticate(self, email: str, password: str) -> User:
        from ...core.config import get_settings

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
            from ...tenancy.models import Tenant, effective_license_state

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
        from ...core.config import get_settings

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
        from ...tenancy.entitlements import token_entitlements

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
        from ...tenancy.entitlements import token_entitlements

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

