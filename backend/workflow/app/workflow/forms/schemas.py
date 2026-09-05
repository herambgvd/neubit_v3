"""Dynamic-form request + response schemas."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

from pydantic import BaseModel, ConfigDict, Field

from ..core.enums import FieldType

# ── Form ───────────────────────────────────────────────────────────────


class FormFieldSchema(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: Optional[str] = None
    label: str
    type: FieldType
    placeholder: Optional[str] = None
    help_text: Optional[str] = None
    default_value: Optional[Any] = None
    options: list[dict] = Field(default_factory=list)
    validation: dict = Field(default_factory=dict)
    order: int = 0
    width: str = "full"


class CreateFormRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    name: str = Field(min_length=1, max_length=255)
    description: Optional[str] = None
    fields: list[FormFieldSchema] = Field(default_factory=list)
    is_active: bool = True


class UpdateFormRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    name: Optional[str] = Field(default=None, max_length=255)
    description: Optional[str] = None
    fields: Optional[list[FormFieldSchema]] = None
    is_active: Optional[bool] = None


class FormPublic(BaseModel):
    model_config = ConfigDict(extra="ignore")
    form_id: str
    name: str
    description: Optional[str] = None
    fields: list[dict] = Field(default_factory=list)
    is_active: bool
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_row(cls, r) -> "FormPublic":
        return cls(
            form_id=r.form_id, name=r.name, description=r.description,
            fields=r.fields or [], is_active=r.is_active,
            created_at=r.created_at, updated_at=r.updated_at,
        )


