"""What a signed-in person can do to their OWN account.

Self-service only — every route here resolves the caller and acts on that user. It
never takes a user id, which is what keeps it structurally incapable of the
cross-tenant mistakes the admin surfaces have to guard against by hand.

The 2FA routes here are the self-service half (enrol when you choose to); the
enforced-at-login half lives in `session.py`, because it runs on an MFA challenge
token before an access token exists.
"""

from __future__ import annotations

import uuid

from fastapi import Depends, File, UploadFile
from sqlalchemy.ext.asyncio import AsyncSession

from ...core.audit import record as audit_record
from ...core.errors import ValidationError
from ...core.logging import get_logger
from ...core.storage import get_storage
from ...db.base import get_db
from ...core.uploads import read_capped, validate_image
from ..deps import get_current_sid, get_current_user
from ..models import User
from ..schemas import (
    PreferencesIn,
    RecoveryCodesOut,
    SessionOut,
    TotpConfirmIn,
    TotpSetupOut,
    TotpStatusOut,
    UpdateMeIn,
    UserOut,
)
from ..service import AuthService

from ._shared import _user_out
from . import router


@router.get("/me", response_model=UserOut)
async def me(user: User = Depends(get_current_user)) -> UserOut:
    return await _user_out(user)


@router.post("/me/avatar", response_model=UserOut)
async def upload_avatar(
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> UserOut:
    """Upload/replace the current user's profile picture (self-service)."""
    from ...settings.service import SettingsService

    if not await SettingsService(db, user.tenant_id).get("allow_avatar_uploads"):
        raise ValidationError("Profile photo uploads are disabled by the administrator.")
    # read_capped, not file.read(): this route is open to ANY authenticated user, so
    # a bare read let anyone size core's next allocation. The cap now stops the read.
    data = await read_capped(file, field="Profile photo")
    # The extension comes from the validated content type, never from the uploaded
    # filename. It used to be os.path.splitext(file.filename), so any authenticated
    # user could store `x.html` under /files — which is served with no auth at all
    # and routed publicly — and be handed the URL in this response. Stored XSS on
    # the platform origin, self-service.
    ctype, ext = validate_image(data, file.content_type, field="Profile photo")
    key = f"avatars/{user.id}_{uuid.uuid4().hex}{ext}"
    await get_storage().put(key, data, ctype)
    old = user.avatar_key
    updated = await AuthService(db).set_avatar(user, key)
    if old and old != key:  # best-effort cleanup of the previous file
        try:
            await get_storage().delete(old)
        except Exception:  # pragma: no cover - cleanup is best-effort
            get_logger("auth").warning("failed to delete old avatar %s", old, exc_info=True)
    return await _user_out(updated)


@router.delete("/me/avatar", response_model=UserOut)
async def remove_avatar(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> UserOut:
    """Remove the current user's profile picture (falls back to initials)."""
    old = user.avatar_key
    updated = await AuthService(db).set_avatar(user, None)
    if old:
        try:
            await get_storage().delete(old)
        except Exception:  # pragma: no cover - cleanup is best-effort
            get_logger("auth").warning("failed to delete avatar %s", old, exc_info=True)
    return await _user_out(updated)


@router.patch("/me", response_model=UserOut)
async def update_me(
    data: UpdateMeIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> UserOut:
    """Self-service: the signed-in user edits their own profile."""
    return await _user_out(await AuthService(db).update_me(user, data))


@router.patch("/me/preferences", response_model=UserOut)
async def update_my_preferences(
    data: PreferencesIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> UserOut:
    """Merge the sent keys into the user's preferences (theme, notifications, …)."""
    return await _user_out(await AuthService(db).set_preferences(user, data.preferences))


@router.get("/me/sessions", response_model=list[SessionOut])
async def list_my_sessions(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
    sid: str | None = Depends(get_current_sid),
) -> list[SessionOut]:
    """The user's live sessions, flagging the one making this request."""
    out: list[SessionOut] = []
    for row in await AuthService(db).list_sessions(user.id):
        s = SessionOut.model_validate(row)
        s.current = sid is not None and str(row.id) == sid
        out.append(s)
    return out


@router.delete("/me/sessions/{session_id}", status_code=204)
async def revoke_my_session(
    session_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> None:
    """Sign out one of the user's own devices."""
    await AuthService(db).revoke_session(user.id, session_id)


@router.post("/me/sessions/revoke-others", status_code=204)
async def revoke_my_other_sessions(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
    sid: str | None = Depends(get_current_sid),
) -> None:
    """Sign out everywhere except the current device."""
    keep = uuid.UUID(sid) if sid else None
    await AuthService(db).revoke_other_sessions(user.id, keep)


# --- two-factor auth (self-service) ------------------------------------------
@router.get("/me/2fa", response_model=TotpStatusOut)
async def two_factor_status(user: User = Depends(get_current_user)) -> TotpStatusOut:
    return TotpStatusOut(
        enabled=user.totp_enabled,
        recovery_codes_remaining=len(user.mfa_recovery_codes or []),
    )


@router.post("/me/2fa/setup", response_model=TotpSetupOut)
async def two_factor_setup(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> TotpSetupOut:
    """Begin 2FA enrolment: returns the secret + otpauth URI to show as a QR code.
    Not active until confirmed with a valid code."""
    secret, uri = await AuthService(db).begin_totp_setup(user)
    return TotpSetupOut(secret=secret, otpauth_uri=uri)


@router.post("/me/2fa/confirm", response_model=RecoveryCodesOut)
async def two_factor_confirm(
    data: TotpConfirmIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> RecoveryCodesOut:
    """Verify the first code, enable 2FA, and return one-time recovery codes."""
    codes = await AuthService(db).confirm_totp_setup(user, data.code)
    await audit_record(
        db, actor=user, action="auth.2fa_enable", target_type="user", target_id=str(user.id),
    )
    return RecoveryCodesOut(recovery_codes=codes)


@router.post("/me/2fa/disable", status_code=204)
async def two_factor_disable(
    data: TotpConfirmIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> None:
    """Turn off 2FA (requires a current TOTP or a recovery code)."""
    await AuthService(db).disable_totp(user, data.code)
    await audit_record(
        db, actor=user, action="auth.2fa_disable", target_type="user", target_id=str(user.id),
    )


@router.post("/me/2fa/recovery-codes", response_model=RecoveryCodesOut)
async def two_factor_recovery_codes(
    data: TotpConfirmIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> RecoveryCodesOut:
    """Regenerate recovery codes (invalidates the old set)."""
    codes = await AuthService(db).regenerate_recovery_codes(user, data.code)
    return RecoveryCodesOut(recovery_codes=codes)


