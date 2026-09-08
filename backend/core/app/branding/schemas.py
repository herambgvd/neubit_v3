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

    ``logo_url`` and ``favicon_url`` are resolved, fetchable URLs, or None when
    nothing is uploaded.

    The brand colours and `name_in_header` are deliberately ABSENT. They were
    carried here and used by nothing but the swatch beside their own pickers; the
    columns remain (see models.py) so no deployment loses data, but the API no
    longer offers a field that governs nothing.
    """

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    app_name: str
    logo_url: str | None
    favicon_url: str | None


class UpdateBrandingIn(BaseModel):
    """Partial update — every field optional, so a client can change one thing.

    Name only: the logo and the favicon are uploads (POST /logo, /favicon).
    """

    app_name: str | None = None
