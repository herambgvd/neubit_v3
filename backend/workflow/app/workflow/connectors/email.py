"""Email connector — SMTP delivery.

Provider config comes from the tenant's ``NotificationChannel.config`` (a dict
with host/port/username/password/from_address/use_tls). When no channel row is
configured the connector falls back to service-level SMTP env vars
(``VE_SMTP_*``) if present.

SMTP send is lazy-imported so the service boots without ``aiosmtplib`` installed
(the dependency is only needed when email is actually configured + dispatched).
"""

from __future__ import annotations

import logging
import os

from .base import Connector, DeliveryContext

log = logging.getLogger("workflow.connectors.email")


class EmailConnector(Connector):
    channel_type = "email"

    async def send(self, ctx: DeliveryContext) -> None:
        cfg = ctx.channel_config or {}
        host = cfg.get("host") or cfg.get("smtp_host") or os.getenv("VE_SMTP_HOST")
        if not host:
            raise RuntimeError("email connector: no SMTP host configured (channel or VE_SMTP_HOST)")
        port = int(cfg.get("port") or cfg.get("smtp_port") or os.getenv("VE_SMTP_PORT") or 587)
        username = cfg.get("username") or cfg.get("smtp_username") or os.getenv("VE_SMTP_USERNAME")
        password = cfg.get("password") or cfg.get("smtp_password") or os.getenv("VE_SMTP_PASSWORD")
        from_addr = (
            cfg.get("from_address")
            or cfg.get("smtp_from")
            or os.getenv("VE_SMTP_FROM")
            or username
            or "no-reply@neubit.local"
        )
        use_tls = bool(cfg.get("use_tls", cfg.get("smtp_use_tls", True)))

        from email.message import EmailMessage

        import aiosmtplib  # lazy — only needed when email is actually dispatched

        msg = EmailMessage()
        msg["From"] = from_addr
        msg["To"] = ctx.recipient
        msg["Subject"] = ctx.subject or "(no subject)"
        msg.set_content(ctx.body)

        # Port 465 = implicit TLS (SMTPS); 587/25 = STARTTLS upgrade.
        implicit_tls = port == 465
        starttls = (not implicit_tls) and use_tls
        await aiosmtplib.send(
            msg,
            hostname=host,
            port=port,
            username=username or None,
            password=password or None,
            use_tls=implicit_tls,
            start_tls=starttls,
        )
        log.info("email delivered to %s (tenant=%s)", ctx.recipient, ctx.tenant_id)
