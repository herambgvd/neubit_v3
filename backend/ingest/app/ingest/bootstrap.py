"""Idempotent seed data for the ingest module.

Pre-seeds well-known brand categories and webhooks at service startup so an
operator sees a working configuration out of the box rather than a blank form.

Today's seeds:

    * Category "Lumina" + one webhook accepting the canonical ``{"data": {...}}``
      envelope Lumina NVRs send. All six alarm types (motion, fd, frs, lcd, lp,
      sod) land on the SAME URL and are separated by event rules — each rule
      matches the subtype's marker key in the raw payload and extracts only that
      subtype's fields.

The auth secret is NOT seeded — the webhook is created with ``auth_type="none"``
and the operator switches it to HMAC via the UI before exposing it. This mirrors
v2, and is why the seed is off by default.

Ported from neubit_v2's ``bootstrap.py`` with three deliberate changes:

* **Event types.** v2 published the rule's *name* as the event type, so these
  rules emitted a bare ``"motion"`` / ``"frs"``. v3 rules carry an explicit
  ``event_type``, so they are namespaced (``lumina.motion``) — matching v3's own
  dotted default and leaving room for another vendor to have "motion" too.
* **Tenancy.** Seeded rows are platform rows (``tenant_id=None``), visible to
  super-admins. A tenant that wants Lumina copies or recreates it.
* Dropped ``target_topic`` (v3 routes by the category's ``target_domain``) and
  ``workflow_id`` (v2 stamped it on the event and nothing ever read it; SOP
  binding is a workflow trigger matching on ``event_type``).

Safe to re-run: every operation is "create if absent". Schema/transform edits on
a later boot are deliberately NOT applied — an operator's tuned config outranks
the seed.
"""

from __future__ import annotations

import logging
import os
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .models import IngestCategory, IngestEventRule, Webhook

logger = logging.getLogger(__name__)


# ── Lumina seed ─────────────────────────────────────────────────────

_LUMINA_CATEGORY_NAME = "Lumina"
_LUMINA_CATEGORY_DESCRIPTION = (
    "Lumina NVR alarm webhooks (motion, FD, LCD, LP, SOD, FRS). "
    "Configure your NVR to POST to the Lumina alarm events endpoint."
)

_LUMINA_WEBHOOK_NAME = "Lumina alarm events"
_LUMINA_WEBHOOK_SLUG = "lumina-events"
_LUMINA_WEBHOOK_DESCRIPTION = (
    "Accepts the canonical Lumina alarm envelope. Set an HMAC secret in the UI "
    "before going live. Alarm subtype is resolved by the event rules below."
)

# Require the outer ``data`` object and the device identity it carries.
# Everything past that varies per alarm subtype and is matched by the rules.
_LUMINA_PAYLOAD_SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": ["data"],
    "properties": {
        "data": {
            "type": "object",
            "required": ["dev_net_info"],
            "properties": {"dev_net_info": {"type": "array", "minItems": 1}},
        },
    },
}

# The webhook-level fallback map: used only when NO rule matches... which, with
# rules configured, never publishes (see ReceiverService.run_pipeline). Kept as
# documentation of the envelope, and as the map the webhook would use if an
# operator disabled every rule.
_LUMINA_TRANSFORM: dict[str, str] = {
    "device_name": "data.dev_net_info[0].device_name",
    "device_mac": "data.dev_net_info[0].mac",
    "device_ip": "data.dev_net_info[0].ip",
    "channel_name": "data.dev_net_info[0].ChannelName",
    "alarm_time": "data.alarm_list[0].time",
    "channel": "data.alarm_list[0].channel_alarm[0].channel",
    "alarm_payload": "data.alarm_list[0].channel_alarm[0]",
    "ai_snap": "data.ai_snap_picture",
    "image": "data.alarm_snap_data[0]",
    "raw": "data",
}

# MAC is the most stable identifier across NVR firmware updates.
_LUMINA_DEVICE_LOOKUP_EXPR = "data.dev_net_info[0].mac"

_LUMINA_EVENT_TYPE = "lumina.alarm"

# Fields every Lumina alarm type carries.
_LUMINA_COMMON_FIELDS: dict[str, str] = {
    "device_name": "data.dev_net_info[0].device_name",
    "device_mac": "data.dev_net_info[0].mac",
    "device_ip": "data.dev_net_info[0].ip",
    "channel_name": "data.dev_net_info[0].ChannelName",
    "image_data": "data.alarm_snap_data[0].img_data",
    "image_format": "data.alarm_snap_data[0].img_format",
}

# Fields shared by the 5 channel_alarm-based types (motion, fd, lcd, lp, sod).
_LUMINA_CHANNEL_ALARM_COMMON: dict[str, str] = {
    "alarm_time": "data.alarm_list[0].time",
    "channel": "data.alarm_list[0].channel_alarm[0].channel",
}


def _channel_alarm_rule(
    *,
    name: str,
    alarm_key: str,
    priority: int,
    extra_fields: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Build one rule for a channel_alarm-style Lumina event."""
    field_map = {
        **_LUMINA_COMMON_FIELDS,
        **_LUMINA_CHANNEL_ALARM_COMMON,
        alarm_key: f"data.alarm_list[0].channel_alarm[0].{alarm_key}",
    }
    if extra_fields:
        field_map.update(extra_fields)
    path = f"data.alarm_list[0].channel_alarm[0].{alarm_key}"
    return {
        "name": name,
        "priority": priority,
        "event_type": f"lumina.{name}",
        "description": f"Lumina {name} alarm — matches when {path} is present.",
        "match_conditions": [{"path": path, "op": "exists", "value": None}],
        "field_map": field_map,
    }


# Priority controls evaluation order — FRS first because it lives in a different
# envelope (ai_snap_picture, not alarm_list) and is therefore unambiguous.
_LUMINA_RULES: list[dict[str, Any]] = [
    {
        "name": "frs",
        "priority": 10,
        "event_type": "lumina.frs",
        "description": (
            "Lumina face recognition — matches when "
            "data.ai_snap_picture.FaceInfo[0] is present."
        ),
        "match_conditions": [
            {"path": "data.ai_snap_picture.FaceInfo[0]", "op": "exists", "value": None}
        ],
        "field_map": {
            **_LUMINA_COMMON_FIELDS,
            "face_time": "data.ai_snap_picture.FaceInfo[0].time",
            "channel": "data.ai_snap_picture.FaceInfo[0].channel",
            "face_id": "data.ai_snap_picture.FaceInfo[0].face_id",
            "identity": "data.ai_snap_picture.FaceInfo[0].identity",
            "face_picture": "data.ai_snap_picture.FaceInfo[0].face_picture",
            "body_picture": "data.ai_snap_picture.FaceInfo[0].body_picture",
            "attributes": "data.ai_snap_picture.FaceInfo[0].attribute",
        },
    },
    _channel_alarm_rule(
        name="motion",
        alarm_key="motion_alarm",
        priority=20,
        extra_fields={"snap_id": "data.alarm_list[0].channel_alarm[0].take_alarm_snap"},
    ),
    _channel_alarm_rule(name="fd", alarm_key="fd", priority=30),
    _channel_alarm_rule(name="lcd", alarm_key="lcd", priority=40),
    _channel_alarm_rule(name="lp", alarm_key="lp", priority=50),
    _channel_alarm_rule(name="sod", alarm_key="sod", priority=60),
]


async def seed_lumina(db: AsyncSession) -> None:
    """Ensure the Lumina category + webhook + 6 event rules exist (platform rows)."""
    category = await db.scalar(
        select(IngestCategory).where(
            IngestCategory.tenant_id.is_(None),
            IngestCategory.name == _LUMINA_CATEGORY_NAME,
        )
    )
    if category is None:
        category = IngestCategory(
            tenant_id=None,
            name=_LUMINA_CATEGORY_NAME,
            description=_LUMINA_CATEGORY_DESCRIPTION,
            target_domain="ingest",
        )
        db.add(category)
        await db.flush()
        logger.info("Ingest: seeded category %r", _LUMINA_CATEGORY_NAME)

    # Keyed on the slug: it's globally unique, so this is also the check that
    # keeps the seed from colliding with an operator's own "lumina-events".
    webhook = await db.scalar(select(Webhook).where(Webhook.slug == _LUMINA_WEBHOOK_SLUG))
    if webhook is None:
        webhook = Webhook(
            tenant_id=None,
            category_id=category.id,
            name=_LUMINA_WEBHOOK_NAME,
            slug=_LUMINA_WEBHOOK_SLUG,
            description=_LUMINA_WEBHOOK_DESCRIPTION,
            request_method="post",
            auth_type="none",  # operator switches to hmac via the UI
            auth_username=None,
            auth_secret_hash=None,
            payload_schema=_LUMINA_PAYLOAD_SCHEMA,
            transform=_LUMINA_TRANSFORM,
            device_lookup_expr=_LUMINA_DEVICE_LOOKUP_EXPR,
            event_type=_LUMINA_EVENT_TYPE,
            is_active=True,
        )
        db.add(webhook)
        await db.flush()
        logger.info(
            "Ingest: seeded webhook %r at /ingest/hooks/%s (auth_type=none — set "
            "an HMAC secret via the UI before exposing it publicly)",
            _LUMINA_WEBHOOK_NAME,
            _LUMINA_WEBHOOK_SLUG,
        )

    # Seed rules only when the webhook has none — never overwrite operator edits.
    existing = int(
        await db.scalar(
            select(func.count())
            .select_from(IngestEventRule)
            .where(IngestEventRule.webhook_id == webhook.id)
        )
        or 0
    )
    if existing:
        return

    for spec in _LUMINA_RULES:
        db.add(
            IngestEventRule(
                tenant_id=webhook.tenant_id,
                webhook_id=webhook.id,
                name=spec["name"],
                description=spec["description"],
                priority=spec["priority"],
                match_conditions=spec["match_conditions"],
                field_map=spec["field_map"],
                event_type=spec["event_type"],
                enabled=True,
            )
        )
    logger.info(
        "Ingest: seeded %d event rules for webhook %r",
        len(_LUMINA_RULES),
        _LUMINA_WEBHOOK_NAME,
    )


# ── Entrypoint ─────────────────────────────────────────────────────


async def bootstrap_ingest_seeds(db: AsyncSession) -> None:
    """Run every brand seed. Called once at service startup.

    Gated on ``VE_INGEST_AUTO_SEED`` — off by default, so an operator learns the
    module by configuring it rather than inheriting rows they did not write (and
    so no open endpoint appears on a stack nobody asked for one on).

    Idempotent: creates only missing rows. Never raises — a seed failure must not
    stop the service from starting.
    """
    flag = (os.getenv("VE_INGEST_AUTO_SEED") or "").strip().lower()
    if flag not in {"1", "true", "yes", "on"}:
        logger.debug("Ingest: auto-seed disabled (set VE_INGEST_AUTO_SEED=true)")
        return
    try:
        await seed_lumina(db)
        await db.commit()
    except Exception:  # noqa: BLE001 — a bad seed must never block startup
        await db.rollback()
        logger.exception("Ingest: seeding failed; continuing without seed data")
