"""OnvifServerConfig schemas (pydantic v2, P6-C).

  * ``OnvifServerConfigUpdate`` — the upsert body (enable + exposed cameras + service
    creds + advertised host/ports). The password is write-only (never returned).
  * ``OnvifServerConfigPublic`` — the config view; ``password_set`` flags whether a
    credential exists WITHOUT ever echoing it.
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field


class OnvifServerConfigUpdate(BaseModel):
    """Upsert body — all fields optional (PATCH semantics); creds are write-only."""

    model_config = ConfigDict(extra="forbid")

    enabled: Optional[bool] = None
    # ``["*"]`` = every enabled camera in the tenant, else explicit ids.
    exposed_camera_ids: Optional[list[str]] = None
    service_username: Optional[str] = Field(default=None, min_length=1, max_length=255)
    service_password: Optional[str] = Field(default=None, min_length=1, max_length=512)
    device_name: Optional[str] = Field(default=None, min_length=1, max_length=255)
    advertised_host: Optional[str] = Field(default=None, max_length=255)
    advertised_http_port: Optional[int] = Field(default=None, ge=1, le=65535)
    advertised_rtsp_port: Optional[int] = Field(default=None, ge=1, le=65535)


class OnvifServerConfigPublic(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: str
    enabled: bool
    exposed_camera_ids: list[str]
    service_username: str
    password_set: bool
    device_name: str
    advertised_host: Optional[str] = None
    advertised_http_port: Optional[int] = None
    advertised_rtsp_port: Optional[int] = None
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_row(cls, row) -> "OnvifServerConfigPublic":
        return cls.model_validate({
            "id": row.id,
            "enabled": row.enabled,
            "exposed_camera_ids": list(row.exposed_camera_ids or []),
            "service_username": row.service_username,
            "password_set": bool(row.service_enc_password),
            "device_name": row.device_name,
            "advertised_host": row.advertised_host,
            "advertised_http_port": row.advertised_http_port,
            "advertised_rtsp_port": row.advertised_rtsp_port,
            "created_at": row.created_at,
            "updated_at": row.updated_at,
        })
