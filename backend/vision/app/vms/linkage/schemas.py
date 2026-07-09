"""Linkage domain schemas (P5-B) — rule CRUD bodies + public reads + fire-audit reads.

Mirrors the recording/events schema style (``extra="ignore"`` on public reads; plain
strings; JSON blobs pass through as dicts/lists). The action list is validated for
shape (each entry a ``{type, config}``) but action ``config`` stays a free dict so a new
action type doesn't need a schema change.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator

# The action types the engine knows how to execute.
ACTION_TYPES = {
    "start_recording",
    "notify",
    "ptz_preset",
    "trigger_output",
    "popup",
}


class LinkageAction(BaseModel):
    """One action in a rule's list: ``{type, config}``."""

    model_config = ConfigDict(extra="ignore")

    type: str
    config: dict[str, Any] = Field(default_factory=dict)

    @field_validator("type")
    @classmethod
    def _known(cls, v: str) -> str:
        if v not in ACTION_TYPES:
            raise ValueError(
                f"unknown action type '{v}' (expected one of {sorted(ACTION_TYPES)})"
            )
        return v


class LinkageRuleCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=255)
    description: Optional[str] = Field(None, max_length=1024)
    is_active: bool = True
    trigger_event_type: str = Field(min_length=1, max_length=48)
    trigger_filter: dict[str, Any] = Field(default_factory=dict)
    camera_scope: dict[str, Any] = Field(default_factory=dict)
    actions: list[LinkageAction] = Field(default_factory=list)
    cooldown_seconds: int = Field(0, ge=0, le=86_400)
    schedule: dict[str, Any] = Field(default_factory=dict)


class LinkageRuleUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: Optional[str] = Field(None, min_length=1, max_length=255)
    description: Optional[str] = Field(None, max_length=1024)
    is_active: Optional[bool] = None
    trigger_event_type: Optional[str] = Field(None, min_length=1, max_length=48)
    trigger_filter: Optional[dict[str, Any]] = None
    camera_scope: Optional[dict[str, Any]] = None
    actions: Optional[list[LinkageAction]] = None
    cooldown_seconds: Optional[int] = Field(None, ge=0, le=86_400)
    schedule: Optional[dict[str, Any]] = None


class LinkageRulePublic(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: str
    name: str
    description: Optional[str] = None
    is_active: bool
    trigger_event_type: str
    trigger_filter: dict[str, Any] = Field(default_factory=dict)
    camera_scope: dict[str, Any] = Field(default_factory=dict)
    actions: list[dict[str, Any]] = Field(default_factory=list)
    cooldown_seconds: int
    schedule: dict[str, Any] = Field(default_factory=dict)
    created_by: Optional[str] = None
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_row(cls, row) -> "LinkageRulePublic":
        return cls.model_validate(
            {
                "id": row.id,
                "name": row.name,
                "description": row.description,
                "is_active": row.is_active,
                "trigger_event_type": row.trigger_event_type,
                "trigger_filter": row.trigger_filter or {},
                "camera_scope": row.camera_scope or {},
                "actions": row.actions or [],
                "cooldown_seconds": row.cooldown_seconds,
                "schedule": row.schedule or {},
                "created_by": row.created_by,
                "created_at": row.created_at,
                "updated_at": row.updated_at,
            }
        )


class LinkageRuleListResponse(BaseModel):
    model_config = ConfigDict(extra="ignore")

    items: list[LinkageRulePublic]
    total: int
    skip: int
    limit: int


class LinkageFirePublic(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: str
    rule_id: str
    rule_name: Optional[str] = None
    trigger_event_type: str
    source_event_id: Optional[str] = None
    camera_id: Optional[str] = None
    door_ref: Optional[str] = None
    actions_result: list[dict[str, Any]] = Field(default_factory=list)
    recording_id: Optional[str] = None
    fired_at: datetime

    @classmethod
    def from_row(cls, row) -> "LinkageFirePublic":
        return cls.model_validate(
            {
                "id": row.id,
                "rule_id": row.rule_id,
                "rule_name": row.rule_name,
                "trigger_event_type": row.trigger_event_type,
                "source_event_id": row.source_event_id,
                "camera_id": row.camera_id,
                "door_ref": row.door_ref,
                "actions_result": row.actions_result or [],
                "recording_id": row.recording_id,
                "fired_at": row.fired_at,
            }
        )


class LinkageFireListResponse(BaseModel):
    model_config = ConfigDict(extra="ignore")

    items: list[LinkageFirePublic]
    total: int
    skip: int
    limit: int
