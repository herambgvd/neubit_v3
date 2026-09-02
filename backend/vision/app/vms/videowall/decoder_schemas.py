"""Video-decoder control-plane request/response schemas (pydantic v2, VW-B).

The contract the wall-management UI builds against for registering + testing hardware
video-decoder appliances (Hik / Dahua-CP-Plus). Mirrors the camera domain's
Create/Update/Public discipline; ``tenant_id`` is enforced server-side, the password is
write-only (accepted on create/update, NEVER returned) and stored REVERSIBLY encrypted.
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

# Registered decoder brands (see drivers/decoder_factory).
DecoderBrand = Literal["hikvision", "dahua_cpplus"]


class DecoderCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=255)
    brand: DecoderBrand = "hikvision"
    host: str = Field(min_length=1, max_length=255)
    port: int = Field(default=80, ge=1, le=65535)
    username: Optional[str] = Field(default=None, max_length=255)
    # Write-only — encrypted at rest, never echoed back.
    password: Optional[str] = Field(default=None, max_length=512)
    channel_count: int = Field(default=0, ge=0, le=256)
    is_enabled: bool = True


class DecoderUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: Optional[str] = Field(default=None, min_length=1, max_length=255)
    brand: Optional[DecoderBrand] = None
    host: Optional[str] = Field(default=None, min_length=1, max_length=255)
    port: Optional[int] = Field(default=None, ge=1, le=65535)
    username: Optional[str] = Field(default=None, max_length=255)
    password: Optional[str] = Field(default=None, max_length=512)
    channel_count: Optional[int] = Field(default=None, ge=0, le=256)
    is_enabled: Optional[bool] = None


class DecoderPublic(BaseModel):
    """A decoder row — the password is NEVER included; ``has_password`` flags whether one
    is stored."""

    model_config = ConfigDict(extra="ignore")
    id: str
    name: str
    brand: str
    host: str
    port: int
    username: Optional[str] = None
    has_password: bool = False
    channel_count: int
    is_enabled: bool
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_row(cls, row) -> "DecoderPublic":
        return cls.model_validate(
            {
                "id": row.id,
                "name": row.name,
                "brand": row.brand,
                "host": row.host,
                "port": row.port,
                "username": row.username,
                "has_password": bool(row.enc_password),
                "channel_count": row.channel_count,
                "is_enabled": row.is_enabled,
                "created_at": row.created_at,
                "updated_at": row.updated_at,
            }
        )


class DecoderListResponse(BaseModel):
    items: list[DecoderPublic]
    total: int


class DecoderTestResult(BaseModel):
    """Result of ``POST /decoders/{id}/test`` — a live ``probe()`` of the appliance."""

    model_config = ConfigDict(extra="ignore")
    reachable: bool
    manufacturer: Optional[str] = None
    model: Optional[str] = None
    firmware: Optional[str] = None
    serial_number: Optional[str] = None
    channel_count: int = 0
    error: Optional[str] = None
