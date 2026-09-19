"""Infrastructure request/response schemas.

Every vocabulary word is checked HERE, at the edge, through ``vocabulary.py`` —
so a request naming an unknown class, a slot its class does not have or a design
fact with a string for a number is a 422 before the service opens a transaction.
The checks that need a row (a slot against the class of equipment already
stored, a design PUT against that equipment's class) run in the service through
the same functions and produce the same sentences.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from ..shared import validate_description, validate_name
from . import vocabulary as vocab

TAG_MAX = 64
POINT_TAG_MAX = 255


def _clean_tag(v: Optional[str], *, field: str, limit: int) -> Optional[str]:
    """Trim OUTER whitespace only; refuse an empty tag. See models.py for why."""
    if v is None:
        return None
    v = v.strip()
    if not v:
        raise ValueError(f"{field} cannot be empty")
    if len(v) > limit:
        raise ValueError(f"{field} must be {limit} characters or fewer")
    return v


class PointBinding(BaseModel):
    """A slot's point, named the way the gateway names it."""

    model_config = ConfigDict(extra="forbid")

    device_tag: Optional[str] = None
    point_tag: Optional[str] = None

    @field_validator("device_tag", "point_tag")
    @classmethod
    def _tag(cls, v, info):
        return _clean_tag(v, field=info.field_name, limit=POINT_TAG_MAX)

    @model_validator(mode="after")
    def _whole(self):
        # Mirrors ck_equipment_point_slots_binding_whole: both or neither.
        if (self.device_tag is None) != (self.point_tag is None):
            raise ValueError("a binding needs both device_tag and point_tag, or neither")
        return self


class SlotInput(PointBinding):
    slot: str


# ── systems ──────────────────────────────────────────────────────────────────


class CreateSystemRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str
    kind: str
    description: Optional[str] = None

    @field_validator("name")
    @classmethod
    def _name(cls, v: str) -> str:
        return validate_name(v, entity="System name")

    @field_validator("kind")
    @classmethod
    def _kind(cls, v: str) -> str:
        return vocab.check_system_kind(v)

    @field_validator("description")
    @classmethod
    def _desc(cls, v):
        return validate_description(v)


class UpdateSystemRequest(BaseModel):
    """Name and description only. The KIND is not editable: every piece of
    equipment in the system was admitted against it, and changing it would
    silently re-legalise or de-legalise all of them at once."""

    model_config = ConfigDict(extra="forbid")

    name: Optional[str] = None
    description: Optional[str] = None

    @field_validator("name")
    @classmethod
    def _name(cls, v):
        return validate_name(v, entity="System name", required=False)

    @field_validator("description")
    @classmethod
    def _desc(cls, v):
        return validate_description(v)


# ── equipment ────────────────────────────────────────────────────────────────


class CreateEquipmentRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    system_id: str
    tag: str
    equipment_class: str
    name: Optional[str] = None
    design: dict[str, Any] = Field(default_factory=dict)
    slots: list[SlotInput] = Field(default_factory=list)

    @field_validator("tag")
    @classmethod
    def _tag(cls, v: str) -> str:
        return _clean_tag(v, field="tag", limit=TAG_MAX)

    @field_validator("name")
    @classmethod
    def _name(cls, v):
        return validate_name(v, entity="Equipment name", required=False)

    @field_validator("equipment_class")
    @classmethod
    def _class(cls, v: str) -> str:
        return vocab.check_equipment_class(v)

    @model_validator(mode="after")
    def _against_class(self):
        self.design = vocab.check_design(self.equipment_class, self.design)
        seen: set[str] = set()
        for s in self.slots:
            vocab.check_slot(self.equipment_class, s.slot)
            if s.slot in seen:
                raise ValueError(f"slot {s.slot!r} is listed twice")
            seen.add(s.slot)
        return self


class UpdateEquipmentRequest(BaseModel):
    """Tag, name, and a move to another system ON THE SAME SITE.

    ``equipment_class`` is not here, so sending it is a 422 (extra="forbid"): its
    slots and design facts were admitted against the class, and a mis-classified
    unit is deleted and re-created rather than re-interpreted in place.
    ``design`` is not here either — it has its own PUT, where null can clear.
    """

    model_config = ConfigDict(extra="forbid")

    tag: Optional[str] = None
    name: Optional[str] = None
    system_id: Optional[str] = None

    @field_validator("tag")
    @classmethod
    def _tag(cls, v):
        return _clean_tag(v, field="tag", limit=TAG_MAX)

    @field_validator("name")
    @classmethod
    def _name(cls, v):
        return validate_name(v, entity="Equipment name", required=False)


class DesignUpdate(BaseModel):
    """The whole design-fact set, replaced. A key left out, or sent as null, is
    "not recorded" afterwards — the same set semantics as a site's building facts."""

    model_config = ConfigDict(extra="forbid")

    design: dict[str, Any]


class SlotPublic(BaseModel):
    slot: str
    device_tag: Optional[str] = None
    point_tag: Optional[str] = None
    bound: bool

    @classmethod
    def from_row(cls, row) -> "SlotPublic":
        return cls(
            slot=row.slot,
            device_tag=row.device_tag,
            point_tag=row.point_tag,
            bound=row.device_tag is not None,
        )


class EquipmentPublic(BaseModel):
    model_config = ConfigDict(extra="ignore")

    equipment_id: str
    site_id: str
    system_id: str
    tag: str
    name: Optional[str] = None
    equipment_class: str
    design: dict[str, Any]
    design_units: dict[str, str]
    slots: list[SlotPublic]
    created_at: datetime
    updated_at: datetime


class SystemPublic(BaseModel):
    system_id: str
    site_id: str
    name: str
    kind: str
    description: Optional[str] = None
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_row(cls, row) -> "SystemPublic":
        return cls(
            system_id=row.system_id,
            site_id=row.site_id,
            name=row.name,
            kind=row.kind,
            description=row.description,
            created_at=row.created_at,
            updated_at=row.updated_at,
        )


class SystemWithEquipment(SystemPublic):
    equipment: list[EquipmentPublic]


class InfrastructureTree(BaseModel):
    site_id: str
    systems: list[SystemWithEquipment]
