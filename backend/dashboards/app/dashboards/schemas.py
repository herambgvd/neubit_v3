"""Request / response models for the dashboards API.

The one thing worth reading closely is ``WidgetSpecEnvelope``.

This service stores widget specs; it does not interpret them. The reading-writer
owns the readings schema and is the only thing that executes a spec (contract §7),
so putting a second, full copy of the spec model here would create exactly the
drift that rule exists to prevent — and, worse, would make this service reject
a spec the executor is perfectly happy with the moment the two versions differ.

So validation here is an ENVELOPE CHECK and nothing more:

* it is an object,
* ``spec_version`` is a positive integer,
* ``viz`` is a non-empty string,
* ``query`` is an object.

That is enough to catch a corrupted or empty body, and deliberately not enough to
have an opinion about metrics, scopes or chart types. A widget whose spec is
structurally fine but semantically wrong is rejected by the executor, with a
message naming the field — which is the right place for it, because that is the
only component that knows.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator

# A dashboard's canvas. 12 columns is the convention every grid layout in this
# space uses; the bounds exist so a stored value cannot make the canvas unusable.
MIN_COLS, MAX_COLS = 4, 24
MIN_ROW_H, MAX_ROW_H = 24, 200
MAX_WIDGETS = 40


class WidgetSpecEnvelope:
    """Structural check for a stored spec. See the module docstring."""

    @staticmethod
    def check(spec: Any) -> dict:
        from kernel.errors import ValidationError

        if not isinstance(spec, dict):
            raise ValidationError("widget spec must be an object")
        version = spec.get("spec_version")
        if not isinstance(version, int) or isinstance(version, bool) or version < 1:
            raise ValidationError("widget spec must carry a positive integer spec_version")
        viz = spec.get("viz")
        if not isinstance(viz, str) or not viz.strip():
            raise ValidationError("widget spec must name a viz")
        if not isinstance(spec.get("query"), dict):
            raise ValidationError("widget spec must carry a query object")
        return spec


class Geometry(BaseModel):
    """A widget's place on the grid, in CELLS."""

    model_config = ConfigDict(extra="forbid")

    x: int = Field(default=0, ge=0, le=MAX_COLS)
    y: int = Field(default=0, ge=0, le=10_000)
    w: int = Field(default=4, ge=1, le=MAX_COLS)
    h: int = Field(default=4, ge=1, le=200)


class WidgetCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str = Field(default="", max_length=160)
    spec: dict
    x: int = Field(default=0, ge=0, le=MAX_COLS)
    y: int = Field(default=0, ge=0, le=10_000)
    w: int = Field(default=4, ge=1, le=MAX_COLS)
    h: int = Field(default=4, ge=1, le=200)

    @field_validator("spec")
    @classmethod
    def _envelope(cls, v: dict) -> dict:
        return WidgetSpecEnvelope.check(v)


class WidgetUpdate(BaseModel):
    """Every field optional — a move, a resize and a re-spec are the same route."""

    model_config = ConfigDict(extra="forbid")

    title: str | None = Field(default=None, max_length=160)
    spec: dict | None = None
    x: int | None = Field(default=None, ge=0, le=MAX_COLS)
    y: int | None = Field(default=None, ge=0, le=10_000)
    w: int | None = Field(default=None, ge=1, le=MAX_COLS)
    h: int | None = Field(default=None, ge=1, le=200)

    @field_validator("spec")
    @classmethod
    def _envelope(cls, v: dict | None) -> dict | None:
        return None if v is None else WidgetSpecEnvelope.check(v)


class LayoutItem(Geometry):
    """One entry of a bulk layout save."""

    model_config = ConfigDict(extra="forbid")

    id: str


class LayoutSave(BaseModel):
    """The whole canvas geometry in ONE request.

    A drag that reflows six widgets is one user action and must be one write: six
    PATCHes would leave the layout half-saved if the fifth failed, and a reload
    would then show a canvas nobody arranged.
    """

    model_config = ConfigDict(extra="forbid")

    items: list[LayoutItem] = Field(default_factory=list, max_length=MAX_WIDGETS)


class WidgetPublic(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    dashboard_id: str
    title: str
    spec: dict
    x: int
    y: int
    w: int
    h: int
    created_at: datetime
    updated_at: datetime


class DashboardCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=160)
    description: str | None = Field(default=None, max_length=1024)
    slug: str | None = Field(default=None, max_length=160)
    grid_cols: int = Field(default=12, ge=MIN_COLS, le=MAX_COLS)
    row_height: int = Field(default=56, ge=MIN_ROW_H, le=MAX_ROW_H)


class DashboardUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, min_length=1, max_length=160)
    description: str | None = Field(default=None, max_length=1024)
    grid_cols: int | None = Field(default=None, ge=MIN_COLS, le=MAX_COLS)
    row_height: int | None = Field(default=None, ge=MIN_ROW_H, le=MAX_ROW_H)


class DashboardSummary(BaseModel):
    """List row — no widgets, so listing a hundred dashboards stays one query."""

    model_config = ConfigDict(from_attributes=True)

    id: str
    name: str
    slug: str
    description: str | None
    grid_cols: int
    row_height: int
    widget_count: int = 0
    created_at: datetime
    updated_at: datetime


class DashboardDetail(DashboardSummary):
    widgets: list[WidgetPublic] = Field(default_factory=list)


class DashboardListResponse(BaseModel):
    total: int
    items: list[DashboardSummary]
