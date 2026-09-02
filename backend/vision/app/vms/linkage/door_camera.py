"""Door → camera resolution for access↔video verification (P5-B).

When an access door event fires (``tenant.<id>.access.door.forced`` etc.), the linkage
engine must find the camera(s) that watch that door so it can pop + record the video for
the door event. There are TWO resolution strategies, tried in order:

1. **Explicit mapping (primary, no cross-service call).** A linkage rule carries a
   door↔camera map in its ``trigger_filter``:

       {"door_camera_map": {"<door_ref>": ["<camera_id>", ...],
                            "*": ["<default_camera_id>"]}}

   The ``"*"`` key is a catch-all camera used when a door_ref has no explicit entry.
   This is deterministic, tenant-local (the rule is tenant-scoped), needs no core call,
   and is the default the P5-C UI writes. It is ALWAYS consulted first.

2. **Placement proximity (optional, core device-placements API).** If no explicit map
   resolves and ``VE_CORE_URL`` is set, we ask core WHERE the door sits (its
   ``zone_id`` / ``floor_id`` from ``GET /device-placements/{door_ref}``) and which
   cameras are placed in the SAME zone (falling back to the same floor) via
   ``GET /device-placements/by-floor/{floor_id}?device_type=camera``. Cameras in the
   same zone are "at the door"; same-floor cameras are the wider fallback. The call
   uses a short-lived service token (superadmin) and is best-effort — an unreachable /
   unconfigured core simply yields no proximity cameras (the explicit map still works).

Graceful: any failure returns ``[]`` (or just the explicit matches) — a door event with
no resolvable camera still fires the rule's non-camera actions (e.g. a bare ``popup`` /
``notify``) and is audited; it never raises into the consumer.
"""

from __future__ import annotations

import logging
import os

import httpx

from app.vms.common.service_token import mint_service_token

log = logging.getLogger("vision.linkage.door_camera")

_DEFAULT_TIMEOUT = 8.0


def core_base_url() -> str | None:
    """The core service base URL for the placement lookup (``VE_CORE_URL``); None = off."""
    url = (os.environ.get("VE_CORE_URL") or "").strip()
    return url.rstrip("/") or None


def _api_prefix() -> str:
    return (os.environ.get("VE_API_PREFIX") or "/api/v1").rstrip("/")


def resolve_explicit(rule_filter: dict | None, door_ref: str | None) -> list[str]:
    """Cameras from a rule's explicit ``door_camera_map`` (+ the ``"*"`` catch-all).

    Returns the union of the door_ref's mapped cameras and the catch-all, de-duped and
    order-preserving. Never raises.
    """
    if not isinstance(rule_filter, dict):
        return []
    mapping = rule_filter.get("door_camera_map")
    if not isinstance(mapping, dict):
        return []
    out: list[str] = []
    for key in (door_ref, "*"):
        if key is None:
            continue
        val = mapping.get(key)
        if isinstance(val, str):
            val = [val]
        if isinstance(val, list):
            for cam in val:
                if isinstance(cam, str) and cam and cam not in out:
                    out.append(cam)
    return out


async def resolve_by_placement(
    tenant_id: str | None, door_ref: str | None
) -> list[str]:
    """Cameras placed in the door's zone (then floor) via the core placements API.

    Best-effort: returns ``[]`` when core is unconfigured / unreachable / the door has no
    placement. Uses a short-lived superadmin service token so the background consumer can
    call core without an operator bearer.
    """
    base = core_base_url()
    if not base or not door_ref:
        return []
    token = mint_service_token(tenant_id=tenant_id)
    headers = {"Authorization": f"Bearer {token}"}
    prefix = _api_prefix()
    try:
        async with httpx.AsyncClient(timeout=_DEFAULT_TIMEOUT, headers=headers) as client:
            # 1. Where does the door sit?
            door = await client.get(f"{base}{prefix}/device-placements/{door_ref}")
            if door.status_code >= 400:
                log.info("door placement lookup %s → %s", door_ref, door.status_code)
                return []
            dp = door.json()
            zone_id = dp.get("zone_id")
            floor_id = dp.get("floor_id")

            cameras: list[str] = []
            # 2a. Same-zone cameras (closest — "at the door").
            if zone_id:
                zr = await client.get(f"{base}{prefix}/device-placements/by-zone/{zone_id}")
                if zr.status_code < 400:
                    cameras = _cameras_from(zr.json())
            # 2b. Fallback to same-floor cameras when the zone has none.
            if not cameras and floor_id:
                fr = await client.get(
                    f"{base}{prefix}/device-placements/by-floor/{floor_id}",
                    params={"device_type": "camera"},
                )
                if fr.status_code < 400:
                    cameras = _cameras_from(fr.json())
            return cameras
    except httpx.HTTPError as exc:
        log.info("placement proximity lookup failed for door %s: %s", door_ref, exc)
        return []
    except Exception as exc:  # noqa: BLE001 — resolution must never crash the consumer
        log.warning("placement proximity unexpected error for door %s: %s", door_ref, exc)
        return []


def _cameras_from(body: dict) -> list[str]:
    """Extract camera device_ids from a device-placements list response.

    The core list response is ``{items: [{device_id, device_type, service, ...}], count}``.
    We keep placements whose ``device_type``/``service`` marks them as a VMS camera.
    """
    out: list[str] = []
    items = (body or {}).get("items") or []
    for it in items:
        if not isinstance(it, dict):
            continue
        dtype = (it.get("device_type") or "").lower()
        service = (it.get("service") or "").lower()
        if dtype == "camera" or service in {"vms", "vision"}:
            dev = it.get("device_id")
            if isinstance(dev, str) and dev and dev not in out:
                out.append(dev)
    return out


async def resolve_cameras_for_door(
    tenant_id: str | None, door_ref: str | None, rule_filter: dict | None
) -> tuple[list[str], str]:
    """Resolve the camera(s) for a door event. Returns ``(camera_ids, strategy)``.

    Explicit map wins; placement proximity is the fallback. ``strategy`` is
    ``"explicit"`` / ``"placement"`` / ``"none"`` (for the fire-audit).
    """
    explicit = resolve_explicit(rule_filter, door_ref)
    if explicit:
        return explicit, "explicit"
    proximity = await resolve_by_placement(tenant_id, door_ref)
    if proximity:
        return proximity, "placement"
    return [], "none"
