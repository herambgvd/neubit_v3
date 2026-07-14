"""Pydantic I/O schemas for the enterprise security module (P6-D).

Secrets (LDAP bind password, OIDC client secret) are WRITE-ONLY: they are accepted
on create/update but never serialised back out — the *Out models expose only a
``has_secret`` flag so a UI can show "configured" without leaking the value.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


# --- Security policy (2FA enforcement) ---------------------------------------
class SecurityPolicyIn(BaseModel):
    require_2fa: bool | None = None
    require_2fa_roles: list[str] | None = None
    session_idle_minutes: int | None = None


class SecurityPolicyOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    require_2fa: bool = False
    require_2fa_roles: list[str] = Field(default_factory=list)
    session_idle_minutes: int = 0
    updated_at: datetime | None = None


# --- LDAP / AD directory -----------------------------------------------------
class DirectoryConfigIn(BaseModel):
    name: str = "Directory"
    enabled: bool = True
    server_uri: str
    base_dn: str
    bind_dn: str
    bind_password: str | None = None  # write-only
    use_ssl: bool = True
    user_dn_base: str | None = None
    user_filter: str = "(sAMAccountName={username})"
    email_attr: str = "mail"
    name_attr: str = "displayName"
    group_attr: str = "memberOf"
    group_role_map: dict = Field(default_factory=dict)
    default_role: str | None = None


class DirectoryConfigOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    enabled: bool
    server_uri: str
    base_dn: str
    bind_dn: str
    has_bind_password: bool = False
    use_ssl: bool
    user_dn_base: str | None
    user_filter: str
    email_attr: str
    name_attr: str
    group_attr: str
    group_role_map: dict
    default_role: str | None
    last_sync_at: datetime | None
    created_at: datetime


class DirectorySyncResult(BaseModel):
    created: int = 0
    updated: int = 0
    skipped: int = 0
    errors: list[dict] = Field(default_factory=list)
    live: bool = False  # False => scaffolding/fixture path (no live LDAP bind)


# --- OIDC SSO ----------------------------------------------------------------
class SsoConfigIn(BaseModel):
    provider: str = "oidc"
    enabled: bool = True
    issuer: str
    client_id: str
    client_secret: str | None = None  # write-only
    scopes: str = "openid email profile"
    redirect_uri: str | None = None
    email_claim: str = "email"
    name_claim: str = "name"
    groups_claim: str | None = None
    group_role_map: dict = Field(default_factory=dict)
    default_role: str | None = None
    auto_provision: bool = True


class SsoConfigOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    provider: str
    enabled: bool
    issuer: str
    client_id: str
    has_client_secret: bool = False
    scopes: str
    redirect_uri: str | None
    email_claim: str
    name_claim: str
    groups_claim: str | None
    group_role_map: dict
    default_role: str | None
    auto_provision: bool
    created_at: datetime


class SsoLoginStartOut(BaseModel):
    authorization_url: str
    state: str


class SsoCallbackIn(BaseModel):
    code: str
    state: str
    # Which tenant's SSO config to use (the login page carries it). Optional for a
    # platform-level SSO config (tenant_id NULL).
    tenant_id: uuid.UUID | None = None


# --- Dual authorization (four-eyes) ------------------------------------------
class DualAuthRequestIn(BaseModel):
    action: str
    target_type: str | None = None
    target_id: str | None = None
    reason: str | None = None
    payload: dict = Field(default_factory=dict)
    # Optional TTL in minutes for the pending request (0/None = no expiry).
    expires_in_minutes: int | None = None


class DualAuthDecisionIn(BaseModel):
    note: str | None = None


class DualAuthRequestOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    action: str
    target_type: str | None
    target_id: str | None
    reason: str | None
    payload: dict
    status: str
    requested_by: uuid.UUID | None
    requested_by_email: str | None
    decided_by: uuid.UUID | None
    decided_by_email: str | None
    decided_at: datetime | None
    decision_note: str | None
    expires_at: datetime | None
    created_at: datetime


# --- Video-ops audit ingest (DPDP/GDPR) --------------------------------------
class AuditIngestIn(BaseModel):
    """A satellite service (vision) reporting a sensitive video op for the trail.

    action e.g. ``vms.playback`` / ``vms.export`` / ``vms.recording.delete``.
    """

    action: str
    target_type: str | None = None
    target_id: str | None = None
    # who did it (satellite passes the acting user's id/email from the JWT it verified)
    actor_id: uuid.UUID | None = None
    actor_email: str | None = None
    tenant_id: uuid.UUID | None = None
    meta: dict = Field(default_factory=dict)


class ErasureRequestIn(BaseModel):
    """Right-to-erasure: erase a subject's video artefacts.

    subject_type e.g. ``camera`` / ``person``; subject_id the id in the owning
    service. Core records the request + fans it out to owning services over NATS;
    the physical deletion is performed by the service that owns the data.
    """

    subject_type: str
    subject_id: str
    reason: str | None = None
    # Restrict erasure to a camera / time-window (owning service interprets it).
    scope: dict = Field(default_factory=dict)


class ErasureRequestOut(BaseModel):
    id: uuid.UUID
    subject_type: str
    subject_id: str
    status: str
    dispatched_to: list[str] = Field(default_factory=list)
