"""Two-way-audio (talk) request/response schemas (pydantic v2) — G6.

``TalkSessionPublic`` is what ``POST /cameras/{id}/talk/session`` returns: the talk
token (returned ONCE), the backchannel target the frontend opens (WHIP/RTSP), the
audio codec the device expects, and the expiry. The token authorizes only the UPLINK
(browser mic → media-plane → camera speaker), never a stream read.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

from pydantic import BaseModel, ConfigDict, Field


class TalkSessionBody(BaseModel):
    """POST /cameras/{id}/talk/session — open a push-to-talk session (optional body)."""

    model_config = ConfigDict(extra="forbid")
    # Which stream profile's backchannel to target (device usually has one speaker;
    # the profile picks the RTSP path the backchannel rides on). Defaults to main.
    profile: str = Field(default="main", max_length=16)


class TalkSessionPublic(BaseModel):
    """The issued talk session — token + backchannel target + codec + expiry."""

    model_config = ConfigDict(extra="ignore")
    session_id: str
    camera_id: str
    # How the frontend pushes audio: ``whip`` (browser mic → MediaMTX → camera),
    # ``rtsp_backchannel`` (ONVIF backchannel RTSP), or ``http_push`` (brand REST).
    kind: str = "whip"
    # The backchannel target URL (WHIP endpoint / brand push URL). May be None when
    # the media-plane resolves it from the token (the frontend then uses whip_url).
    target_url: Optional[str] = None
    # The WHIP endpoint the browser publishes mic audio to (media-plane forwards it to
    # the camera backchannel). Carries ``?token=`` (the talk token) when set.
    whip_url: Optional[str] = None
    # The audio codec the device expects (e.g. PCMU/AAC); None = negotiated on the wire.
    codec: Optional[str] = None
    # The talk token (returned ONCE) — authorizes the uplink only.
    token: str
    expires_at: datetime
    # Advisory: the real on-wire push to a device speaker is unverified hardware work.
    live_validate: bool = True
    extra: dict[str, Any] = Field(default_factory=dict)
