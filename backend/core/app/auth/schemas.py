"""Pydantic request/response schemas for the auth API."""

from __future__ import annotations

import datetime as dt
import uuid

from pydantic import BaseModel, ConfigDict, EmailStr

from ..core.fields import AsciiEmail


# --- roles -------------------------------------------------------------------
class RoleOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    name: str
    description: str | None
    permissions: list[str]
    is_system: bool
    created_at: dt.datetime


class CreateRoleIn(BaseModel):
    name: str
    description: str | None = None
    permissions: list[str] = []


class UpdateRoleIn(BaseModel):
    name: str | None = None
    description: str | None = None
    permissions: list[str] | None = None


# --- users -------------------------------------------------------------------
class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    email: str
    full_name: str | None
    role: RoleOut
    # Platform (vendor) super-admin — gates vendor-only features (e.g. External
    # Access / ONVIF server) that a client's own admin must NOT be able to enable.
    is_superadmin: bool = False
    is_active: bool
    email_verified: bool
    created_at: dt.datetime
    last_login_at: dt.datetime | None
    # Resolved from the stored avatar_key at response time (None => use initials).
    avatar_url: str | None = None
    preferences: dict = {}
    # Whether the user has an active TOTP second factor.
    totp_enabled: bool = False
    # --- account security posture (real, row-backed) -----------------------
    # Consecutive failed logins + brute-force lock expiry. ``locked`` is the
    # derived "is this account currently locked" (auto lockout OR an admin lock,
    # which sets locked_until far in the future).
    failed_login_count: int = 0
    locked_until: dt.datetime | None = None
    locked: bool = False
    password_changed_at: dt.datetime | None = None
    # Count of the user's live (non-revoked, unexpired) sessions — filled by the
    # router from the refresh-token table (0 when not resolved).
    active_sessions: int = 0
    # --- site access scope -------------------------------------------------
    # The site ids this user is confined to; EMPTY = unrestricted (all sites).
    site_ids: list[str] = []
    # Platform super-admin flag (tenant_id NULL + is_superadmin True). The admin
    # console reads this to gate access to the cross-tenant panel.
    is_superadmin: bool = False


class LoginIn(BaseModel):
    # Deliberately plain EmailStr, not AsciiEmail: sign-in and password-reset only
    # LOOK UP an existing row, and accounts created before the ASCII rule must still
    # be able to get in (and be renamed). Only account-creating schemas are strict.
    email: EmailStr
    password: str


class TokenOut(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"


class LoginResult(BaseModel):
    """Login response. Either issues tokens directly, or (when the user has 2FA)
    returns ``mfa_required`` + a short-lived ``mfa_token`` to exchange via
    ``/auth/login/mfa``."""

    mfa_required: bool = False
    mfa_token: str | None = None
    access_token: str | None = None
    refresh_token: str | None = None
    token_type: str = "bearer"
    # Set when a security policy REQUIRES 2FA but the user hasn't enrolled yet. The
    # client must route them to /auth/me/2fa/setup (using the short-lived
    # ``mfa_token`` as a bearer) before they can obtain real tokens.
    enrollment_required: bool = False


class MfaLoginIn(BaseModel):
    mfa_token: str
    code: str


class TotpConfirmIn(BaseModel):
    code: str


class TotpSetupOut(BaseModel):
    secret: str
    otpauth_uri: str


class RecoveryCodesOut(BaseModel):
    recovery_codes: list[str]


class TotpStatusOut(BaseModel):
    enabled: bool
    recovery_codes_remaining: int


class RefreshIn(BaseModel):
    refresh_token: str


class LogoutIn(BaseModel):
    refresh_token: str


class ChangePasswordIn(BaseModel):
    current_password: str
    new_password: str


class ForgotPasswordIn(BaseModel):
    email: EmailStr


class ResetPasswordIn(BaseModel):
    token: str
    new_password: str


class AccessOut(BaseModel):
    # None when there is no valid session — /auth/refresh answers 200 with a null
    # token (a session probe) rather than erroring, so the SPA bootstrap makes no
    # failing requests.
    access_token: str | None = None
    token_type: str = "bearer"


class SetupIn(BaseModel):
    """First-run setup: create the very first administrator (only when none exist)."""

    email: AsciiEmail
    password: str
    full_name: str | None = None


class CreateUserIn(BaseModel):
    email: AsciiEmail
    password: str
    full_name: str | None = None
    role_id: uuid.UUID
    is_active: bool = True
    # When true, email the new user a welcome + "set your password" invite link.
    send_invite: bool = False
    # Multi-tenancy: only a super-admin may target a specific tenant here. For a
    # tenant-admin this is IGNORED — the new user is forced into the admin's own
    # tenant (a tenant-admin can never provision into another tenant). A tenant-admin
    # can also never set is_superadmin (there is no field for it).
    tenant_id: uuid.UUID | None = None
    # Site access scope for the new user (site ids). EMPTY = unrestricted.
    site_ids: list[str] = []


class UpdateUserIn(BaseModel):
    role_id: uuid.UUID | None = None
    is_active: bool | None = None
    full_name: str | None = None
    # Admin-side identity + credential edits. Both are optional and only applied when
    # sent: a new address must still be unique, and an omitted (or empty) password
    # leaves the existing one untouched — the console sends it only when refilled.
    email: AsciiEmail | None = None
    password: str | None = None
    # None = leave scope unchanged; a list (incl. []) REPLACES it ([] = unrestricted).
    site_ids: list[str] | None = None


class CloneUserIn(BaseModel):
    """Fast onboarding: copy a source user's role, status and site scope into a new
    account. Only identity differs — a fresh email + name; the new user sets their
    own password via the emailed invite (no plaintext is ever copied)."""

    email: AsciiEmail
    full_name: str | None = None
    send_invite: bool = True


class CloneRoleIn(BaseModel):
    """Copy a role's permissions + description under a new name."""

    name: str


class ConfirmPasswordIn(BaseModel):
    """The acting admin re-enters their own password to confirm a sensitive action."""

    password: str


class UpdateMeIn(BaseModel):
    """Self-service profile edit (the signed-in user updates their own record)."""

    full_name: str | None = None


class PreferencesIn(BaseModel):
    """Partial merge into the user's preferences JSON (only sent keys change)."""

    preferences: dict


class SessionOut(BaseModel):
    """A live login session (backed by a non-revoked refresh token)."""

    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    user_agent: str | None
    ip: str | None
    created_at: dt.datetime
    last_used_at: dt.datetime | None
    current: bool = False


# --- API keys ----------------------------------------------------------------
class ApiKeyOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    name: str
    prefix: str
    role: RoleOut
    is_active: bool
    created_at: dt.datetime
    last_used_at: dt.datetime | None


class ApiKeyCreateIn(BaseModel):
    name: str
    role_id: uuid.UUID


class ApiKeyCreatedOut(ApiKeyOut):
    key: str  # the raw key — returned ONCE at creation, never again
