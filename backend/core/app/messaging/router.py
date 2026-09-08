"""Messaging API: channel config (admin) + device registration + in-app inbox.

Two audiences:
  * an admin (settings.manage) configures and tests the delivery channels;
  * the signed-in user registers their mobile device and reads their inbox.

Mount alongside the other routers:

    from app.messaging import router as messaging_router
    app = create_app(registry, extra_routers=[messaging_router])
"""

from __future__ import annotations

import re

import uuid

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth.deps import get_current_user, require_permission
from ..auth.models import User
from ..auth.permissions import CorePerm
from ..core.errors import NotFoundError, ValidationError
from ..core.pagination import Page, PageParams, page_params, paginate
from ..db.base import get_db
from sqlalchemy import select

from . import config as channel_config
from . import inapp
from . import templates as email_templates
from . import template_store
from .config import SECRET_FIELDS
from .email import send_email
from .push import DeviceToken, register_device, send_push
from .template_store import EmailTemplate
from .templates import render_with_overrides
from .webhook import send_webhook

router = APIRouter(prefix="/messaging", tags=["messaging"])

# Channels that can be configured/tested. Kept in sync with SECRET_FIELDS' keys.
_CHANNELS = set(SECRET_FIELDS)


# --- schemas -----------------------------------------------------------------
class ChannelOut(BaseModel):
    """A channel's config for the admin UI — secret fields are masked to "***"."""

    channel: str
    enabled: bool
    config: dict


class ChannelUpdateIn(BaseModel):
    enabled: bool = False
    config: dict = {}


class DeviceIn(BaseModel):
    token: str
    platform: str = "android"  # "android" | "ios"


class DeviceOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    platform: str


class NotificationOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    title: str
    body: str | None
    read: bool
    ts: object  # datetime — pydantic serialises it


class TemplateSummaryOut(BaseModel):
    """One row in the templates list — is this built-in name overridden?"""

    name: str
    overridden: bool
    subject: str


class TemplateOut(BaseModel):
    """The effective template for a name: the override if present, else the default."""

    name: str
    subject: str
    html: str
    is_override: bool
    #: The placeholders this template is rendered with. Served rather than
    #: hardcoded in the client: an operator who cannot write Jinja is offered this
    #: list, and a list the frontend invented would drift from what the sender
    #: actually passes.
    variables: list[str] = []
    #: False for a name the product has no sender for. Nothing in this service
    #: renders a custom name today, so the editor can say so instead of implying
    #: a template that will never be delivered.
    is_builtin: bool = True


class TemplateUpsertIn(BaseModel):
    subject: str
    html: str


#: A template name is a URL path segment and a Jinja lookup key. Anything with a
#: slash, a space or a dot either changes which route is hit or produces a name
#: that cannot be addressed again — so the shape is enforced on the way in rather
#: than discovered when a template turns out to be unreachable.
_NAME_RE = re.compile(r"^[a-z][a-z0-9_]{1,48}$")


def _require_valid_name(name: str) -> None:
    if not _NAME_RE.match(name or ""):
        raise ValidationError(
            "a template name is lower-case letters, digits and underscores "
            "(2-49 characters), starting with a letter"
        )


def _require_known_channel(channel: str) -> None:
    if channel not in _CHANNELS:
        raise ValidationError(f"unknown channel '{channel}' (known: {', '.join(sorted(_CHANNELS))})")


# --- channel config (admin, settings.manage) ---------------------------------
# A tenant-admin sees and edits their own tenant's channel config (reads fall back
# to the platform default); a super-admin (tenant_id None) edits the platform
# default. Every helper below threads ``user.tenant_id``.
@router.get("/channels", response_model=list[ChannelOut])
async def list_channels(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission(CorePerm.SETTINGS_MANAGE)),
) -> list[ChannelOut]:
    """List every channel's config (masked). Channels never configured show defaults."""
    out: list[ChannelOut] = []
    for channel in sorted(_CHANNELS):
        row = await channel_config.get_channel(db, channel, user.tenant_id)
        if row is None:
            out.append(ChannelOut(channel=channel, enabled=False, config={}))
        else:
            out.append(
                ChannelOut(
                    channel=channel,
                    enabled=row.enabled,
                    config=channel_config.masked(row.config, channel),
                )
            )
    return out


@router.get("/channels/{channel}", response_model=ChannelOut)
async def get_channel(
    channel: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission(CorePerm.SETTINGS_MANAGE)),
) -> ChannelOut:
    """Get one channel's masked config."""
    _require_known_channel(channel)
    row = await channel_config.get_channel(db, channel, user.tenant_id)
    if row is None:
        return ChannelOut(channel=channel, enabled=False, config={})
    return ChannelOut(
        channel=channel,
        enabled=row.enabled,
        config=channel_config.masked(row.config, channel),
    )


@router.put("/channels/{channel}", response_model=ChannelOut)
async def update_channel(
    channel: str,
    data: ChannelUpdateIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission(CorePerm.SETTINGS_MANAGE)),
) -> ChannelOut:
    """Create/update the caller's channel config (secret fields encrypted at rest)."""
    _require_known_channel(channel)
    row = await channel_config.upsert_channel(
        db, channel, data.enabled, data.config, user.tenant_id
    )
    return ChannelOut(
        channel=channel,
        enabled=row.enabled,
        config=channel_config.masked(row.config, channel),
    )


@router.post("/channels/{channel}/test")
async def test_channel(
    channel: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission(CorePerm.SETTINGS_MANAGE)),
) -> dict:
    """Fire a test message on ``channel`` so the admin can confirm it's wired up."""
    _require_known_channel(channel)
    ok = False
    if channel == "email":
        to = [user.email] if user.email else []
        ok = await send_email(
            db, to, "Test notification", "<p>This is a test email from edge messaging.</p>"
        )
    elif channel == "push":
        # Push a test to the current admin's own registered devices.
        result = await db.execute(
            select(DeviceToken.token).where(DeviceToken.user_id == user.id)
        )
        tokens = [t for (t,) in result.all()]
        ok = await send_push(
            db, tokens, "Test notification", "This is a test push.", tenant_id=user.tenant_id
        )
    elif channel == "webhook":
        # The caller's own row, no platform-default fallback: otherwise a tenant
        # admin with no webhook could fire the platform's webhook URL signed with
        # the platform's secret on demand, using it as an oracle.
        row = await channel_config.get_channel_exact(db, channel, user.tenant_id)
        if row is None:
            raise ValidationError(
                "no webhook is configured for this tenant", code="NOT_CONFIGURED"
            )
        cfg = channel_config.decrypt_config(row)
        ok = await send_webhook(
            cfg.get("url", ""), {"test": True, "message": "edge messaging test"},
            secret=cfg.get("secret"),
        )
    return {"channel": channel, "sent": ok}


# --- device registration (user) ----------------------------------------------
@router.post("/devices", response_model=DeviceOut)
async def register_device_endpoint(
    data: DeviceIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> DeviceOut:
    """Register the caller's mobile FCM token (upsert on the token)."""
    row = await register_device(db, user, data.token, data.platform)
    return DeviceOut.model_validate(row)


# --- in-app inbox (user) -----------------------------------------------------
@router.get("/notifications", response_model=Page[NotificationOut])
async def list_notifications(
    params: PageParams = Depends(page_params),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Page[NotificationOut]:
    """The caller's own notifications, newest first."""
    return await paginate(db, inapp.list_query(user.id), params, item_model=NotificationOut)


@router.post("/notifications/{notif_id}/read")
async def mark_notification_read(
    notif_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """Mark one of the caller's notifications as read (404 if not theirs)."""
    row = await inapp.mark_read(db, notif_id, user.id)
    if row is None:
        raise NotFoundError("notification not found")
    return {"id": str(row.id), "read": row.read}


# --- email templates (admin, settings.manage) --------------------------------
# Admins customise the built-in email templates from the DB; a missing override
# falls back to the code default (see templates.render_with_overrides). Overrides
# resolve and write in the caller's scope, with reads falling back to the platform
# default (see template_store.get_override).
@router.get("/templates", response_model=list[TemplateSummaryOut])
async def list_templates(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission(CorePerm.SETTINGS_MANAGE)),
) -> list[TemplateSummaryOut]:
    """Every template an admin can edit: the built-ins, plus any custom override.

    Custom names were INVISIBLE here — the store has always accepted one (see
    template_store) and this listed only the built-ins, so a custom override could
    exist and never be seen or removed through the API that created it.
    """
    out: list[TemplateSummaryOut] = []
    builtins = email_templates.available_template_names()
    for name in builtins:
        override = await template_store.get_override(db, name, user.tenant_id)
        if override is not None:
            out.append(
                TemplateSummaryOut(name=name, overridden=True, subject=override.subject)
            )
        else:
            out.append(
                TemplateSummaryOut(
                    name=name,
                    overridden=False,
                    subject=email_templates.DEFAULT_TEMPLATES[name]["subject"],
                )
            )
    custom = (await db.execute(template_store.list_overrides(db, user.tenant_id))).scalars().all()
    for row in custom:
        if row.name not in builtins:
            out.append(
                TemplateSummaryOut(name=row.name, overridden=True, subject=row.subject)
            )
    return out


@router.get("/templates/{name}", response_model=TemplateOut)
async def get_template(
    name: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission(CorePerm.SETTINGS_MANAGE)),
) -> TemplateOut:
    """The effective template for ``name`` — the override if set, else the default."""
    override = await template_store.get_override(db, name, user.tenant_id)
    is_builtin = name in email_templates.DEFAULT_TEMPLATES
    if override is not None:
        return TemplateOut(
            name=name,
            subject=override.subject,
            html=override.html,
            is_override=True,
            variables=email_templates.variables_for(name),
            is_builtin=is_builtin,
        )
    default = email_templates.DEFAULT_TEMPLATES.get(name)
    if default is None:
        known = ", ".join(sorted(email_templates.DEFAULT_TEMPLATES))
        raise NotFoundError(f"unknown template '{name}' (known: {known})")
    return TemplateOut(
        name=name,
        subject=default["subject"],
        html=default["html"],
        is_override=False,
        variables=email_templates.variables_for(name),
        is_builtin=True,
    )


@router.get("/templates/{name}/preview")
async def preview_template(
    name: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission(CorePerm.SETTINGS_MANAGE)),
) -> dict:
    """Render the (effective) template with realistic sample data and a branded
    email shell, so admins see a real email — not raw Jinja placeholders."""
    from ..branding import service as branding_service

    branding = await branding_service.resolve(db, user.tenant_id)
    subject, html = await email_templates.render_preview(
        db, name, app_name=branding.app_name, tenant_id=user.tenant_id
    )
    return {"subject": subject, "html": html}


@router.put("/templates/{name}", response_model=TemplateOut)
async def upsert_template(
    name: str,
    data: TemplateUpsertIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission(CorePerm.SETTINGS_MANAGE)),
) -> TemplateOut:
    """Create/update the caller's override for ``name`` (built-in or custom name)."""
    _require_valid_name(name)
    row = await template_store.upsert_override(
        db, name, data.subject, data.html, user.tenant_id
    )
    return TemplateOut(
        name=row.name,
        subject=row.subject,
        html=row.html,
        is_override=True,
        variables=email_templates.variables_for(row.name),
        is_builtin=row.name in email_templates.DEFAULT_TEMPLATES,
    )


@router.delete("/templates/{name}")
async def delete_template(
    name: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission(CorePerm.SETTINGS_MANAGE)),
) -> dict:
    """Remove the caller's own override for ``name``, reverting to the fallback.
    404 if the caller has no override of their own."""
    deleted = await template_store.delete_override(db, name, user.tenant_id)
    if not deleted:
        raise NotFoundError(f"no override for template '{name}'")
    return {"name": name, "reverted": True}
