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
        # A body rendered from a core email template is an HTML document. Sent as
        # set_content() it arrives as visible markup, so it goes as an HTML part
        # with a text/plain alternative for clients that refuse HTML.
        if ctx.metadata.get("html"):
            msg.set_content(_plain_text(ctx.body))
            msg.add_alternative(ctx.body, subtype="html")
        else:
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


def _plain_text(html: str) -> str:
    """A readable text/plain fallback for an HTML body.

    Not a converter — it strips tags and unescapes the handful of entities the
    templates produce, so a text-only client gets the words rather than markup.
    """
    import html as _html
    import re

    text = re.sub(r"(?is)<(script|style)\b.*?</\1>", "", html)
    text = re.sub(r"(?i)<(br|/p|/div|/h[1-6]|/tr)\s*/?>", "\n", text)
    text = re.sub(r"(?s)<[^>]+>", "", text)
    text = _html.unescape(text)
    # Collapse the blank runs the stripped block tags leave behind.
    text = re.sub(r"[ \t]+", " ", text)
    # `[ \t]`, not `\s`: \s matches \n too, so `\n\s*\n\s*\n+` can parse one run of
    # newlines in many ways and the engine tries them. A long stretch of blank
    # lines in a forwarded email is enough to make that bite.
    text = re.sub(r"(?:\n[ \t]*){3,}", "\n\n", text)
    return text.strip()
