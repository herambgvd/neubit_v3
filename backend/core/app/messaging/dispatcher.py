"""The one seam scenarios call to notify people: ``notify(...)``.

Instead of a scenario knowing about SMTP, FCM and webhooks, it calls a single
``notify`` and picks channels by name. This module fans the request out:

  * ALWAYS writes an in-app Notification for each target user (the always-on bell).
  * "email"  → renders a template (or wraps ``body`` in <p>) and sends via SMTP.
  * "push"   → collects the users' device tokens and pushes via FCM.
  * "webhook"→ POSTs the payload to the configured webhook URL (HMAC-signed).

Each channel is isolated in its own try/except: if email is misconfigured, push
and webhook still go out, and the in-app record is already saved. Notifications
are best-effort — ``notify`` never raises into the caller's request.
"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.logging import get_logger
from . import inapp
from .config import get_channel, get_config_decrypted
from .email import send_email
from .push import DeviceToken, send_push
from .templates import render
from .webhook import send_webhook

log = get_logger("edge.messaging.dispatcher")


async def _notify_in_app(db: AsyncSession, user_ids: list, title: str, body) -> None:
    """One row per user, always. Isolated so a DB hiccup here does not stop the
    outbound channels."""
    for uid in user_ids:
        try:
            await inapp.create_notification(db, uid, title, body)
        except Exception:
            log.exception("failed to create in-app notification for user %s", uid)


async def _notify_email(
    db: AsyncSession, email_to: list, title: str, body, template, template_ctx, tenant_id
) -> None:
    """Render the named template if there is one, else a simple body."""
    try:
        if template:
            subject, html = render(template, template_ctx or {})
        else:
            subject, html = title, f"<p>{body or ''}</p>"
        await send_email(db, email_to, subject, html, tenant_id)
    except Exception:
        log.exception("email channel failed during notify")


async def _notify_push(
    db: AsyncSession, user_ids: list, title: str, body, push_data, tenant_id
) -> None:
    """Every device token owned by the target users."""
    try:
        result = await db.execute(
            select(DeviceToken.token).where(DeviceToken.user_id.in_(user_ids))
        )
        tokens = [t for (t,) in result.all()]
        if tokens:
            await send_push(db, tokens, title, body or "", push_data, tenant_id)
    except Exception:
        log.exception("push channel failed during notify")


async def _notify_webhook(
    db: AsyncSession, user_ids: list, title: str, body, tenant_id
) -> None:
    """POST the event to the configured URL, with its decrypted secret."""
    try:
        row = await get_channel(db, "webhook", tenant_id)
        if row is not None and row.enabled:
            cfg = await get_config_decrypted(db, "webhook", tenant_id) or {}
            url = cfg.get("url")
            if url:
                payload = {"title": title, "body": body, "user_ids": [str(u) for u in user_ids]}
                await send_webhook(url, payload, secret=cfg.get("secret"))
            else:
                log.info("webhook channel enabled but missing url; skipping")
    except Exception:
        log.exception("webhook channel failed during notify")


async def notify(
    db: AsyncSession,
    *,
    user_ids: list = None,
    title: str,
    body: str = None,
    channels: list[str] = None,
    template: str = None,
    template_ctx: dict = None,
    email_to: list[str] = None,
    push_data: dict = None,
    tenant_id=None,
) -> None:
    """Fan a notification out across in-app + the requested extra ``channels``.

    - ``tenant_id``    : whose channel config to send through. Omitted means the
                         platform default, which is silently wrong for a tenant
                         that configured its own SMTP, FCM project or webhook.
    - ``user_ids``     : recipients — each gets an in-app record + (for push) their tokens.
    - ``channels``     : any of "email" | "push" | "webhook" (in-app is always sent).
    - ``template``     : optional named template for the email subject/body.
    - ``email_to``     : explicit recipient addresses for the email channel.
    - ``push_data``    : optional data payload delivered alongside the push.
    """
    user_ids = user_ids or []
    channels = channels or []

    await _notify_in_app(db, user_ids, title, body)
    if "email" in channels and email_to:
        await _notify_email(db, email_to, title, body, template, template_ctx, tenant_id)
    if "push" in channels and user_ids:
        await _notify_push(db, user_ids, title, body, push_data, tenant_id)
    if "webhook" in channels:
        await _notify_webhook(db, user_ids, title, body, tenant_id)
