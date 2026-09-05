"""Getting in and out: first-run setup, login, MFA, refresh, logout, password reset.

Everything here runs BEFORE there is a session, or ends one. That is the reason it
is a file of its own rather than a section of a bigger one: these are the routes
that cannot require a caller, so they are also the routes where a missing gate looks
exactly like a correct one. `tests/test_route_inventory.py` lists every one of them
by name with the reason it is unauthenticated.
"""

from __future__ import annotations


from fastapi import Body, Depends, Request, Response
from sqlalchemy.ext.asyncio import AsyncSession

from ...core.audit import record as audit_record
from ...core.config import get_settings
from ...core.errors import UnauthorizedError, ValidationError
from ...core.ratelimit import login_rate_limit
from ...db.base import get_db
from ..cookies import clear_refresh_cookie, set_refresh_cookie
from ..deps import get_current_user
from ..models import User
from ..schemas import (
    AccessOut,
    ChangePasswordIn,
    ForgotPasswordIn,
    LoginIn,
    LoginResult,
    LogoutIn,
    MfaLoginIn,
    ResetPasswordIn,
    SetupIn,
    TokenOut,
    TotpSetupOut,
)
from ..service import AuthService

from ._shared import _client_ip, _user_from_mfa_token
from . import router


# --- session -----------------------------------------------------------------
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
    from ...security.service import SecurityService

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


# --- 2FA enrollment during enforced login (no access token yet) --------------
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
        from ...messaging.email import send_email

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


