"""Render a core email template for a workflow notification.

An operator writes and previews email templates in core's Templates screen — with
the block designer, the variables list and the branded shell. This service had its
own separate template store and no way to reach those, so the two lived side by
side: one with a designer nobody could use for incidents, one with a textarea.

A transition's notify action can name a CORE template; this renders it there (the
override chain, the Jinja environment and the branding all live in core) and the
transition stores the result. Downstream is unchanged — the outbox row carries a
subject and a body like any other.

Best-effort, like every cross-service call: core unreachable or the name unknown
returns None and the caller falls back to its own template or its inline strings.
A notification that degrades to plain wording still reaches the operator.
"""

from __future__ import annotations

import logging
import os

import httpx

from .service_token import mint_service_token

log = logging.getLogger("workflow.core_templates")

_TIMEOUT = 8.0


def core_base_url() -> str | None:
    """Core's base URL (``VE_CORE_URL``); None disables the feature."""
    url = (os.environ.get("VE_CORE_URL") or "").strip()
    return url.rstrip("/") or None


def _api_prefix() -> str:
    return (os.environ.get("VE_API_PREFIX") or "/api/v1").rstrip("/")


async def render(tenant_id, name: str, context: dict) -> tuple[str, str] | None:
    """``(subject, html)`` for core template ``name``, or None when it cannot be had.

    ``tenant_id`` travels in the BODY: core cannot read a tenant off a service
    principal, and the tenant decides whose override of the template wins.
    """
    base = core_base_url()
    if not base or not name:
        return None
    tid = str(tenant_id) if tenant_id else None
    headers = {"Authorization": f"Bearer {mint_service_token(tenant_id=tid)}"}
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT, headers=headers) as client:
            r = await client.post(
                f"{base}{_api_prefix()}/messaging/templates/{name}/render",
                json={"context": context, "tenant_id": tid},
            )
        if r.status_code >= 400:
            log.info("core template render %s → %s", name, r.status_code)
            return None
        data = r.json()
        subject, html = data.get("subject"), data.get("html")
        if not isinstance(subject, str) or not isinstance(html, str):
            return None
        return subject, html
    except httpx.HTTPError as exc:
        log.info("core template render failed for %s: %s", name, exc)
        return None
    except Exception as exc:  # noqa: BLE001 — a transition must not fail on this
        log.warning("core template render unexpected error for %s: %s", name, exc)
        return None
