"""Request / response models for the DashForge embed registry.

The rule this file follows is the same one `dashboards/schemas.py` documents for
widget specs, applied to a different foreign object: validate the ENVELOPE, never
the meaning. NeuBit does not know what a DashForge dashboard's variables are
called, so a `scope` binding is checked for shape (a flat map of non-empty names
to strings, bounded) and nothing else. Whether `site_id` is lockable on dashboard
41 is a question only DashForge can answer, and it answers it at mint with a
message naming the offending key.

The bounds below are NOT a security boundary — the HMAC signature is — they keep
a registration from producing a token string too long to survive a URL path
segment. They mirror DashForge's own `maxScopeBindings` / `maxScopeValueLen` so
the refusal happens at registration time, where a person is looking at a form,
instead of at mint time, where it surfaces as a dashboard that will not open.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, field_validator

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
    workspace_ref: str = Field(min_length=1, max_length=MAX_REF_LEN)
    dashboard_ref: str = Field(min_length=1, max_length=MAX_REF_LEN)
    scope: dict[str, str] = Field(default_factory=dict)

    @field_validator("scope")
    @classmethod
    def _scope(cls, v):
        return _clean_scope(v)


class EmbedUpdate(BaseModel):
    """Every field optional; unset means unchanged.

    `scope` set to `{}` is a REAL edit — it removes the lock — so absence and an
    empty object cannot be conflated. `model_fields_set` is what distinguishes
    them in the service, which is why there is no sentinel default here.
    """

    name: str | None = Field(default=None, min_length=1, max_length=160)
    description: str | None = Field(default=None, max_length=1024)
    workspace_ref: str | None = Field(default=None, min_length=1, max_length=MAX_REF_LEN)
    dashboard_ref: str | None = Field(default=None, min_length=1, max_length=MAX_REF_LEN)
    scope: dict[str, str] | None = None

    @field_validator("scope")
    @classmethod
    def _scope(cls, v):
        return None if v is None else _clean_scope(v)


class EmbedPublic(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    name: str
    description: str | None
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
    VE_DASHFORGE_PUBLIC_URL rather than from the internal base URL — see
    `app/config.py`. The token is echoed separately because the DashForge JS SDK
    takes the token rather than a URL, and a consumer that wants the SDK should
    not have to parse it back out of a path.

    `expires_at` is DashForge's own answer, passed through unaltered: it is the
    signature's expiry, and NeuBit restating it from its own clock would drift.
    The frontend re-mints on it rather than on a locally guessed lifetime.
    """

    embed_id: str
    token: str
    iframe_url: str
    expires_at: str
    scope: dict
