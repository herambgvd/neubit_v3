"""Event normalization — driver event_type → the VmsEvent event_type + dedup grain.

The driver topic map (``OnvifDriver.event_topic_map`` / gvd_nvr ``_TOPIC_MAP``) yields
gvd_nvr-era event_types (``motion_detected``, ``camera_tamper``, ``digital_input_change``,
``line_crossing``, ``zone_intrusion``, ``audio_alarm``, ``video_loss``, ``system_error``,
``face_detected``). P5 fixes a SMALL, brand-neutral normalized vocabulary the whole
platform (VMS + workflow correlation + the Events UI) speaks:

    motion | tamper | video_loss | camera_online | camera_offline | io_input |
    line_crossing | zone_intrusion | audio | recording_error | storage_low | system

``normalize_event_type`` folds the driver types onto that vocabulary; unknown driver
types fall back to ``system`` (never dropped — the raw topic is preserved for audit).

The dedup grain is ``hash(camera_id + event_type + time-bucket)``: two notifications
for the same camera+type within one bucket collapse to one row (a chatty camera
re-firing MotionAlarm every 500ms → one event per bucket). The bucket width is
``VE_EVENT_DEDUP_WINDOW_SEC`` (default 10s).
"""

from __future__ import annotations

import hashlib
import os
from datetime import datetime, timezone

# ── driver event_type (gvd_nvr _TOPIC_MAP) → normalized VmsEvent event_type ───────
_NORMALIZE: dict[str, str] = {
    "motion_detected": "motion",
    "camera_tamper": "tamper",
    "video_loss": "video_loss",
    "digital_input_change": "io_input",
    "line_crossing": "line_crossing",
    "zone_intrusion": "zone_intrusion",
    "audio_alarm": "audio",
    # Face + thermal aren't in the P5 device-event vocabulary (no AI) → generic system.
    "face_detected": "system",
    "system_error": "system",
}

# The full set the VmsEvent model + UI + correlation understand (system events too).
NORMALIZED_TYPES: frozenset[str] = frozenset(
    {
        "motion",
        "tamper",
        "video_loss",
        "camera_online",
        "camera_offline",
        "io_input",
        "line_crossing",
        "zone_intrusion",
        "audio",
        "recording_error",
        "storage_low",
        "system",
    }
)


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, "").strip() or default)
    except (TypeError, ValueError):
        return default


def dedup_window_sec() -> int:
    """Time-bucket width for the dedup grain (seconds). Default 10."""
    return max(1, _env_int("VE_EVENT_DEDUP_WINDOW_SEC", 10))


def normalize_event_type(driver_event_type: str) -> str:
    """Fold a driver event_type onto the normalized VMS vocabulary.

    An already-normalized value passes through; an unknown driver type falls back to
    ``system`` (the raw topic is preserved on the row for audit, so nothing is lost).
    """
    et = (driver_event_type or "").strip()
    if et in NORMALIZED_TYPES:
        return et
    return _NORMALIZE.get(et, "system")


def dedup_key(
    camera_id: str | None,
    event_type: str,
    occurred_at: datetime,
    *,
    window_sec: int | None = None,
) -> str:
    """``sha256(camera_id:event_type:time-bucket)`` hex — the per-window dedup grain.

    ``occurred_at`` is bucketed to ``window_sec`` so rapid duplicates within one window
    hash identically (→ the unique index drops the duplicate). ``camera_id`` None (a
    non-camera system event) hashes on the literal ``"-"`` so those still dedupe by
    type+bucket.
    """
    w = window_sec if window_sec is not None else dedup_window_sec()
    ts = occurred_at
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    bucket = int(ts.timestamp()) // max(1, w)
    raw = f"{camera_id or '-'}:{event_type}:{bucket}"
    return hashlib.sha256(raw.encode()).hexdigest()[:64]


def event_payload(row) -> dict:
    """The NATS payload for a persisted ``VmsEvent`` — the envelope workflow expects.

    Published on ``tenant.<id>.vms.camera.<event_type>``; the bus wraps it in the
    canonical envelope (``{event_id, tenant_id, type, occurred_at, source, payload}``)
    where ``type`` is derived from the subject as ``vms.camera.<event_type>`` — which
    the correlation engine matches against ``Trigger.event_type``. ``zone`` is surfaced
    top-level when present in ``raw`` (line/zone events carry it) so a trigger condition
    can filter on it without digging into ``raw``.
    """
    raw = row.raw or {}
    payload = {
        "event_id": row.id,
        "camera_id": row.camera_id,
        "event_type": row.event_type,
        "severity": row.severity,
        "source": row.source,
        "title": row.title,
        "occurred_at": row.occurred_at.isoformat() if row.occurred_at else None,
        "raw": raw,
    }
    zone = raw.get("zone") or raw.get("Rule") or raw.get("RuleName")
    if zone is not None:
        payload["zone"] = zone
    return payload
