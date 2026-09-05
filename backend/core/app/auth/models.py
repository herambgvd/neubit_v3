"""Auth ORM models: Role (dynamic) + User + ApiKey (scoped service credential).

RBAC is fully dynamic: roles are rows created by admins, each carrying a chosen
set of permission keys (from permissions.PERMISSIONS). No hardcoded role names.

Uuid/JSON/Enum use SQLAlchemy's portable generic types so the same models run on
Postgres and on SQLite (tests).
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import JSON, Boolean, DateTime, ForeignKey, Integer, String, Uuid, func, text  # noqa: F401
from sqlalchemy.orm import Mapped, mapped_column, relationship

from ..db.base import Base
from .permissions import WILDCARD


class Role(Base):
    """A named bundle of permission keys. Admin-defined (except the system role)."""

    __tablename__ = "roles"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String, unique=True, nullable=False)
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
    """A SERVICE CREDENTIAL: a scoped, revocable, non-interactive identity.

    It exists because a peer product had to be given a human's password. DashForge
    reads this platform's BI data with ``NEUBIT_BI_USER`` / ``NEUBIT_BI_PASSWORD``
    — a service account's real login — because until 2026-09-05 there was nothing
    else to give it. A password is the wrong credential for a machine in four
    specific ways, and every field below exists to answer one of them.

    SCOPED, NOT ROLE-SHAPED — ``scopes``. A key carries a flat list of permission
    keys chosen at creation, not a role id. A role is a LIVING set: someone widens
    "Analyst" next quarter and every key wearing it silently widens with it, which
    is how a BI reader ends up able to create users. ``scopes`` is a snapshot and
    changes only when a human edits that key. ``role_id`` below is the retired
    mechanism, kept nullable for the rows that predate this.

    INDEPENDENTLY REVOCABLE — ``revoked_at`` / ``is_active``. Killing a key must
    not mean disabling the account it was cut from, because that is the reason
    nobody ever revokes anything: the blast radius of the safe action is a person
    who cannot log in.

    EXPIRING — ``expires_at``, and ``last_used_at`` next to it. An operator sets an
    end date, and the last-used stamp is what makes a key that everyone forgot
    VISIBLE rather than merely old: "issued 14 months ago" is normal, "issued 14
    months ago and last used never" is a credential to delete.

    ATTRIBUTABLE — ``created_by``. An audit entry written by a key records the key
    (``actor_type='apikey'``, see core/audit.py); this records who made the key,
    which is the other half of the question and is not recoverable from the trail
    once the creating admin has left.

    Only a SHA-256 hash of the whole key is stored, plus ``prefix``, which is a
    dedicated non-secret id segment rather than a slice of the secret (see
    ``security.generate_api_key``). The raw key is shown once at creation.
    """

    __tablename__ = "api_keys"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String, nullable=False)
    description: Mapped[str | None] = mapped_column(String, nullable=True)
    prefix: Mapped[str] = mapped_column(String, index=True, nullable=False)
    key_hash: Mapped[str] = mapped_column(String, nullable=False)
    # The permission keys this key may exercise — the whole of its authority.
    # Validated against the catalog at creation and against the CREATOR's own
    # effective permissions, so a key can never be wider than the hand that made
    # it. The wildcard is refused outright: an unbounded machine credential is the
    # thing this model replaces, not a configuration of it.
    scopes: Mapped[list[str]] = mapped_column(JSON, nullable=False, default=list)
    # RETIRED (2026-09-05), kept nullable so the pre-scopes rows still describe
    # themselves. Nothing reads it to authorize — a key's authority is ``scopes``
    # and only ``scopes``. Creating with a role_id still works and snapshots that
    # role's permissions INTO scopes at that moment; it does not store a live link.
    role_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("roles.id"), nullable=True)
    role: Mapped[Role | None] = relationship(lazy="selectin")
    # --- multi-tenancy -----------------------------------------------------
    # The tenant this API key belongs to. NULL = a platform-level key (super-admin
    # created). Tenant-admin keys carry their tenant_id and are scoped to it.
    tenant_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("tenants.id", ondelete="CASCADE"), index=True, nullable=True
    )
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    # When the key stops being accepted, set by the operator at creation. NULL =
    # no expiry, which is allowed but is the choice an operator has to make on
    # purpose rather than the one they get by not thinking about it.
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # Set once, at revocation. Separate from ``is_active`` because "when" is the
    # question an incident asks and a boolean cannot answer.
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_by: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    def grants(self, permission: str) -> bool:
        """Whether this key's scopes cover ``permission``.

        No wildcard branch, unlike ``Role.grants``. A key holding "*" cannot exist
        (creation refuses it), and writing the branch anyway would leave the one
        line that has to stay false forever sitting in the middle of the check.
        """
        return permission in (self.scopes or [])

    def usable_at(self, now: datetime) -> bool:
        """Whether the key is live: not revoked, not deactivated, not past expiry."""
        if not self.is_active or self.revoked_at is not None:
            return False
        if self.expires_at is None:
            return True
        # SQLite (the test DB) hands back a NAIVE datetime for a column Postgres
        # returns as aware, and comparing the two raises TypeError. An exception
        # thrown out of an expiry check does not fail closed — it 500s a path that
        # was supposed to return 401 — so the value is normalised rather than
        # trusted to arrive with a tzinfo.
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
    """A permission key registered at RUNTIME by a satellite service.

    The static catalog in ``permissions.py`` is the authority on anything the
    code itself enforces. This table is for keys the code cannot know at build
    time — today, the per-dataset read permissions declared by the dataset
    registry the READING-WRITER owns (it said "the dashboard builder's registry"
    until 2026-09-03; the builder is retired, the registry outlived it): a dataset
    is registered with an INSERT into ``neubit_reporting.dashboard_datasets`` and
    it names the permission required to read it.

    Without this, such a key fails ``PERMISSIONS.unknown()`` on role create and no
    role can ever grant it — which is precisely the ``ingest.read`` bug the
    builder contract tells us not to repeat.
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
