"""Shared sites constants + validators.

Single source of truth for the sites literal types and the reusable field
validators. Ported verbatim from neubit_v2's ``module/sites/shared.py`` — the
validation rules (name/description length, coordinate ranges, polygon shape,
GeoJSON polygon) are part of the API contract and must not drift.
"""

from __future__ import annotations

import json
from typing import Literal, Optional

NAME_MAX_LENGTH = 100
DESCRIPTION_MAX_LENGTH = 500
SHORT_STRING_MAX_LENGTH = 100
METADATA_MAX_BYTES = 10_000

THREAT_LEVEL_VALUES = {"normal", "elevated", "high", "critical", "lockdown"}
ThreatLevel = Literal["normal", "elevated", "high", "critical", "lockdown"]

SiteType = Literal[
    "building",
    "campus",
    "facility",
    "warehouse",
    "headquarters",
    "branch",
    "retail",
    "office",
    "factory",
    "other",
]

ZoneType = Literal[
    "entrance",
    "parking",
    "office",
    "lobby",
    "server_room",
    "common_area",
    "corridor",
    "cafeteria",
    "security",
    "emergency_exit",
    "other",
]

# Device-placement literals — ported verbatim from neubit_v2's
# ``module/sites/shared.py`` (device_type / service are part of the API contract).
DEVICE_TYPES = {
    "camera",
    "nvr",
    "access_control",
    "panel",
    "sensor",
    "door",
    "reader",
    "other",
}

SERVICE_TYPES = {"vms", "access_control", "iot", "fire"}


# ── Validators (Pydantic field_validator helpers) ──────────────────────


def validate_name(
    v: Optional[str], *, entity: str = "Name", required: bool = True,
) -> Optional[str]:
    if v is None:
        if required:
            raise ValueError(f"{entity} is required")
        return None
    v = v.strip()
    if not v:
        raise ValueError(f"{entity} cannot be empty")
    if len(v) > NAME_MAX_LENGTH:
        raise ValueError(f"{entity} must be {NAME_MAX_LENGTH} characters or fewer")
    return v


def validate_description(v: Optional[str]) -> Optional[str]:
    if v is not None and len(v) > DESCRIPTION_MAX_LENGTH:
        raise ValueError(
            f"Description must be {DESCRIPTION_MAX_LENGTH} characters or fewer",
        )
    return v


def validate_short(v: Optional[str]) -> Optional[str]:
    if v is not None and len(v) > SHORT_STRING_MAX_LENGTH:
        raise ValueError(
            f"Value must be {SHORT_STRING_MAX_LENGTH} characters or fewer",
        )
    return v


def validate_geo_polygon(v: Optional[dict]) -> Optional[dict]:
    if v is None:
        return None
    if not isinstance(v, dict):
        raise ValueError("geo_polygon must be a JSON object")
    if v.get("type") != "Polygon":
        raise ValueError('geo_polygon.type must be "Polygon"')
    coords = v.get("coordinates")
    if not isinstance(coords, list) or not coords:
        raise ValueError("geo_polygon.coordinates must be a non-empty array of rings")
    for ring in coords:
        if not isinstance(ring, list) or len(ring) < 4:
            raise ValueError("Each ring must have at least 4 coordinate pairs")
        for point in ring:
            if not isinstance(point, list) or len(point) != 2:
                raise ValueError("Each coordinate must be [longitude, latitude]")
            lng, lat = point
            if not isinstance(lng, (int, float)) or not isinstance(lat, (int, float)):
                raise ValueError("Coordinates must be numbers")
            if not (-180 <= lng <= 180) or not (-90 <= lat <= 90):
                raise ValueError("Coordinates out of range")
    return v


def validate_metadata_size(metadata: Optional[dict]) -> Optional[dict]:
    if metadata is None:
        return None
    serialized = json.dumps(metadata)
    if len(serialized.encode("utf-8")) > METADATA_MAX_BYTES:
        raise ValueError(
            f"metadata must be under {METADATA_MAX_BYTES // 1000}KB when serialized",
        )
    return metadata
