"""Render a core email template for a linkage ``notify`` action.

An operator can write and customise email templates in core's Templates screen,
but rendering lives in core (the override chain, the Jinja environment and the
branded shell are all there). Without this call a custom template was a document
nothing could send: the linkage rule composed its own subject/body string and the
templates were only ever used by the code paths inside core itself.

So a rule that names a ``template`` gets it rendered HERE, at publish time, and
publishes the RESULT on ``notify.request``. The workflow consumer and the SMTP
connector stay template-unaware — they deliver whatever body they are handed.

Best-effort, like every other cross-service call in this package: an unreachable
or unconfigured core returns None and the action falls back to its plain text. A
notification that degrades to plain wording still reaches the operator; one that
raises would lose the alert entirely.
"""

from __future__ import annotations

import logging

import httpx

from app.vms.common.service_token import mint_service_token

from .door_camera import _api_prefix, core_base_url

log = logging.getLogger("vision.linkage.core_templates")

_TIMEOUT = 8.0


async def render(
    tenant_id: str | None, name: str, context: dict
) -> tuple[str, str] | None:
    """``(subject, html)`` for template ``name``, or None when it can't be had.

    ``tenant_id`` travels in the BODY, not in the token: core cannot read a tenant
    off a service principal (it has no users row), and the tenant decides whose
    override wins.
    """
    base = core_base_url()
    if not base or not name:
        return None
    headers = {"Authorization": f"Bearer {mint_service_token(tenant_id=tenant_id)}"}
    body = {"context": context, "tenant_id": tenant_id}
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT, headers=headers) as client:
            r = await client.post(
                f"{base}{_api_prefix()}/messaging/templates/{name}/render", json=body
            )
        if r.status_code >= 400:
            log.info("template render %s → %s", name, r.status_code)
            return None
        data = r.json()
        subject, html = data.get("subject"), data.get("html")
        if not isinstance(subject, str) or not isinstance(html, str):
            return None
        return subject, html
    except httpx.HTTPError as exc:
        log.info("template render failed for %s: %s", name, exc)
        return None
    except Exception as exc:  # noqa: BLE001 — an action must never crash the engine
        log.warning("template render unexpected error for %s: %s", name, exc)
        return None
