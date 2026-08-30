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

import re

from pydantic import BaseModel, ConfigDict, Field, field_validator

# A dashboard variable's name. Never emitted into SQL — the executor looks it up
# as a dict key — but a name is still a name, and a loud refusal at the edge beats
# a variable that silently never resolves.
NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")

# A dashboard's canvas. 12 columns is the convention every grid layout in this
# space uses; the bounds exist so a stored value cannot make the canvas unusable.
MIN_COLS, MAX_COLS = 4, 24
MIN_ROW_H, MAX_ROW_H = 24, 200
MAX_WIDGETS = 40
# How many snapshots a dashboard keeps. Bounded because a person dragging widgets
# around all afternoon would otherwise grow the table without limit for a feature
# nobody scrolls that far back in.
MAX_VERSIONS = 30


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


MAX_DASH_FILTERS = 12
MAX_DASH_VARIABLES = 30


class DashboardConfigEnvelope:
    """Structural check for a dashboard's page-level state (filters, variables).

    The SAME argument as ``WidgetSpecEnvelope`` above, and it is worth restating
    because it is the reason this is a shape check and not a model. A dashboard
    filter names a DATASET DIMENSION — `category`, `door_name` — and the dataset
    registry lives in the reading-writer, which owns ``neubit_reporting``. For
    this service to validate that a filter's column exists it would have to read
    that store, which is precisely the cross-service read the platform bans and
    the second place the registry could drift from itself.

    So: bounded, well-formed, and no opinion about meaning. A filter naming a
    dimension that does not exist is caught by the executor, with a message
    naming the column — which is the component that actually knows.

    What IS enforced here is size, because an unbounded JSON blob on a row every
    page load reads is a denial-of-service with extra steps.
    """

    @staticmethod
    def check(config: Any) -> dict:
        from kernel.errors import ValidationError

        if config is None:
            return {}
        if not isinstance(config, dict):
            raise ValidationError("dashboard config must be an object")
        unknown = set(config) - {"filters", "variables", "window"}
        if unknown:
            raise ValidationError(
                f"unknown dashboard config field(s): {', '.join(sorted(unknown))}"
            )
        filters = config.get("filters", [])
        if not isinstance(filters, list):
            raise ValidationError("dashboard config filters must be a list")
        if len(filters) > MAX_DASH_FILTERS:
            raise ValidationError(
                f"a dashboard offers at most {MAX_DASH_FILTERS} filters; more than "
                "that is a form, not a filter bar"
            )
        for f in filters:
            if not isinstance(f, dict):
                raise ValidationError("each dashboard filter must be an object")
            if not isinstance(f.get("id"), str) or not f["id"].strip():
                raise ValidationError("each dashboard filter needs an id")
            if not isinstance(f.get("column"), str) or not f["column"].strip():
                raise ValidationError("each dashboard filter must name a column")
        ids = [f["id"] for f in filters]
        if len(set(ids)) != len(ids):
            raise ValidationError("two dashboard filters share an id")
        variables = config.get("variables", [])
        if not isinstance(variables, list):
            raise ValidationError("dashboard config variables must be a list")
        if len(variables) > MAX_DASH_VARIABLES:
            raise ValidationError(f"a dashboard defines at most {MAX_DASH_VARIABLES} variables")
        for v in variables:
            if not isinstance(v, dict):
                raise ValidationError("each dashboard variable must be an object")
            name = v.get("name")
            if not isinstance(name, str) or not NAME_RE.match(name):
                raise ValidationError(
                    f"{name!r} is not a usable variable name — letters, digits and "
                    "underscores, not starting with a digit"
                )
        names = [v["name"] for v in variables]
        if len(set(names)) != len(names):
            raise ValidationError("two dashboard variables share a name")
        return config


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
    config: dict | None = None

    @field_validator("config")
    @classmethod
    def _cfg(cls, v: dict | None) -> dict | None:
        return None if v is None else DashboardConfigEnvelope.check(v)


class DashboardUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, min_length=1, max_length=160)
    description: str | None = Field(default=None, max_length=1024)
    grid_cols: int | None = Field(default=None, ge=MIN_COLS, le=MAX_COLS)
    row_height: int | None = Field(default=None, ge=MIN_ROW_H, le=MAX_ROW_H)
    config: dict | None = None

    @field_validator("config")
    @classmethod
    def _cfg(cls, v: dict | None) -> dict | None:
        return None if v is None else DashboardConfigEnvelope.check(v)


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
    # The page-level filters and variables. On the DETAIL only: the list view
    # renders no filter bar, and shipping every dashboard's config in a list of
    # fifty is payload nobody reads.
    config: dict = Field(default_factory=dict)
    widgets: list[WidgetPublic] = Field(default_factory=list)


class DashboardListResponse(BaseModel):
    total: int
    items: list[DashboardSummary]


class VersionSummary(BaseModel):
    """One history row. No snapshot — a list of thirty of them would ship the
    whole dashboard thirty times for a drawer that shows a date and a label."""

    model_config = ConfigDict(from_attributes=True)

    version: int
    label: str
    created_at: datetime
    created_by: uuid.UUID | None = None
    widget_count: int = 0


class VersionDetail(VersionSummary):
    """One version WITH its snapshot, for the diff and the restore preview."""

    snapshot: dict = Field(default_factory=dict)


class VersionListResponse(BaseModel):
    total: int
    items: list[VersionSummary]
    max_versions: int = MAX_VERSIONS
    # What the dashboard looks like right now, in the SAME shape as a snapshot, so
    # the diff view compares like with like instead of reassembling the live state
    # from a different response.
    current: dict = Field(default_factory=dict)
