"""Device-placement request/response schemas (pydantic).

Ported from neubit_v2's ``module/sites/device/schemas.py`` + ``models.py``. The
``FloorPosition`` sub-model and the ``device_type`` / ``service`` enum validation are
part of the API contract the frontend depends on and must not drift.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from ..shared import DEVICE_TYPES, SERVICE_TYPES, validate_metadata_size

#: How many devices one assignment call may name. The list is the operator's
#: statement, so it has to fit in one request and one transaction; the estate this
#: was built for is tens of devices, and `reading-writer`'s `placement.MAX_BULK`
#: — the other end of the same fact — is 500. Matched deliberately: a request core
#: accepts and the mirror would refuse per-device is a split the operator cannot
#: see.
MAX_ASSIGN = 500


def _pin_is_whole(floor_id, floor_position, zone_id) -> None:
    """The API edge of `ck_device_placements_pin_is_whole`.

    Stated in both places on purpose. The constraint is what holds for every
    writer the database will ever have; this is what turns a violation into a 422
    naming the field instead of a 500 out of the driver.

    ONE DIRECTION ONLY. A position needs a floor — coordinates on nothing mean
    nothing. A floor does NOT need a position: "this meter is on Level 4" is a
    true, useful, floor-wise statement, and demanding an `{x, y}` for it would
    make an operator invent a coordinate or say nothing — the same failure that
    freeing the site from the floor removed, one level down. So three shapes are
    whole: site only, site + floor, site + floor + position.
    """
    if floor_position is not None and floor_id is None:
        raise ValueError(
            "floor_position needs a floor_id — a position with no floor is a "
            "position on nothing. A floor with no position is fine: it places "
            "the device on that storey without pinning it on the plan."
        )
    if zone_id is not None and floor_id is None:
        raise ValueError("zone_id needs a floor_id — a zone is a part of a storey")


class FloorPosition(BaseModel):
    """Pixel position on the floor image; ``rotation`` in degrees (facing direction)."""

    model_config = ConfigDict(extra="ignore")

    x: float
    y: float
    rotation: float = 0


class RegisterDeviceRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    device_id: str
    device_type: str
    service: str
    site_id: str
    # Optional since migration 0031: a placement may name the site alone. The
    # floor-plan editor still sends all three, and its contract is unchanged.
    floor_id: Optional[str] = None
    zone_id: Optional[str] = None
    floor_position: Optional[FloorPosition] = None
    metadata: Optional[dict[str, Any]] = None

    @model_validator(mode="after")
    def _pin(self) -> "RegisterDeviceRequest":
        _pin_is_whole(self.floor_id, self.floor_position, self.zone_id)
        return self

    @field_validator("device_type")
    @classmethod
    def _device_type(cls, v: str) -> str:
        if v not in DEVICE_TYPES:
            raise ValueError(f"device_type must be one of: {sorted(DEVICE_TYPES)}")
        return v

    @field_validator("service")
    @classmethod
    def _service(cls, v: str) -> str:
        if v not in SERVICE_TYPES:
            raise ValueError(f"service must be one of: {sorted(SERVICE_TYPES)}")
        return v

    @field_validator("metadata")
    @classmethod
    def _meta(cls, v):
        return validate_metadata_size(v)


class UpdateDeviceRequest(BaseModel):
    """A PATCH of the pin itself. It cannot MOVE a device between buildings.

    `None` here has always meant "not supplied" rather than "clear it" — the
    service applies only the keys that were sent — so this schema cannot express
    un-pinning or re-siting. Both go through the writers that state the whole
    fact: `POST /register` (the floor-plan editor) and `POST /assign` (the
    device-first surface), so there is exactly one shape for "where this device
    is" and no way to half-change it.
    """

    model_config = ConfigDict(extra="forbid")

    floor_position: Optional[FloorPosition] = None
    zone_id: Optional[str] = None
    metadata: Optional[dict[str, Any]] = None

    @field_validator("metadata")
    @classmethod
    def _meta(cls, v):
        return validate_metadata_size(v)


class DevicePlacementPublic(BaseModel):
    model_config = ConfigDict(extra="ignore")

    placement_id: str
    device_id: str
    device_type: str
    service: str
    site_id: str
    # NULL for a device that belongs to a building and is on no drawing. The
    # frontend must render that as "assigned, not pinned", not as an error.
    floor_id: Optional[str] = None
    zone_id: Optional[str] = None
    floor_position: Optional[FloorPosition] = None
    metadata: Optional[dict[str, Any]] = None
    status: str
    status_updated_at: Optional[datetime] = None
    created_by: Optional[str] = None
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_row(cls, row) -> "DevicePlacementPublic":
        return cls.model_validate(
            {
                "placement_id": row.placement_id,
                "device_id": row.device_id,
                "device_type": row.device_type,
                "service": row.service,
                "site_id": row.site_id,
                "floor_id": row.floor_id,
                "zone_id": row.zone_id,
                "floor_position": row.floor_position,
                "metadata": row.placement_metadata,
                "status": row.status,
                "status_updated_at": row.status_updated_at,
                "created_by": row.created_by,
                "created_at": row.created_at,
                "updated_at": row.updated_at,
            }
        )


class DeviceListResponse(BaseModel):
    items: list[DevicePlacementPublic]
    count: int


# ── the device-first surface ─────────────────────────────────────────────────
#
# `RegisterDeviceRequest` above is the FLOOR PLAN's shape: it starts from a
# drawing and puts a device on it. These start from the DEVICE and say which
# building it is in, which is the other half of the same fact and the half that
# had no API at all.
#
# They are not a second writer. Both land in `device_placements` through
# `DevicePlacementService`, which is still the only thing that writes that table
# and still the only thing that publishes a placement event.


class AssignDeviceItem(BaseModel):
    """One device in an assignment, and optionally where in the site it sits.

    `device_type` / `service` may be omitted when the request states them for the
    whole batch — thirty meters are thirty `iot` `sensor`s and saying so thirty
    times is how a bulk screen does not get used. They are still REQUIRED for a
    device with no placement yet: they are columns on the row, and nothing here
    guesses them from a tag, an id or the other items in the list.
    """

    model_config = ConfigDict(extra="forbid")

    device_id: str
    device_type: Optional[str] = None
    service: Optional[str] = None
    # A pin, if this operator happens to be placing one. Per ITEM and never per
    # request: one `{x, y}` shared by a list of devices would stack them all on
    # the same spot on the same drawing, which is a coordinate nobody measured.
    floor_id: Optional[str] = None
    floor_position: Optional[FloorPosition] = None
    zone_id: Optional[str] = None

    @model_validator(mode="after")
    def _pin(self) -> "AssignDeviceItem":
        _pin_is_whole(self.floor_id, self.floor_position, self.zone_id)
        return self


class AssignDevicesRequest(BaseModel):
    """Put an EXPLICIT LIST of devices in one site.

    Every property of this shape is about refusing to guess:

    * the site is named, never "the only site there is";
    * the devices are named one by one. There is no "assign everything
      unplaced", no filter and no query — a device's building is an operator's
      assertion about a physical box, and a selection made by a predicate is the
      predicate's assertion, not theirs;
    * nothing is applied automatically. This runs when it is called and never
      on a schedule, an import or an event.
    """

    model_config = ConfigDict(extra="forbid")

    site_id: str
    # Batch defaults for the two identity columns. An item may override either.
    device_type: Optional[str] = None
    service: Optional[str] = None
    devices: list[AssignDeviceItem] = Field(min_length=1, max_length=MAX_ASSIGN)

    @field_validator("device_type")
    @classmethod
    def _device_type(cls, v):
        if v is not None and v not in DEVICE_TYPES:
            raise ValueError(f"device_type must be one of: {sorted(DEVICE_TYPES)}")
        return v

    @field_validator("service")
    @classmethod
    def _service(cls, v):
        if v is not None and v not in SERVICE_TYPES:
            raise ValueError(f"service must be one of: {sorted(SERVICE_TYPES)}")
        return v

    @model_validator(mode="after")
    def _items(self) -> "AssignDevicesRequest":
        seen: set[str] = set()
        for item in self.devices:
            if item.device_id in seen:
                # Two entries for one device are two statements about it, and the
                # last one silently winning is how an operator ends up with a
                # placement they did not choose.
                raise ValueError(f"device_id {item.device_id!r} is listed twice")
            seen.add(item.device_id)
            dtype = item.device_type or self.device_type
            svc = item.service or self.service
            if dtype is not None and dtype not in DEVICE_TYPES:
                raise ValueError(f"device_type must be one of: {sorted(DEVICE_TYPES)}")
            if svc is not None and svc not in SERVICE_TYPES:
                raise ValueError(f"service must be one of: {sorted(SERVICE_TYPES)}")
        return self


class AssignedDevice(BaseModel):
    """What happened to one device, so the caller can say so on screen."""

    device_id: str
    placement_id: str
    site_id: str
    floor_id: Optional[str] = None
    # True when this device had no placement before. The two cases read
    # differently to an operator ("28 assigned" vs "28 moved").
    created: bool
    # True when the device was in ANOTHER site and carried a pin, so the pin was
    # dropped: a `{x, y}` on a floor of a building the device is no longer in is
    # not a stale pin, it is a false one. Surfaced rather than done quietly.
    pin_cleared: bool


class AssignDevicesResponse(BaseModel):
    site_id: str
    site_name: Optional[str] = None
    assigned: int
    items: list[AssignedDevice]
