"""Device / fleet-management schemas (pydantic v2, G7).

Request bodies + response envelopes for the per-camera fleet ops and the bulk fan-out.
Kept small: the driver ``FleetOpResult`` / ``DeviceInfo`` dataclasses are adapted to
these public dicts in the service (JSON-safe, no dataclass leakage).
"""

from __future__ import annotations

from typing import Any, Optional

from pydantic import BaseModel, ConfigDict, Field

# Bulk actions the fan-out endpoint accepts.
BULK_ACTIONS = ("reboot", "ntp", "password")


class FleetOpPublic(BaseModel):
    """The uniform per-op result (adapts ``drivers.FleetOpResult``)."""

    model_config = ConfigDict(extra="ignore")
    ok: bool = False
    supported: bool = True
    detail: Optional[str] = None
    data: dict[str, Any] = Field(default_factory=dict)


class DeviceInfoPublic(BaseModel):
    """Fleet identity/firmware read (adapts ``drivers.DeviceInfo``)."""

    model_config = ConfigDict(extra="ignore")
    reachable: bool
    manufacturer: Optional[str] = None
    model: Optional[str] = None
    firmware: Optional[str] = None
    serial_number: Optional[str] = None
    hardware_id: Optional[str] = None
    mac: Optional[str] = None
    channel_count: int = 0
    error: Optional[str] = None


class NtpBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    server: str = Field(min_length=1, max_length=255)


class PasswordBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    user: str = Field(min_length=1, max_length=64)
    new_password: str = Field(min_length=1, max_length=255)


class UserAddBody(BaseModel):
    """POST /cameras/{id}/users — create an ONVIF device account."""

    model_config = ConfigDict(extra="forbid")
    user: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=255)
    level: str = Field(default="User")  # Administrator | Operator | User


class ConfigRestoreBody(BaseModel):
    """Restore body — the config blob is supplied base64-encoded (JSON-safe)."""

    model_config = ConfigDict(extra="forbid")
    blob_b64: str = Field(min_length=1)


class BulkOpBody(BaseModel):
    """Fan-out body: apply ``action`` to every camera in ``camera_ids`` (best-effort).

    ``server`` is required for the ``ntp`` action; ``user`` + ``new_password`` for the
    ``password`` action; ``reboot`` needs neither. The endpoint path carries the action
    (``/vms/cameras/bulk/{action}``) so the body is just the targets + params.
    """

    model_config = ConfigDict(extra="forbid")
    camera_ids: list[str] = Field(min_length=1, max_length=1000)
    server: Optional[str] = Field(default=None, max_length=255)
    user: Optional[str] = Field(default=None, max_length=64)
    new_password: Optional[str] = Field(default=None, max_length=255)


class BulkOpItem(BaseModel):
    camera_id: str
    camera_name: Optional[str] = None
    ok: bool = False
    supported: bool = True
    detail: Optional[str] = None


class BulkOpResult(BaseModel):
    action: str
    total: int
    succeeded: int
    items: list[BulkOpItem]
