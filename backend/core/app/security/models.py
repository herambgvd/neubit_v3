"""Enterprise security ORM models (P6-D).

Sits on top of the auth hardening in ``app/auth`` and the append-only
``app/core/audit`` trail:

  * :class:`SecurityPolicy` — per-tenant policy singleton; today the "require 2FA"
    toggle, and the home for future per-tenant session/password knobs.
  * :class:`DirectoryConfig` — an LDAP/AD server to sync users and groups from.
    Bind credentials are Fernet-encrypted at rest (``app/core/secrets``).
  * :class:`SsoConfig` — an OIDC identity provider; client secret encrypted too.
  * :class:`DualAuthRequest` — the four-eyes ledger: a flagged sensitive action is
    pending until a second privileged user approves or denies it.

All tables are tenant-scoped with a nullable ``tenant_id`` (NULL = a platform row),
like sites/tags/audit, so ``tenancy.scope`` applies unchanged. Column types are
generic (Uuid / JSON / Enum-as-String) so the models run on Postgres and SQLite.
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

    Carries the 2FA enforcement decision so a tenant-admin can mandate TOTP,
    optionally only for named roles. Its own table rather than a JSON blob in
    app_settings, so login can check it with one indexed lookup.
    """

    __tablename__ = "security_policies"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    # NULL = the platform-default policy: super-admins, and tenants with no row.
    tenant_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("tenants.id", ondelete="CASCADE"), index=True, unique=True, nullable=True
    )
    # --- 2FA enforcement ---------------------------------------------------
    # When true, every user in scope must have TOTP enrolled; a login without it
    # gets an "enroll 2FA" signal and the client routes to setup.
    require_2fa: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=text("false")
    )
    # Only these role names are forced into 2FA (empty = all users when
    # require_2fa is on), so a tenant can mandate 2FA for admins only.
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

    ``bind_password`` is Fernet-encrypted (see ``core.secrets``) and never returned
    by the API. At most one directory per tenant (``tenant_id`` unique).
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
    # user_filter is a template with {username}; the *_attr columns map LDAP
    # attributes onto core user fields.
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

    A flagged ``action`` (``vms.export``, ``recording.delete``, ...) is recorded as
    ``pending`` by its requester and permitted only once a different user holding
    ``dualauth.approve`` approves it. Core and satellite services check this row
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
    # When the pending request stops being approvable.
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False, index=True
    )
