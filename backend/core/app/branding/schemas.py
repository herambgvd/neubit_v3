"""Pydantic request/response schemas for the branding API.

Storage and API differ on the logo: the DB stores a ``logo_key`` (a storage path),
the API exposes a ``logo_url`` the router resolves via ``storage.url(...)`` at
response time. There is no ``from_attributes`` round-trip for it.
"""

from __future__ import annotations

import uuid

from pydantic import BaseModel, ConfigDict


class BrandingOut(BaseModel):
    """What the frontend consumes to theme itself.

    ``logo_url`` is a resolved, fetchable URL, or None when no logo is uploaded.
    """

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    app_name: str
    logo_url: str | None
    primary_color: str
    accent_color: str
    name_in_header: bool


class UpdateBrandingIn(BaseModel):
    """Partial update — every field optional, so a client can change one thing."""

    app_name: str | None = None
    primary_color: str | None = None
    accent_color: str | None = None
    name_in_header: bool | None = None
