"""Enterprise security ORM models (P6-D) — VMS-grade hardening.

This module adds the *enterprise-pitch* security surface on top of the auth
hardening that already ships in ``app/auth`` (TOTP 2FA, account lockout, password
policy, revocable sessions) and the append-only ``app/core/audit`` trail:

  * :class:`SecurityPolicy` — a per-tenant policy singleton. Today it carries the
    "require 2FA" enforcement toggle (per-tenant / per-role); it is the natural home
    for future session / password knobs surfaced per-tenant.
  * :class:`DirectoryConfig` — an LDAP/AD server the tenant syncs users & groups
    from. Bind credentials are Fernet-encrypted at rest (``app/core/secrets``).
  * :class:`SsoConfig` — an OIDC identity provider (issuer / client_id / secret).
    The client secret is Fernet-encrypted at rest.
  * :class:`DualAuthRequest` — the four-eyes ledger: a flagged sensitive action
    (export video, delete recording, delete tenant) recorded as *pending* until a
    second privileged user approves or denies it.

All tables are TENANT-SCOPED with a nullable ``tenant_id`` (NULL = a platform /
super-admin row) exactly like the sites/tags/audit tables, so the same row-scoping
helpers (``tenancy.scope``) apply unchanged.

Portable generic column types (Uuid / JSON / Enum-as-String) so the same models run
on Postgres and on SQLite (tests).
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Uuid,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from ..db.base import Base


class SecurityPolicy(Base):
    """Per-tenant security policy singleton (one row per tenant; NULL = platform).

    Carries the 2FA enforcement decision so a tenant-admin can mandate TOTP for
    their organization (optionally only for specific role names). Kept as its own
    table — rather than a JSON blob in app_settings — so it is queryable at login
    time with a single indexed lookup and can grow structured columns later.
    """

    __tablename__ = "security_policies"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    # The tenant this policy governs. NULL = the platform-default policy (applies to
    # super-admins and to tenants with no policy row of their own).
    tenant_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("tenants.id", ondelete="CASCADE"), index=True, unique=True, nullable=True
    )
    # --- 2FA enforcement ---------------------------------------------------
    # When true, every user in scope MUST have TOTP enrolled; a login without it is
    # blocked with an "enroll 2FA" signal (the client routes to setup).
    require_2fa: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=text("false")
    )
    # Optional narrowing: only these role NAMES are forced into 2FA (empty = all
    # users when require_2fa is on). Lets a tenant mandate 2FA for admins only.
    require_2fa_roles: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    # --- session policy (surfaced per-tenant; advisory in v1) --------------
    # Idle/absolute session lifetime hint in minutes (0 = use the platform default).
    session_idle_minutes: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default=text("0")
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )


class DirectoryConfig(Base):
    """An LDAP / Active Directory server a tenant syncs identities from.

    ``bind_password`` is stored Fernet-encrypted (see ``core.secrets``); it is never
    returned by the API. A tenant may configure at most one directory in v1
    (``tenant_id`` unique), which is the common enterprise case.
    """

    __tablename__ = "directory_configs"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    tenant_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("tenants.id", ondelete="CASCADE"), index=True, unique=True, nullable=True
    )
    name: Mapped[str] = mapped_column(String, nullable=False, default="Directory")
    enabled: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default=text("true")
    )
    # Connection: ldap[s]://host:port  +  the search base.
    server_uri: Mapped[str] = mapped_column(String, nullable=False)  # e.g. ldaps://ad.corp:636
    base_dn: Mapped[str] = mapped_column(String, nullable=False)     # e.g. dc=corp,dc=example
    # Service account used to search the directory (encrypted password).
    bind_dn: Mapped[str] = mapped_column(String, nullable=False)
    bind_password: Mapped[str | None] = mapped_column(String, nullable=True)  # Fernet ciphertext
    use_ssl: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default=text("true")
    )
    # Search knobs. user_filter is a template with {username}; the *_attr columns map
    # LDAP attributes onto core user fields.
    user_dn_base: Mapped[str | None] = mapped_column(String, nullable=True)
    user_filter: Mapped[str] = mapped_column(
        String, nullable=False, default="(sAMAccountName={username})"
    )
    email_attr: Mapped[str] = mapped_column(String, nullable=False, default="mail")
    name_attr: Mapped[str] = mapped_column(String, nullable=False, default="displayName")
    group_attr: Mapped[str] = mapped_column(String, nullable=False, default="memberOf")
    # group DN (or CN) -> core role NAME. Users land in the mapped role on sync/login.
    group_role_map: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    # Fallback role name for users with no mapped group (empty = skip such users).
    default_role: Mapped[str | None] = mapped_column(String, nullable=True)
    last_sync_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class SsoConfig(Base):
    """An OIDC identity provider a tenant delegates login to (authorization-code).

    ``client_secret`` is Fernet-encrypted at rest and never returned by the API.
    """

    __tablename__ = "sso_configs"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    tenant_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("tenants.id", ondelete="CASCADE"), index=True, unique=True, nullable=True
    )
    provider: Mapped[str] = mapped_column(String, nullable=False, default="oidc")  # oidc | saml (future)
    enabled: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default=text("true")
    )
    # OIDC discovery issuer (we fetch /.well-known/openid-configuration from it).
    issuer: Mapped[str] = mapped_column(String, nullable=False)
    client_id: Mapped[str] = mapped_column(String, nullable=False)
    client_secret: Mapped[str | None] = mapped_column(String, nullable=True)  # Fernet ciphertext
    # Space-separated scopes; the redirect the IdP calls back to.
    scopes: Mapped[str] = mapped_column(String, nullable=False, default="openid email profile")
    redirect_uri: Mapped[str | None] = mapped_column(String, nullable=True)
    # Claim → core field mapping + JIT provisioning behaviour.
    email_claim: Mapped[str] = mapped_column(String, nullable=False, default="email")
    name_claim: Mapped[str] = mapped_column(String, nullable=False, default="name")
    # groups claim -> core role NAME (like the LDAP map). Optional.
    groups_claim: Mapped[str | None] = mapped_column(String, nullable=True)
    group_role_map: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    default_role: Mapped[str | None] = mapped_column(String, nullable=True)
    # If false, a callback for an unknown email is rejected (no just-in-time create).
    auto_provision: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default=text("true")
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class DualAuthRequest(Base):
    """A four-eyes approval ledger entry for a sensitive action.

    A flagged action (``action`` e.g. ``vms.export`` / ``recording.delete`` /
    ``tenant.delete``) is recorded as ``pending`` by its *requester*. It is only
    permitted once a DIFFERENT privileged user (``dualauth.approve``) approves it.
    The row is the durable record both core and satellite services (vision) check
    before performing the action.
    """

    __tablename__ = "dual_auth_requests"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    tenant_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, index=True, nullable=True)
    # What is being authorized + the target it acts on.
    action: Mapped[str] = mapped_column(String, nullable=False, index=True)
    target_type: Mapped[str | None] = mapped_column(String, nullable=True)
    target_id: Mapped[str | None] = mapped_column(String, nullable=True)
    reason: Mapped[str | None] = mapped_column(String, nullable=True)
    # Free-form context (camera id, time range, export format...) the approver sees.
    payload: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    # pending | approved | denied | consumed | expired
    status: Mapped[str] = mapped_column(
        String, nullable=False, default="pending", server_default=text("'pending'"), index=True
    )
    requested_by: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True)
    requested_by_email: Mapped[str | None] = mapped_column(String, nullable=True)
    decided_by: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True)
    decided_by_email: Mapped[str | None] = mapped_column(String, nullable=True)
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    decision_note: Mapped[str | None] = mapped_column(String, nullable=True)
    # When the pending request stops being approvable (a stale request is safer denied).
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False, index=True
    )
