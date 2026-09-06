"""Auth ORM models: Role (dynamic) + User + ApiKey (scoped service credential).

RBAC is fully dynamic: roles are rows created by admins, each carrying a chosen
set of permission keys (from permissions.PERMISSIONS). No hardcoded role names.

Uuid/JSON/Enum use SQLAlchemy's portable generic types so the same models run on
Postgres and on SQLite (tests).
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import JSON, Boolean, DateTime, ForeignKey, Index, Integer, String, Uuid, func, text  # noqa: F401
from sqlalchemy.orm import Mapped, mapped_column, relationship

from ..db.base import Base
from .permissions import WILDCARD


class Role(Base):
    """A named bundle of permission keys. Admin-defined (except the system role)."""

    __tablename__ = "roles"
    # Names are unique within a tenant, not across the platform (migration 0025).
    # Keep this an Index, not a UniqueConstraint: the migration creates an index,
    # and a mismatch makes autogenerate propose a drop+add on every run.
    # `postgresql_nulls_not_distinct` makes the shared (tenant_id NULL) roles
    # collide with each other; without it there is no uniqueness at all for them.
    # Other dialects ignore it, so SQLite (tests) accepts duplicate shared names
    # that Postgres refuses — create_role refuses them in code.
    __table_args__ = (
        Index(
            "uq_roles_tenant_name",
            "tenant_id",
            "name",
            unique=True,
            postgresql_nulls_not_distinct=True,
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String, nullable=False)
    description: Mapped[str | None] = mapped_column(String, nullable=True)
    # list[str] of permission keys, e.g. ["user.read", "audit.read"] or ["*"].
    permissions: Mapped[list[str]] = mapped_column(JSON, nullable=False, default=list)
    # System roles (the built-in Administrator) can't be edited or deleted.
    is_system: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    # --- multi-tenancy -----------------------------------------------------
    # The tenant this role belongs to. NULL = a SHARED SYSTEM role (the built-in
    # Administrator), visible to every tenant. A tenant-admin's custom roles carry
    # their tenant_id and are only visible/usable within that tenant.
    tenant_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("tenants.id", ondelete="CASCADE"), index=True, nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    def grants(self, permission: str) -> bool:
        return WILDCARD in self.permissions or permission in self.permissions


class User(Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    email: Mapped[str] = mapped_column(String, unique=True, index=True, nullable=False)
    full_name: Mapped[str | None] = mapped_column(String, nullable=True)
    password_hash: Mapped[str] = mapped_column(String, nullable=False)
    role_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("roles.id"), nullable=False)
    # --- multi-tenancy -----------------------------------------------------
    # The tenant this user belongs to. NULL only for platform SUPER-ADMINS, who
    # sit above all tenants and manage them via the /admin API. Tenant users
    # always have a tenant_id set. (v1: row-scoping in a shared control DB; the
    # DB-per-tenant hardening would route by this id instead of filtering on it.)
    tenant_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("tenants.id", ondelete="CASCADE"), index=True, nullable=True
    )
    # Platform super-admin: tenant_id NULL + is_superadmin True. Grants access to
    # the cross-tenant /admin API (gated by require_superadmin).
    is_superadmin: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=text("false")
    )
    # True once the user has proven inbox access (completed an emailed set-password
    # / reset link). Admin-created users start unverified until they use their invite.
    email_verified: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=text("false")
    )
    # Storage key for the user's uploaded profile picture (resolved to a URL at
    # response time via the storage backend). None => fall back to initials.
    avatar_key: Mapped[str | None] = mapped_column(String, nullable=True)
    # Per-user preferences (theme, locale, notification opt-ins, …). A free-form
    # JSON blob so scenarios can extend it without a migration.
    preferences: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    # --- account security (STQC / auth hardening) --------------------------
    # Brute-force lockout: consecutive failed logins, and a lock expiry after the
    # configured threshold is crossed.
    failed_login_count: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default=text("0")
    )
    locked_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # Password lifecycle: when it was last set (for expiry), recent hashes (to
    # block reuse), and a force-change flag.
    password_changed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    password_history: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    must_change_password: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=text("false")
    )
    # --- two-factor auth (TOTP) --------------------------------------------
    # Fernet-encrypted base32 TOTP secret (set at setup, kept while enrolled).
    totp_secret: Mapped[str | None] = mapped_column(String, nullable=True)
    totp_enabled: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=text("false")
    )
    # SHA-256 hashes of one-time recovery codes (consumed as they're used).
    mfa_recovery_codes: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    # --- site access scope (data-visibility RBAC) --------------------------
    # The site ids this user may see. EMPTY list = UNRESTRICTED (every site in the
    # tenant). Non-empty = the user is confined to exactly these sites — enforced at
    # camera/site read time (core sites list + vision camera list, via the token's
    # ``site_ids`` claim). Coarse, additive-safe: it only ever narrows visibility.
    site_ids: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    # Eager-loaded with the user so permission checks never need a second query.
    role: Mapped[Role] = relationship(lazy="selectin")
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class ApiKey(Base):
    """A service credential: a scoped, revocable, non-interactive identity.

    Replaces giving a machine a human's password. The key's authority is
    ``scopes`` — a snapshot of permission keys, not a live role link, so widening
    a role later cannot widen existing keys. ``revoked_at``/``is_active`` let one
    key be killed without disabling its account; ``expires_at`` and
    ``last_used_at`` make forgotten keys visible; ``created_by`` records who
    issued it (the audit trail only records the key itself).

    Only a SHA-256 hash of the whole key is stored, plus ``prefix``, a dedicated
    non-secret id segment rather than a slice of the secret (see
    ``security.generate_api_key``). The raw key is shown once at creation.
    """

    __tablename__ = "api_keys"
    # Must stay UNIQUE: `authenticate_api_key` resolves a presented key by prefix
    # with `.scalar_one_or_none()`, so a duplicate prefix 500s every POST
    # /auth/token. Declared here (not just `index=True` on the column) so it
    # matches migration 0023 and autogenerate stops proposing to drop it.
    __table_args__ = (Index("uq_api_keys_prefix", "prefix", unique=True),)

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String, nullable=False)
    description: Mapped[str | None] = mapped_column(String, nullable=True)
    prefix: Mapped[str] = mapped_column(String, nullable=False)
    key_hash: Mapped[str] = mapped_column(String, nullable=False)
    # The permission keys this key may exercise — the whole of its authority.
    # Validated at creation against the catalog and against the creator's own
    # effective permissions, so a key is never wider than its maker. The wildcard
    # is refused outright.
    scopes: Mapped[list[str]] = mapped_column(JSON, nullable=False, default=list)
    # Retired, kept nullable for pre-scopes rows. Nothing reads it to authorize.
    # Creating with a role_id snapshots that role's permissions into scopes at
    # that moment; it does not store a live link.
    role_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("roles.id"), nullable=True)
    role: Mapped[Role | None] = relationship(lazy="selectin")
    # --- multi-tenancy -----------------------------------------------------
    # The tenant this API key belongs to. NULL = a platform-level key (super-admin
    # created). Tenant-admin keys carry their tenant_id and are scoped to it.
    tenant_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("tenants.id", ondelete="CASCADE"), index=True, nullable=True
    )
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    # When the key stops being accepted, set by the operator at creation.
    # NULL = no expiry (allowed, but an explicit choice).
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # Set once, at revocation. Separate from ``is_active`` so an incident can ask
    # "when", which a boolean cannot answer.
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_by: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    def grants(self, permission: str) -> bool:
        """Whether this key's scopes cover ``permission``.

        No wildcard branch, unlike ``Role.grants``: a key holding "*" cannot exist
        because creation refuses it. Do not add one.
        """
        return permission in (self.scopes or [])

    def usable_at(self, now: datetime) -> bool:
        """Whether the key is live: not revoked, not deactivated, not past expiry."""
        if not self.is_active or self.revoked_at is not None:
            return False
        if self.expires_at is None:
            return True
        # SQLite (tests) returns a naive datetime where Postgres returns aware,
        # and comparing the two raises TypeError — which 500s a path that should
        # have returned 401. Normalise rather than assume a tzinfo.
        expires = self.expires_at
        if expires.tzinfo is None:
            expires = expires.replace(tzinfo=timezone.utc)
        return expires > now


class RefreshToken(Base):
    """One row per issued refresh token (id = the token's jti). Enables revocation:
    logout / password-change mark rows revoked, and refresh checks the row is live."""

    __tablename__ = "refresh_tokens"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True)  # jti
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    # Session context — captured at login so the user can review + revoke devices.
    user_agent: Mapped[str | None] = mapped_column(String, nullable=True)
    ip: Mapped[str | None] = mapped_column(String, nullable=True)
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class PasswordResetToken(Base):
    """Single-use, time-limited token for the forgot-password flow (only its hash
    is stored)."""

    __tablename__ = "password_reset_tokens"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False
    )
    token_hash: Mapped[str] = mapped_column(String, index=True, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class PermissionRegistration(Base):
    """A permission key registered at runtime by a satellite service.

    ``permissions.py`` stays the authority for anything the code enforces. This
    table is for keys the code cannot know at build time — today, the per-dataset
    read permissions named by rows in ``neubit_reporting.dashboard_datasets``.
    Without it such a key fails ``PERMISSIONS.unknown()`` on role create and no
    role can ever grant it.
    """

    __tablename__ = "permission_registrations"

    key: Mapped[str] = mapped_column(String(128), primary_key=True)
    label: Mapped[str] = mapped_column(String(200), nullable=False)
    group_name: Mapped[str] = mapped_column(String(80), nullable=False)
    description: Mapped[str] = mapped_column(String, nullable=False, default="")
    # Which service registered it. A stale key should be diagnosable, not a mystery.
    source: Mapped[str] = mapped_column(String(64), nullable=False, default="")
    registered_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
