"""VMS domain-event publishing on the NATS spine.

Two subject families ride the platform convention (built by
``kernel.events.subject`` → ``tenant.<tenant_id>.<domain>.<event>``):

  * ``tenant.<id>.device.camera.registered|updated|deregistered`` — the DEVICE
    lifecycle stream core/sites + the Events **Map** already consume (a camera is a
    "device" placed on a floor-plan, just like an access door). Payload carries the
    placement refs (``site_id``/``floor_id``) so the Map can drop a marker.
  * ``tenant.<id>.vms.camera.status`` — the VMS realtime stream (workflow correlation
    + realtime already subscribe ``tenant.*.vms.>``). Emitted on a status transition.

Mirrors the access service's ``events.py`` (a process-wide ``EventBus`` the API
connects at startup). Publishing is best-effort + a no-op when NATS is disabled
(``VE_NATS_URL`` unset), so it never breaks onboarding. ``tenant_id`` NULL (a
platform/system row) publishes under the reserved ``platform`` segment.
"""

from __future__ import annotations

import uuid

from kernel.events import EventBus, subject

# Process-wide bus (source tag = "vision"). ``app.main`` connects this at startup;
# the service imports it to publish. Keeping a single module-level bus (rather than
# threading one through every call) matches the access service.
bus = EventBus(source="vision")


def _tid(tenant_id: uuid.UUID | str | None) -> str | None:
    return str(tenant_id) if tenant_id is not None else None


async def emit_camera_lifecycle(
    tenant_id: uuid.UUID | str | None,
    event: str,
    payload: dict,
    *,
    _bus: EventBus | None = None,
) -> str:
    """Publish ``tenant.<id>.device.camera.<event>`` (registered|updated|deregistered).

    This is the DEVICE stream (core/sites + Events Map). Returns the targeted
    subject for logging. Best-effort — never raises.
    """
    tid = _tid(tenant_id)
    subj = subject(tid, "device", f"camera.{event}")
    await (_bus or bus).publish(subj, {"tenant_id": tid, **payload})
    return subj


async def emit_camera_status(
    tenant_id: uuid.UUID | str | None,
    payload: dict,
    *,
    _bus: EventBus | None = None,
) -> str:
    """Publish ``tenant.<id>.vms.camera.status`` (VMS realtime / workflow stream)."""
    tid = _tid(tenant_id)
    subj = subject(tid, "vms", "camera.status")
    await (_bus or bus).publish(subj, {"tenant_id": tid, **payload})
    return subj
