"""Pydantic schemas for broadcasts."""

from __future__ import annotations

import datetime as dt
import uuid

from pydantic import BaseModel, ConfigDict, Field


class BroadcastOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    title: str
    body: str = ""
    severity: str = "info"
    target_type: str = "all"
    target_tenant_ids: list[str] = []
    starts_at: dt.datetime | None = None
    ends_at: dt.datetime | None = None
    is_active: bool = True
    created_at: dt.datetime
    updated_at: dt.datetime


class CreateBroadcastIn(BaseModel):
    title: str = Field(min_length=1)
    body: str = ""
    severity: str = "info"       # info | warning | critical
    target_type: str = "all"     # all | tenants
    target_tenant_ids: list[uuid.UUID] = []
    starts_at: dt.datetime | None = None
    ends_at: dt.datetime | None = None
    is_active: bool = True


class UpdateBroadcastIn(BaseModel):
    # PATCH semantics — only sent fields change.
    title: str | None = None
    body: str | None = None
    severity: str | None = None
    target_type: str | None = None
    target_tenant_ids: list[uuid.UUID] | None = None
    starts_at: dt.datetime | None = None
    ends_at: dt.datetime | None = None
    is_active: bool | None = None


class ActiveBroadcastOut(BaseModel):
    """The lightweight shape tenant consoles consume."""

    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    title: str
    body: str = ""
    severity: str = "info"
    starts_at: dt.datetime | None = None
    ends_at: dt.datetime | None = None
