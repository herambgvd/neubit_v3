"""Dynamic-form ORM model.

    workflow_forms — dynamic form definitions (captured on transitions)

``fields`` is a JSON list, not a child table: a form definition is authored,
stored and rendered whole, and the validator that reads it
(``forms.validation.validate_form_data``) takes the same list a transition's
``form_data`` is checked against.
"""

from __future__ import annotations

from sqlalchemy import JSON, Boolean, String, text
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base
from ..core.mixins import _TenantTimestamped
from ..core.primitives import uuid_str

# ── Form ───────────────────────────────────────────────────────────────


class Form(Base, _TenantTimestamped):
    """A dynamic form definition captured on a transition."""

    __tablename__ = "workflow_forms"

    form_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    name: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    description: Mapped[str | None] = mapped_column(String(2048))
    # [{id, label, type, placeholder, options, validation, order, width}, ...]
    fields: Mapped[list | None] = mapped_column(JSON)
    is_active: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("true"), index=True
    )


