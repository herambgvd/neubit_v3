"""Request / response models for the DashForge embed registry.

Validate the envelope, never the meaning. NeuBit does not know what a DashForge
dashboard's variables are called, so a `scope` binding is checked only for shape:
a bounded flat map of non-empty names to strings. Whether a given key is lockable
is DashForge's question, answered at mint with a message naming it.

The bounds are not a security boundary — the HMAC signature is. They keep a
registration from producing a token too long for a URL path segment, and mirror
DashForge's own `maxScopeBindings` / `maxScopeValueLen` so the refusal lands at
registration time, in front of a form, rather than at mint.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, field_validator

from .categories import DEFAULT_CATEGORY, normalize as _normalize_category

MAX_SCOPE_BINDINGS = 16
MAX_SCOPE_VALUE_LEN = 512
# DashForge ids are its own; this only stops a pathological string from reaching
# a URL. Anything DashForge would reject still gets rejected by DashForge.
MAX_REF_LEN = 64


def _clean_scope(value: dict | None) -> dict:
    if not value:
        return {}
    if len(value) > MAX_SCOPE_BINDINGS:
        raise ValueError(f"at most {MAX_SCOPE_BINDINGS} locked filters")
    out: dict[str, str] = {}
    for name, val in value.items():
        key = str(name).strip()
        if not key:
            raise ValueError("a locked filter name cannot be empty")
        text = "" if val is None else str(val)
        if len(text) > MAX_SCOPE_VALUE_LEN:
            raise ValueError(f"locked value for {key} is too long")
        out[key] = text
    return out


class EmbedCreate(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    description: str | None = Field(default=None, max_length=1024)
    # Which console shows it. Defaulted rather than required so a registration
    # made before the field existed — or by a script — is still findable, under
    # "General", instead of belonging to no tab at all.
    category: str = DEFAULT_CATEGORY
    workspace_ref: str = Field(min_length=1, max_length=MAX_REF_LEN)
    dashboard_ref: str = Field(min_length=1, max_length=MAX_REF_LEN)
    scope: dict[str, str] = Field(default_factory=dict)

    @field_validator("scope")
    @classmethod
    def _scope(cls, v):
        return _clean_scope(v)

    @field_validator("category")
    @classmethod
    def _category(cls, v):
        return _normalize_category(v)


class EmbedUpdate(BaseModel):
    """Every field optional; unset means unchanged.

    `scope` set to `{}` is a real edit — it removes the lock — so it must not be
    conflated with absence. The service tells them apart via `model_fields_set`,
    which is why there is no sentinel default here.
    """

    name: str | None = Field(default=None, min_length=1, max_length=160)
    description: str | None = Field(default=None, max_length=1024)
    category: str | None = None
    workspace_ref: str | None = Field(default=None, min_length=1, max_length=MAX_REF_LEN)
    dashboard_ref: str | None = Field(default=None, min_length=1, max_length=MAX_REF_LEN)
    scope: dict[str, str] | None = None

    @field_validator("scope")
    @classmethod
    def _scope(cls, v):
        return None if v is None else _clean_scope(v)

    @field_validator("category")
    @classmethod
    def _category(cls, v):
        return None if v is None else _normalize_category(v)


class EmbedPublic(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    name: str
    description: str | None
    category: str
    workspace_ref: str
    dashboard_ref: str
    scope: dict
    created_by: uuid.UUID | None
    created_at: datetime
    updated_at: datetime


class EmbedListResponse(BaseModel):
    items: list[EmbedPublic]
    total: int


class EmbedSession(BaseModel):
    """One viewing session's credential.

    `iframe_url` is absolute and browser-resolvable, built from
    VE_DASHFORGE_PUBLIC_URL, not the internal base URL. The token is echoed
    separately because the DashForge JS SDK takes a token, not a URL.

    `expires_at` is DashForge's own answer, passed through unaltered — it is the
    signature's expiry, and restating it from NeuBit's clock would drift. The
    frontend re-mints on it.
    """

    embed_id: str
    token: str
    iframe_url: str
    expires_at: str
    scope: dict
