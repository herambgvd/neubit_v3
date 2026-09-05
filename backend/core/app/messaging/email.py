"""Email delivery over SMTP, using the DB-stored (dynamic) email channel config.

There is no SMTP host in .env — the admin configures it from the UI, so we load
the decrypted "email" ChannelConfig at send time. If the channel is missing or
disabled we simply log and return ``False`` (a scenario firing a notification
shouldn't crash because email happens to be off).

Sending is async via ``aiosmtplib``. Everything is wrapped in try/except so a
flaky mail server never propagates an exception into the caller's request.
"""

from __future__ import annotations

import uuid

from email.message import EmailMessage

import aiosmtplib
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.logging import get_logger
from .config import get_channel, get_config_decrypted

log = get_logger("edge.messaging.email")


async def send_email(
    db: AsyncSession,
    to: list[str],
    subject: str,
    html: str,
    tenant_id: uuid.UUID | None = None,
) -> bool:
    """Send an HTML email to ``to`` via the configured SMTP server.

    Returns True on success, False if the channel is off / misconfigured / errored.
    Expected config fields: host, port, username, password, from_addr, use_tls.

    `tenant_id` selects WHOSE SMTP server. It was not a parameter at all, so every
    send resolved `get_channel(db, "email")` with tenant_id None — the
    platform-default row. A tenant that configured its own SMTP had it stored,
    masked and encrypted correctly, and never used: their mail went out through the
    platform's server, from the platform's address. Omitting it still means the
    platform default, which is right for platform-level mail and wrong silently for
    anything else, so the callers pass it.
    """
    if not to:
        log.warning("send_email called with no recipients; skipping")
        return False

    # Load config + honour the enabled flag (fetch the raw row for `enabled`,
    # then the decrypted view for the actual credentials).
    row = await get_channel(db, "email", tenant_id)
    if row is None or not row.enabled:
        log.info("email channel not configured or disabled; skipping send")
        return False
    cfg = await get_config_decrypted(db, "email", tenant_id) or {}

    host = cfg.get("host")
    from_addr = cfg.get("from_addr") or cfg.get("username")
    if not host or not from_addr:
        log.warning("email channel missing host/from_addr; skipping send")
        return False

    # Build a MIME message with an HTML body.
    msg = EmailMessage()
    msg["From"] = from_addr
    msg["To"] = ", ".join(to)
    msg["Subject"] = subject
    msg.set_content("This message requires an HTML-capable email client.")
    msg.add_alternative(html, subtype="html")

    try:
        await aiosmtplib.send(
            msg,
            hostname=host,
            port=int(cfg.get("port") or 587),
            username=cfg.get("username") or None,
            password=cfg.get("password") or None,
            start_tls=bool(cfg.get("use_tls", True)),
        )
        log.info("email sent to %d recipient(s): %s", len(to), subject)
        return True
    except Exception:  # never let a mail failure break the caller
        log.exception("failed to send email to %s", to)
        return False
