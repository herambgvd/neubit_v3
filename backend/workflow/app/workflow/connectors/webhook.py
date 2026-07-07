"""Webhook connector — HTTP POST delivery.

Posts a JSON body ``{subject, body, metadata, recipient}`` to a target URL. The
URL + optional headers come from the tenant's channel config; if the channel has
no ``url`` the notification's ``recipient`` is treated as the target URL (so a
webhook notification can carry its own destination).

``httpx`` is lazy-imported so the service boots without it installed.
"""

from __future__ import annotations

import logging

from .base import Connector, DeliveryContext

log = logging.getLogger("workflow.connectors.webhook")


class WebhookConnector(Connector):
    channel_type = "webhook"

    async def send(self, ctx: DeliveryContext) -> None:
        cfg = ctx.channel_config or {}
        url = cfg.get("url") or ctx.recipient
        if not url:
            raise RuntimeError("webhook connector: no target URL (channel.config.url or recipient)")
        headers = cfg.get("headers") or {}
        timeout = float(cfg.get("timeout", 10))

        import httpx  # lazy — only needed when a webhook is actually dispatched

        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(
                url,
                json={
                    "subject": ctx.subject,
                    "body": ctx.body,
                    "recipient": ctx.recipient,
                    "metadata": ctx.metadata,
                    "tenant_id": ctx.tenant_id,
                },
                headers=headers,
            )
            resp.raise_for_status()
        log.info("webhook delivered to %s (tenant=%s)", url, ctx.tenant_id)
