"""Auth API: session + permission catalog + dynamic roles + users + service API keys.

Mounted always-on via ``create_app(registry, extra_routers=[auth.router])``.
Access is permission-gated (require_permission), never role-name-gated.
"""

from __future__ import annotations

import csv
import datetime as _dtmod
import io
import os
import secrets
import uuid

from fastapi import APIRouter, Body, Depends, File, Request, Response, UploadFile
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.audit import record as audit_record
from ..core.config import get_settings
from ..core.errors import UnauthorizedError, ValidationError
from ..core.logging import get_logger
from ..core.pagination import Page, PageParams, page_params, paginate
from ..core.ratelimit import api_key_rate_limit, login_rate_limit
from ..core.storage import get_storage
from ..db.base import get_db
from ..core.uploads import validate_image
from ..tenancy.features import require_tenant_active
from ..tenancy.scope import scope_of, scoped
from .cookies import clear_refresh_cookie, set_refresh_cookie
from .deps import (
    get_current_sid,
    get_current_user,
    require_permission,
    require_service_permission,
)
from .models import User
from . import dynamic_permissions
from .permissions import PERMISSIONS, CorePerm
from .schemas import (
    AccessOut,
    ApiKeyCreatedOut,
    ApiKeyCreateIn,
    ApiKeyOut,
    ApiKeyTokenIn,
    ApiKeyTokenOut,
    ChangePasswordIn,
    CloneRoleIn,
    CloneUserIn,
    ConfirmPasswordIn,
    CreateRoleIn,
    CreateUserIn,
    ForgotPasswordIn,
    LoginIn,
    LoginResult,
    LogoutIn,
    MfaLoginIn,
    PreferencesIn,
    RecoveryCodesOut,
    RefreshIn,
    ResetPasswordIn,
    RoleOut,
    SessionOut,
    SetupIn,
    TokenOut,
    TotpConfirmIn,
    TotpSetupOut,
    TotpStatusOut,
    UpdateMeIn,
    UpdateRoleIn,
    UpdateUserIn,
    UserOut,
)
from .service import AuthService

router = APIRouter(prefix="/auth", tags=["auth"])

#: The ADMIN surface of /auth — permissions, roles, users, API keys — split from the
#: self-service surface (/me, /login, /logout, /refresh, 2FA) purely so it can carry
#: `require_tenant_active`.
#:
#: A suspended tenant, or one past its licence grace window, must not keep managing
#: users and minting API keys; but its people must still be able to sign in far
#: enough to be TOLD they are suspended, and to sign out. One router could not
#: express both, and app/app.py can only guard whole routers — so the split IS the
#: distinction rather than a comment describing one.
#:
#: `/auth/token` (exchanging a raw API key for a JWT) stays on the self-service
#: router: the token it returns is refused by every guarded route anyway, and
#: failing at the point of use gives the caller the reason instead of a bare 401.
admin_router = APIRouter(dependencies=[Depends(require_tenant_active())])


def _now_utc() -> _dtmod.datetime:
    return _dtmod.datetime.now(_dtmod.timezone.utc)


async def _user_out(user: User, active_sessions: int = 0) -> UserOut:
    """Serialise a User, resolving its avatar_key → a fetchable avatar_url and
    deriving the ``locked`` flag from ``locked_until``.

    The DB holds a storage *key*; the client needs a *URL*. We resolve it here at
    response time via the storage backend (a stable local URL or a presigned S3
    link), exactly like branding does for its logo. No avatar => avatar_url None.
    The security-posture fields (failed_login_count, locked_until,
    password_changed_at, site_ids, totp_enabled) map straight off the model.
    """
    out = UserOut.model_validate(user)
    out.avatar_url = await get_storage().url(user.avatar_key) if user.avatar_key else None
    lu = user.locked_until
    if lu is not None and lu.tzinfo is None:
        lu = lu.replace(tzinfo=_dtmod.timezone.utc)
    out.locked = bool(lu and lu > _now_utc())
    out.active_sessions = active_sessions
    return out


# --- session -----------------------------------------------------------------
def _client_ip(request: Request) -> str | None:
    """Best-effort client IP: first X-Forwarded-For hop if proxied, else peer."""
    xff = request.headers.get("x-forwarded-for")
    if xff:
        return xff.split(",")[0].strip()
    return request.client.host if request.client else None


@router.get("/setup-status")
async def setup_status(db: AsyncSession = Depends(get_db)) -> dict:
    """PUBLIC — whether the deployment still needs its first administrator."""
    return {"needs_setup": (await AuthService(db).user_count()) == 0}


@router.post("/setup", response_model=TokenOut, status_code=201)
async def setup(
    data: SetupIn,
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
) -> TokenOut:
    """PUBLIC, one-time — create the first administrator and sign them in.

    Refuses once any user exists, so it can never be used to escalate later.
    """
    svc = AuthService(db)
    admin = await svc.ensure_admin(data.email, data.password, data.full_name or "Administrator")
    if admin is None:
        raise ValidationError("Setup has already been completed.")
    access, refresh = await svc.issue_tokens(
        admin, user_agent=request.headers.get("user-agent"), ip=_client_ip(request)
    )
    set_refresh_cookie(response, refresh)
    await audit_record(
        db, actor=admin, action="auth.setup", target_type="user", target_id=str(admin.id),
    )
    return TokenOut(access_token=access, refresh_token=refresh)


@router.post("/login", response_model=LoginResult)
async def login(
    data: LoginIn,
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
    _rl: None = Depends(login_rate_limit),
) -> LoginResult:
    svc = AuthService(db)
    user = await svc.authenticate(data.email, data.password)
    # First factor passed. If 2FA is on, don't issue tokens yet — challenge for it.
    if user.totp_enabled:
        return LoginResult(mfa_required=True, mfa_token=svc.issue_mfa_challenge(user))
    # Per-tenant 2FA ENFORCEMENT (P6-D): if a security policy mandates 2FA for this
    # user but they haven't enrolled, block token issuance and signal enrollment.
    # The client uses the short-lived challenge token to authorize the enroll flow
    # (POST /auth/2fa/enroll/*), then logs in again with the new second factor.
    from ..security.service import SecurityService

    if await SecurityService(db).user_must_enroll_2fa(user):
        return LoginResult(
            enrollment_required=True, mfa_token=svc.issue_mfa_challenge(user)
        )
    access, refresh = await svc.issue_tokens(
        user, user_agent=request.headers.get("user-agent"), ip=_client_ip(request)
    )
    set_refresh_cookie(response, refresh)
    await audit_record(
        db, actor=user, action="auth.login", target_type="user", target_id=str(user.id),
    )
    return LoginResult(access_token=access, refresh_token=refresh)


@router.post("/login/mfa", response_model=TokenOut)
async def login_mfa(
    data: MfaLoginIn,
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
    _rl: None = Depends(login_rate_limit),
) -> TokenOut:
    """Second step of a 2FA login: exchange the challenge token + a TOTP/recovery
    code for real access + refresh tokens."""
    svc = AuthService(db)
    user = await svc.verify_mfa_challenge(data.mfa_token, data.code)
    access, refresh = await svc.issue_tokens(
        user, user_agent=request.headers.get("user-agent"), ip=_client_ip(request)
    )
    set_refresh_cookie(response, refresh)
    await audit_record(
        db, actor=user, action="auth.login_mfa", target_type="user", target_id=str(user.id),
    )
    return TokenOut(access_token=access, refresh_token=refresh)


@router.post("/refresh", response_model=AccessOut)
async def refresh(request: Request, db: AsyncSession = Depends(get_db)) -> AccessOut:
    """Mint a new access token from the refresh token — a session probe.

    The refresh token is read from the httpOnly cookie (browser path), falling back
    to a JSON body ``{"refresh_token": ...}`` for non-browser / legacy callers.

    When there is no cookie/body token, or it is invalid/expired/revoked, this
    returns **200 with a null access_token** rather than a 4xx — so the SPA can
    bootstrap its session without generating console/network errors when the user
    is simply signed out. A genuinely present-but-valid token yields a new access
    token as usual.
    """
    token = request.cookies.get(get_settings().refresh_cookie_name)
    if not token:
        # Legacy/non-browser fallback: read {"refresh_token": ...} if a body exists.
        try:
            body = await request.json()
            if isinstance(body, dict):
                token = body.get("refresh_token")
        except Exception:  # noqa: BLE001 — no/invalid body is fine, treat as no token
            token = None
    if not token:
        return AccessOut(access_token=None)
    try:
        return AccessOut(access_token=await AuthService(db).refresh_access(token))
    except (UnauthorizedError, ValueError):
        # Invalid / expired / revoked — no session, not an error for the probe.
        return AccessOut(access_token=None)


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
    from ..settings.service import SettingsService

    if not await SettingsService(db, user.tenant_id).get("allow_avatar_uploads"):
        raise ValidationError("Profile photo uploads are disabled by the administrator.")
    data = await file.read()
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


@router.post("/logout", status_code=204)
async def logout(
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
    data: LogoutIn | None = Body(default=None),
) -> None:
    """Revoke the caller's refresh token (from cookie or body) and clear the cookie."""
    token = (data.refresh_token if data else None) or request.cookies.get(
        get_settings().refresh_cookie_name
    )
    if token:
        await AuthService(db).logout(token)
    clear_refresh_cookie(response)


@router.post("/change-password", status_code=204)
async def change_password(
    data: ChangePasswordIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> None:
    await AuthService(db).change_password(user, data.current_password, data.new_password)


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


# --- 2FA enrollment during enforced login (no access token yet) --------------
async def _user_from_mfa_token(mfa_token: str, db: AsyncSession) -> User:
    """Resolve the user behind a short-lived 'mfa' challenge token (raises 401)."""
    import jwt as _jwt

    from .security import decode_token

    try:
        payload = decode_token(mfa_token)
    except _jwt.PyJWTError:
        raise UnauthorizedError("invalid or expired 2FA session")
    if payload.get("type") != "mfa":
        raise UnauthorizedError("not a 2FA enrollment token")
    user = await db.get(User, uuid.UUID(payload["sub"]))
    if user is None or not user.is_active:
        raise UnauthorizedError("2FA session is no longer valid")
    return user


@router.post("/2fa/enroll/begin", response_model=TotpSetupOut)
async def enroll_begin(
    data: MfaLoginIn,  # reuse: carries mfa_token (code unused here)
    db: AsyncSession = Depends(get_db),
) -> TotpSetupOut:
    """When 2FA is ENFORCED and the user has none, begin enrolment using the login
    challenge token (no access token exists yet). Returns the secret + otpauth URI."""
    user = await _user_from_mfa_token(data.mfa_token, db)
    secret, uri = await AuthService(db).begin_totp_setup(user)
    return TotpSetupOut(secret=secret, otpauth_uri=uri)


@router.post("/2fa/enroll/confirm", response_model=TokenOut)
async def enroll_confirm(
    data: MfaLoginIn,  # carries mfa_token + the first TOTP code
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> TokenOut:
    """Confirm enrolment (verify the first code), enable 2FA, and sign the user in.

    Completes the enforced-2FA login: the user now has a second factor, so real
    access + refresh tokens are issued directly."""
    svc = AuthService(db)
    user = await _user_from_mfa_token(data.mfa_token, db)
    await svc.confirm_totp_setup(user, data.code)
    access, refresh = await svc.issue_tokens(
        user, user_agent=request.headers.get("user-agent"), ip=_client_ip(request)
    )
    await audit_record(
        db, actor=user, action="auth.2fa_enroll", target_type="user", target_id=str(user.id),
    )
    return TokenOut(access_token=access, refresh_token=refresh)


@router.post("/forgot-password")
async def forgot_password(data: ForgotPasswordIn, db: AsyncSession = Depends(get_db)) -> dict:
    result = await AuthService(db).request_password_reset(data.email)
    if result is not None:
        user, raw = result
        from ..messaging.email import send_email

        html = (
            "<p>You requested a password reset. Use this token to set a new password "
            f"(valid 1 hour):</p><p><code>{raw}</code></p>"
        )
        await send_email(db, [user.email], "Reset your password", html, user.tenant_id)
    # Always 200 — never reveal whether the email is registered.
    return {"status": "ok"}


@router.post("/reset-password", status_code=204)
async def reset_password(data: ResetPasswordIn, db: AsyncSession = Depends(get_db)) -> None:
    await AuthService(db).reset_password(data.token, data.new_password)


# --- permission catalog (for the role editor UI) -----------------------------
@admin_router.get("/permissions")
async def permissions(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_permission(CorePerm.ROLE_READ)),
) -> dict:
    """The role editor's catalog: the static keys plus the ones services
    registered at runtime (see `dynamic_permissions`). A key that is enforced but
    not listed here can only ever be held by a wildcard admin, which is not a
    usable permission model — that was the `ingest.read` bug."""
    return {"groups": await dynamic_permissions.grouped(db)}


@admin_router.post("/permissions/registrations")
async def register_permissions(
    body: dict,
    db: AsyncSession = Depends(get_db),
    _: User | None = Depends(require_service_permission(CorePerm.PERMISSION_REGISTER)),
) -> dict:
    """Publish the permission keys a satellite enforces, so a role can grant them.

    Service-to-service (a short-lived superadmin service token), idempotent, and
    additive only: a registration can never redefine a key the static catalog
    already owns. The caller today is the reading-writer
    (``app/api/permsync.py``), pushing one key per dataset registered in
    ``neubit_reporting.dashboard_datasets`` — which is what makes "registration is
    data, not code" hold all the way through to the role editor. (This named "the
    dashboard builder" until 2026-09-03; that service is retired, the registry it
    read is not, and the reading-writer owns it.)
    """
    source = str(body.get("source") or "unknown")
    perms = body.get("permissions") or []
    if not isinstance(perms, list):
        raise ValidationError("permissions must be a list")
    written = await dynamic_permissions.register(db, source=source, permissions=perms)
    return {"registered": written}


# --- roles (dynamic RBAC) ----------------------------------------------------
@admin_router.post("/roles", response_model=RoleOut, status_code=201)
async def create_role(
    data: CreateRoleIn,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_permission(CorePerm.ROLE_MANAGE)),
):
    role = await AuthService(db).create_role(data, scope_of(actor))
    await audit_record(
        db, actor=actor, action="role.create", target_type="role",
        target_id=str(role.id), meta={"name": role.name},
    )
    return role


@admin_router.get("/roles", response_model=Page[RoleOut])
async def list_roles(
    params: PageParams = Depends(page_params),
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_permission(CorePerm.ROLE_READ)),
):
    # Tenant scoping: a tenant-admin sees their own roles + shared system roles;
    # super-admins see all. The shared Administrator role stays visible to everyone.
    return await paginate(
        db, AuthService(db).roles_query(scope_of(actor)), params, item_model=RoleOut
    )


@admin_router.patch("/roles/{role_id}", response_model=RoleOut)
async def update_role(
    role_id: uuid.UUID,
    data: UpdateRoleIn,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_permission(CorePerm.ROLE_MANAGE)),
):
    role = await AuthService(db).update_role(role_id, data, scope_of(actor))
    await audit_record(
        db, actor=actor, action="role.update", target_type="role",
        target_id=str(role_id), meta={"name": role.name},
    )
    return role


@admin_router.delete("/roles/{role_id}", status_code=204)
async def delete_role(
    role_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_permission(CorePerm.ROLE_MANAGE)),
) -> None:
    await AuthService(db).delete_role(role_id, scope_of(actor))
    await audit_record(
        db, actor=actor, action="role.delete", target_type="role", target_id=str(role_id),
    )


# --- users -------------------------------------------------------------------
@admin_router.post("/users", response_model=UserOut, status_code=201)
async def create_user(
    data: CreateUserIn,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_permission(CorePerm.USER_MANAGE)),
) -> UserOut:
    # A name is mandatory when an admin creates an account by hand: the audit trail
    # and every user list read as a person, not an address. (CSV import deliberately
    # still accepts a blank name column — see import_users.)
    if not (data.full_name or "").strip():
        raise ValidationError("Full name is required.")
    # Scope forces a tenant-admin's new users into their own tenant and blocks
    # setting is_superadmin / a cross-tenant tenant_id (see AuthService.create_user).
    user = await AuthService(db).create_user(data, scope_of(actor))
    await audit_record(
        db, actor=actor, action="user.create", target_type="user",
        target_id=str(user.id), meta={"email": user.email},
    )
    if data.send_invite:
        await _send_invite_email(db, user)
    return await _user_out(user)


async def _send_invite_email(db: AsyncSession, user: User) -> None:
    """Email the new user a welcome + secure 'set your password' activation link.
    Reuses the password-reset token, so clicking it both verifies their inbox and
    lets them choose a password. Best-effort: a mail failure won't fail user creation.
    """
    from ..branding import service as branding_service
    from ..core.config import get_settings
    from ..messaging import templates as email_templates
    from ..messaging.email import send_email

    try:
        res = await AuthService(db).request_password_reset(user.email)
        if res is None:
            return
        _, raw = res
        settings = get_settings()
        activate_url = f"{settings.frontend_url.rstrip('/')}/forgot-password?token={raw}"
        # Brand the invite with the new user's tenant (falls back to the platform
        # default), and pull the welcome template override from the same tenant.
        branding = await branding_service.resolve(db, user.tenant_id)
        ctx = {
            "name": user.full_name or user.email,
            "app_name": branding.app_name,
            "activate_url": activate_url,
        }
        subject, body = await email_templates.render_with_overrides(
            db, "welcome", ctx, tenant_id=user.tenant_id
        )
        html = email_templates.wrap_email(branding.app_name, body)
        await send_email(db, [user.email], subject, html, user.tenant_id)
    except Exception:  # pragma: no cover - invites are best-effort
        get_logger("auth").warning("invite email failed for %s", user.email, exc_info=True)


@admin_router.get("/users", response_model=Page[UserOut])
async def list_users(
    params: PageParams = Depends(page_params),
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_permission(CorePerm.USER_READ)),
) -> Page[UserOut]:
    # Tenant scoping lives in scope.py, not here. Super-admins see everyone; every
    # other caller is filtered to their own tenant_id, NULL being a tenancy like any
    # other. This used to flatten the Scope to a bare tenant_id, which made a
    # non-superadmin platform user (tenant_id NULL) indistinguishable from a
    # super-admin and handed them the whole directory.
    svc = AuthService(db)
    page = await paginate(db, svc.users_query(scope_of(actor)), params)
    counts = await svc.active_session_counts([u.id for u in page.items])
    page.items = [await _user_out(u, counts.get(u.id, 0)) for u in page.items]
    return page


@admin_router.get("/users/export")
async def export_users(
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_permission(CorePerm.USER_READ)),
) -> StreamingResponse:
    """Download all users as a CSV (email, name, role, status, verified, last login).

    Tenant-scoped through the same helper the listing uses, so the two cannot drift.
    The hand-rolled filter this replaces read ``if not actor.is_superadmin and
    actor.tenant_id is not None`` — a caller who was neither (a platform user with
    ``user.read`` and no tenant) matched no branch, so no filter was applied and the
    CSV held every user on the platform.
    """
    stmt = scoped(select(User).order_by(User.created_at.desc()), User, scope_of(actor))
    rows = (await db.execute(stmt)).scalars().all()
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["email", "full_name", "role", "is_active", "email_verified", "last_login_at"])
    for u in rows:
        writer.writerow(
            [
                u.email,
                u.full_name or "",
                u.role.name if u.role else "",
                u.is_active,
                u.email_verified,
                u.last_login_at.isoformat() if u.last_login_at else "",
            ]
        )
    buf.seek(0)
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=users.csv"},
    )


def _truthy(value: str) -> bool:
    return str(value).strip().lower() in {"1", "true", "yes", "y", "on"}


@admin_router.post("/users/import")
async def import_users(
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_permission(CorePerm.USER_MANAGE)),
) -> dict:
    """Bulk-create users from a CSV.

    Columns: ``email`` (required), ``full_name``, ``role`` (role name; falls back to
    the caller's role), ``send_invite`` (default true). When no password column is
    given, a random one is set and the user is invited to choose their own.
    """
    raw = (await file.read()).decode("utf-8-sig", errors="replace")
    reader = csv.DictReader(io.StringIO(raw))
    scope = scope_of(actor)
    # Only offer roles the acting admin can actually assign (own-tenant + shared
    # system roles for a tenant-admin; all roles for a super-admin).
    roles = (await db.execute(AuthService(db).roles_query(scope))).scalars().all()
    role_by_name = {r.name.lower(): r for r in roles}

    created, skipped, errors = 0, 0, []
    svc = AuthService(db)
    for i, row in enumerate(reader, start=2):  # row 1 is the header
        email = (row.get("email") or "").strip()
        if not email:
            continue
        role_name = (row.get("role") or "").strip().lower()
        role = role_by_name.get(role_name) or actor.role
        send_invite = _truthy(row.get("send_invite", "true"))
        password = (row.get("password") or "").strip() or (secrets.token_urlsafe(10) + "aA1")
        try:
            # scope stamps each imported user with the acting admin's tenant.
            user = await svc.create_user(
                CreateUserIn(
                    email=email,
                    password=password,
                    full_name=(row.get("full_name") or "").strip() or None,
                    role_id=role.id,
                    send_invite=send_invite,
                ),
                scope,
            )
            if send_invite:
                await _send_invite_email(db, user)
            created += 1
        except Exception as exc:  # duplicate email, bad data, …
            skipped += 1
            errors.append({"row": i, "email": email, "error": str(exc)})

    await audit_record(
        db, actor=actor, action="user.import", target_type="user", target_id="bulk",
        meta={"created": created, "skipped": skipped},
    )
    return {"created": created, "skipped": skipped, "errors": errors[:20]}


@admin_router.get("/users/{user_id}", response_model=UserOut)
async def get_user(
    user_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_permission(CorePerm.USER_READ)),
) -> UserOut:
    """Fetch one user. A tenant-admin only sees users in their own tenant (404
    otherwise); super-admins see any user."""
    svc = AuthService(db)
    user = await svc.get_user(user_id, scope_of(actor))
    counts = await svc.active_session_counts([user.id])
    return await _user_out(user, counts.get(user.id, 0))


@admin_router.patch("/users/{user_id}", response_model=UserOut)
async def update_user(
    user_id: uuid.UUID,
    data: UpdateUserIn,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_permission(CorePerm.USER_MANAGE)),
) -> UserOut:
    user = await AuthService(db).update_user(user_id, data, scope_of(actor))
    # Record WHAT changed, never the secret itself — an audit trail holding plaintext
    # passwords would be a breach in its own right. mode="json" keeps the UUIDs/emails
    # storable in the JSON meta column.
    changed = data.model_dump(exclude_none=True, mode="json")
    if changed.pop("password", None):  # truthy, like the service's "blank = unchanged"
        changed["password_changed"] = True
    await audit_record(
        db, actor=actor, action="user.update", target_type="user",
        target_id=str(user_id), meta=changed,
    )
    return await _user_out(user)


@admin_router.delete("/users/{user_id}", status_code=204)
async def delete_user(
    user_id: uuid.UUID,
    data: ConfirmPasswordIn,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_permission(CorePerm.USER_MANAGE)),
) -> None:
    """Delete a user. Requires the acting admin to re-enter their own password,
    and blocks deleting your own account."""
    if actor.id == user_id:
        raise ValidationError("You cannot delete your own account.")
    svc = AuthService(db)
    if not svc.verify_actor_password(actor, data.password):
        raise UnauthorizedError("Password confirmation failed.")
    user = await svc.delete_user(user_id, scope_of(actor))
    await audit_record(
        db, actor=actor, action="user.delete", target_type="user",
        target_id=str(user_id), meta={"email": user.email},
    )


# --- admin account actions ---------------------------------------------------
@admin_router.post("/users/{user_id}/lock", response_model=UserOut)
async def lock_user(
    user_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_permission(CorePerm.USER_MANAGE)),
) -> UserOut:
    """Manually lock a user out of sign-in until an admin unlocks them."""
    if actor.id == user_id:
        raise ValidationError("You cannot lock your own account.")
    user = await AuthService(db).admin_lock_user(user_id, scope_of(actor))
    await audit_record(
        db, actor=actor, action="user.lock", target_type="user",
        target_id=str(user_id), meta={"email": user.email},
    )
    return await _user_out(user)


@admin_router.post("/users/{user_id}/unlock", response_model=UserOut)
async def unlock_user(
    user_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_permission(CorePerm.USER_MANAGE)),
) -> UserOut:
    """Clear a lock (manual or brute-force) and reset the failed-login counter."""
    user = await AuthService(db).admin_unlock_user(user_id, scope_of(actor))
    await audit_record(
        db, actor=actor, action="user.unlock", target_type="user",
        target_id=str(user_id), meta={"email": user.email},
    )
    return await _user_out(user)


@admin_router.post("/users/{user_id}/reset-mfa", response_model=UserOut)
async def reset_user_mfa(
    user_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_permission(CorePerm.USER_MANAGE)),
) -> UserOut:
    """Disable the target user's TOTP second factor (lost-device recovery)."""
    user = await AuthService(db).admin_reset_mfa(user_id, scope_of(actor))
    await audit_record(
        db, actor=actor, action="user.reset_mfa", target_type="user",
        target_id=str(user_id), meta={"email": user.email},
    )
    return await _user_out(user)


@admin_router.post("/users/{user_id}/revoke-sessions", response_model=UserOut)
async def force_sign_out_user(
    user_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_permission(CorePerm.USER_MANAGE)),
) -> UserOut:
    """Force sign-out: revoke every live session/refresh token for the user."""
    user = await AuthService(db).admin_revoke_sessions(user_id, scope_of(actor))
    await audit_record(
        db, actor=actor, action="user.revoke_sessions", target_type="user",
        target_id=str(user_id), meta={"email": user.email},
    )
    return await _user_out(user, 0)


@admin_router.post("/users/{user_id}/clone", response_model=UserOut, status_code=201)
async def clone_user(
    user_id: uuid.UUID,
    data: CloneUserIn,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_permission(CorePerm.USER_MANAGE)),
) -> UserOut:
    """Fast onboarding: copy a user's role, status and site scope into a new account
    (fresh email/name; the new user sets their own password via the invite)."""
    svc = AuthService(db)
    user = await svc.clone_user(user_id, data, scope_of(actor))
    await audit_record(
        db, actor=actor, action="user.clone", target_type="user",
        target_id=str(user.id), meta={"email": user.email, "cloned_from": str(user_id)},
    )
    if data.send_invite:
        await _send_invite_email(db, user)
    return await _user_out(user)


@admin_router.post("/roles/{role_id}/clone", response_model=RoleOut, status_code=201)
async def clone_role(
    role_id: uuid.UUID,
    data: CloneRoleIn,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_permission(CorePerm.ROLE_MANAGE)),
) -> RoleOut:
    """Copy a role's permissions + description under a new name."""
    role = await AuthService(db).clone_role(role_id, data.name, scope_of(actor))
    await audit_record(
        db, actor=actor, action="role.clone", target_type="role",
        target_id=str(role.id), meta={"name": role.name, "cloned_from": str(role_id)},
    )
    return role


# --- API keys ----------------------------------------------------------------
#
# The operator surface for the platform's SERVICE CREDENTIAL. Create / list /
# revoke, all three gated on ``apikey.manage``, which is registered in
# permissions.py — a gate whose key is not in the catalog is a gate no role can
# ever open, which is the ``ingest.read`` failure that file's own comment records.
#
# There is no read-back and no rotate-in-place: the secret is shown once by
# ``create`` and exists nowhere afterwards. Replacing a key means creating the new
# one, moving the peer onto it, and revoking the old one — three explicit steps,
# each of which is auditable, instead of one that silently invalidates whatever
# was already deployed.
@admin_router.post("/api-keys", response_model=ApiKeyCreatedOut, status_code=201)
async def create_api_key(
    data: ApiKeyCreateIn,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_permission(CorePerm.APIKEY_MANAGE)),
) -> ApiKeyCreatedOut:
    """Mint a scoped service credential. The raw key is in this response and nowhere else."""
    key, raw = await AuthService(db).create_api_key(data, scope_of(actor), actor=actor)
    await audit_record(
        db, actor=actor, action="apikey.create", target_type="api_key",
        target_id=str(key.id),
        # The SCOPES are in the audit meta on purpose. "A key was created" is not
        # the reviewable fact; "a key that can read BI was created" is, and the key
        # row can be revoked and later purged while the trail has to stay legible.
        meta={
            "name": key.name,
            "prefix": key.prefix,
            "scopes": list(key.scopes or []),
            "expires_at": key.expires_at.isoformat() if key.expires_at else None,
        },
    )
    return ApiKeyCreatedOut(**ApiKeyOut.model_validate(key).model_dump(), key=raw)


@admin_router.get("/api-keys", response_model=Page[ApiKeyOut])
async def list_api_keys(
    params: PageParams = Depends(page_params),
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_permission(CorePerm.APIKEY_MANAGE)),
) -> Page[ApiKeyOut]:
    # Tenant scoping: a tenant-admin only sees their own tenant's keys.
    return await paginate(
        db, AuthService(db).api_keys_query(scope_of(actor)), params, item_model=ApiKeyOut
    )


@admin_router.delete("/api-keys/{key_id}", status_code=204)
async def revoke_api_key(
    key_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_permission(CorePerm.APIKEY_MANAGE)),
) -> None:
    """Kill one credential. Touches no user account — that is the whole point of it.

    Effective at once for anything core serves and for any further exchange, both
    of which re-read this row. A token the key already holds keeps working at the
    SATELLITES until it expires, because a satellite verifies statelessly and has
    nothing to ask; ``api_key_token_ttl_minutes`` (15) is the width of that window
    and is why it is not 12 hours. Stated here rather than left for someone to
    discover during an incident.
    """
    key = await AuthService(db).revoke_api_key(key_id, scope_of(actor))
    await audit_record(
        db, actor=actor, action="apikey.revoke", target_type="api_key", target_id=str(key_id),
        meta={"name": key.name, "prefix": key.prefix},
    )


@router.post("/token", response_model=ApiKeyTokenOut)
async def exchange_api_key(
    data: ApiKeyTokenIn,
    db: AsyncSession = Depends(get_db),
    _rl: None = Depends(api_key_rate_limit),
) -> ApiKeyTokenOut:
    """Exchange an ``nbk_...`` service key for a short-lived access token.

    UNAUTHENTICATED, because the key IS the credential — the same relationship
    /auth/login has with a password. It is rate-limited for the same reason: this
    is the only endpoint in the platform where a key secret can be guessed at. The
    bucket is its own and not login's, so a scheduled integration and a human
    typing their password cannot starve each other (core/ratelimit.py).

    WHAT THIS DELIBERATELY IS NOT: a second thing for the satellites to verify. It
    returns an ordinary access token, so ingest, workflow, vision, access and the
    reading-writer authorize a key exactly as they authorize a person, with the
    code they already run and no kernel change. That is what makes the whole
    facility additive — its correctness at eight services is demonstrated by those
    services being untouched.

    Every failure is 401 with one message. Malformed, unknown, wrong secret,
    revoked and expired are indistinguishable from outside, so the endpoint cannot
    be used to learn which keys exist or which have been killed.
    """
    svc = AuthService(db)
    key = await svc.authenticate_api_key(data.api_key)
    token, ttl = await svc.issue_api_key_token(key)
    # NOT AUDITED, and that is a decision rather than an omission. A machine
    # re-exchanges every few minutes forever; writing a row each time would bury
    # the trail this platform's operators actually read under uniform noise, and
    # audit_log has a retention purge that would then start evicting real entries.
    # The facts an exchange establishes are recorded where they stay useful:
    # ``last_used_at`` on the key row (is anything still using this?), and
    # ``actor_type='apikey'`` on every entry the resulting token goes on to write.
    return ApiKeyTokenOut(
        access_token=token, expires_in=ttl, scopes=list(key.scopes or [])
    )


# Mounted last so the self-service paths above keep their declaration order; the two
# sets do not overlap (`/me…` vs `/users…`, `/roles…`, `/api-keys…`).
router.include_router(admin_router)
