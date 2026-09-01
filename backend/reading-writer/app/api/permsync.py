"""Publish each registered dataset's permission into CORE's catalog.

A dataset is registered as DATA — one INSERT into
`neubit_reporting.dashboard_datasets` — and it names the permission required to
read it. This service enforces that key. But a key core has never heard of fails
`PERMISSIONS.unknown()` on role create, so **no role can grant it** and only a
wildcard admin can reach the dataset.

That is precisely the bug the builder contract tells us not to repeat:
`ingest.read` / `ingest.manage` were gated by the backend and never registered.
Registering a key is not book-keeping; it is what makes the permission grantable.

So: whenever the registry is read, the keys it declares are pushed to core's
`POST /auth/permissions/registrations` with a short-lived superadmin service
token — the same pattern `vision` uses for the audit trail. Debounced, so a
dashboard of twenty widgets does not become twenty round trips, and BEST-EFFORT:
core being down must never make a chart fail to draw. A failure is logged and
retried on the next read.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time

import httpx
import jwt
from kernel.config import get_settings

log = logging.getLogger("reading_writer.permsync")

_SYSTEM_SUB = "00000000-0000-0000-0000-0000000000b1"  # "…b1" ≈ building intelligence
_TTL_SEC = 120
_TIMEOUT = 4.0
# One push per interval at most. Long enough that a busy dashboard costs nothing,
# short enough that a dataset registered now is grantable within a minute.
_DEBOUNCE_SEC = 60.0

_last_push: float = 0.0
_last_payload: tuple | None = None
_lock = asyncio.Lock()


def _core_url() -> str | None:
    base = (os.getenv("VE_CORE_URL") or "").rstrip("/")
    if not base:
        return None
    prefix = os.getenv("VE_API_PREFIX", "/api/v1")
    return f"{base}{prefix}/auth/permissions/registrations"


def _token() -> str:
    now = int(time.time())
    return jwt.encode(
        {
            "sub": _SYSTEM_SUB,
            "type": "access",
            "tenant_id": None,
            "is_superadmin": True,
            "permissions": ["*"],
            "iat": now,
            "exp": now + _TTL_SEC,
        },
        get_settings().jwt_secret,
        algorithm="HS256",
    )


async def sync(datasets) -> None:
    """Push every dataset's permission to core. Never raises."""
    global _last_push, _last_payload
    url = _core_url()
    if not url:
        return
    payload = tuple(
        sorted(
            (d.permission, d.permission_label or f"Read the '{d.name}' dataset", d.permission_group)
            for d in datasets
        )
    )
    if not payload:
        return
    now = time.monotonic()
    if payload == _last_payload and now - _last_push < _DEBOUNCE_SEC:
        return
    async with _lock:
        if payload == _last_payload and time.monotonic() - _last_push < _DEBOUNCE_SEC:
            return
        body = {
            "source": "reading-writer",
            "permissions": [
                {
                    "key": key,
                    "label": label,
                    "group": group,
                    "description": "Read this dataset in the dashboard builder.",
                }
                for key, label, group in payload
            ],
        }
        try:
            async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
                r = await client.post(
                    url, json=body, headers={"Authorization": f"Bearer {_token()}"}
                )
            if r.status_code >= 300:
                log.warning("permission registration refused by core: %s %s", r.status_code, r.text[:200])
                return
            _last_push, _last_payload = time.monotonic(), payload
            log.info("registered %d dataset permission(s) with core", len(body["permissions"]))
        except Exception as exc:  # noqa: BLE001 — a chart must draw even if core is down
            log.warning("permission registration failed (will retry): %s", exc)
