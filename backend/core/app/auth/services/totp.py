"""The second factor: enrolment, verification, recovery codes.

Seeds are encrypted at rest under the owning TENANT's key (`core/secrets.py`), and
recovery codes are stored hashed — a recovery code is a password, and a list of
them in plaintext is a list of passwords.
"""


from __future__ import annotations


import uuid

import jwt
from sqlalchemy.ext.asyncio import AsyncSession

from ...core.errors import UnauthorizedError, ValidationError
from ..models import User
from ..security import (
    create_mfa_challenge_token,
    decode_token,
    generate_recovery_codes,
    generate_totp_secret,
    hash_api_key,
    normalize_recovery_code,
    totp_provisioning_uri,
    verify_totp,
)

class TotpMixin:
    """Part of :class:`AuthService`; see `services/__init__.py`."""

    db: AsyncSession

    # --- two-factor auth (TOTP) -------------------------------------------
    def _check_mfa(self, user: User, code: str) -> bool:
        """True if ``code`` is a valid TOTP OR an unused recovery code.

        A matching recovery code is CONSUMED (removed from the list) as a side
        effect — the caller is responsible for committing the session.
        """
        from ...core.secrets import decrypt_secret_for

        if user.totp_secret and verify_totp(
            decrypt_secret_for(user.tenant_id, user.totp_secret), code
        ):
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
        from ...core.config import get_settings
        from ...core.secrets import encrypt_secret_for

        secret = generate_totp_secret()
        # A TOTP seed is the user's second factor and the user belongs to a tenant,
        # so it is encrypted under that tenant's key like every other tenant-owned
        # secret. A platform user (tenant_id NULL) gets the platform key.
        user.totp_secret = encrypt_secret_for(user.tenant_id, secret)
        user.totp_enabled = False
        await self.db.commit()
        issuer = get_settings().app_name or "Vizor"
        return secret, totp_provisioning_uri(secret, user.email, issuer)

    async def confirm_totp_setup(self, user: User, code: str) -> list[str]:
        """Verify the first code against the pending secret, enable 2FA, and
        return freshly generated one-time recovery codes (shown once)."""
        from ...core.secrets import decrypt_secret_for

        if not user.totp_secret or user.totp_enabled:
            raise ValidationError("no pending 2FA setup — start setup first")
        if not verify_totp(decrypt_secret_for(user.tenant_id, user.totp_secret), code):
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

