"""Notification template / channel / device-token request + response schemas.

``ChannelPublic`` echoes ``config`` back with every CREDENTIAL FIELD REDACTED. The
docstring here used to claim it did not echo config at all; ``from_row`` passed
``config=r.config or {}`` straight through, so ``GET /workflow/notifications/channels``
handed the SMTP password and every provider API token to anyone holding
``workflow.notification.read`` -- a read permission is not a credential-read
permission, and that was the widest of the two ways these secrets escaped.

DELIBERATELY NOT dropping ``config`` from the response. The admin UI has to render
the host, port, URL and TLS flag it is editing, and a channel whose config is
invisible is a channel nobody can debug. The credential leaves; the routing stays.
The redaction marker is also accepted BACK on update to mean "unchanged" -- see
``notifications/secrets.py::restore_redacted``, which is what stops the UI from
re-submitting the asterisks as the new password.
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field

from kernel.secrets import redact_fields

from .secrets import REDACTED, is_secret_path

# ── Notification template / channel ────────────────────────────────────


class CreateTemplateRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    name: str = Field(min_length=1, max_length=255)
    description: Optional[str] = None
    channel_type: str = "email"
    subject: Optional[str] = None
    body: str
    provider_template_ref: Optional[str] = None
    is_active: bool = True


class UpdateTemplateRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    name: Optional[str] = None
    description: Optional[str] = None
    channel_type: Optional[str] = None
    subject: Optional[str] = None
    body: Optional[str] = None
    provider_template_ref: Optional[str] = None
    is_active: Optional[bool] = None


class TemplatePublic(BaseModel):
    model_config = ConfigDict(extra="ignore")
    template_id: str
    name: str
    description: Optional[str] = None
    channel_type: str
    subject: Optional[str] = None
    body: str
    provider_template_ref: Optional[str] = None
    is_active: bool
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_row(cls, r) -> "TemplatePublic":
        return cls(
            template_id=r.template_id, name=r.name, description=r.description,
            channel_type=r.channel_type, subject=r.subject, body=r.body,
            provider_template_ref=r.provider_template_ref,
            is_active=r.is_active, created_at=r.created_at, updated_at=r.updated_at,
        )


class CreateChannelRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    name: str = Field(min_length=1, max_length=255)
    channel_type: str  # email | webhook | whatsapp | mobile_push | sms
    config: dict = Field(default_factory=dict)
    is_enabled: bool = True
    is_default: bool = False


class UpdateChannelRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    name: Optional[str] = None
    channel_type: Optional[str] = None
    config: Optional[dict] = None
    is_enabled: Optional[bool] = None
    is_default: Optional[bool] = None


class ChannelPublic(BaseModel):
    model_config = ConfigDict(extra="ignore")
    channel_id: str
    name: str
    channel_type: str
    config: dict = Field(default_factory=dict)
    is_enabled: bool
    is_default: bool
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_row(cls, r) -> "ChannelPublic":
        return cls(
            channel_id=r.channel_id, name=r.name, channel_type=r.channel_type,
            config=redact_fields(r.config or {}, is_secret_path, REDACTED) or {},
            is_enabled=r.is_enabled, is_default=r.is_default,
            created_at=r.created_at, updated_at=r.updated_at,
        )


# ── Device tokens (mobile push registration) ───────────────────────────


class RegisterDeviceTokenRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    platform: str = Field(pattern="^(fcm|apns)$")  # fcm (Android/web) | apns (iOS)
    token: str = Field(min_length=1, max_length=512)
    label: Optional[str] = Field(default=None, max_length=255)


class UnregisterDeviceTokenRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    platform: str = Field(pattern="^(fcm|apns)$")
    token: str = Field(min_length=1, max_length=512)


class DeviceTokenPublic(BaseModel):
    model_config = ConfigDict(extra="ignore")
    device_token_id: str
    user_id: str
    platform: str
    # The raw provider token is masked in responses (only the tail is shown) so it
    # is never re-exposed once registered.
    token_masked: str
    label: Optional[str] = None
    is_active: bool
    last_used_at: Optional[datetime] = None
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_row(cls, r) -> "DeviceTokenPublic":
        tok = r.token or ""
        masked = ("…" + tok[-6:]) if len(tok) > 6 else "…"
        return cls(
            device_token_id=r.device_token_id, user_id=r.user_id, platform=r.platform,
            token_masked=masked, label=r.label, is_active=r.is_active,
            last_used_at=r.last_used_at, created_at=r.created_at, updated_at=r.updated_at,
        )


