"""Live-streaming request/response schemas (pydantic v2).

A ``PlaybackSessionPublic`` is what ``POST /cameras/{id}/live`` (+ ``/renew``)
returns: the browser-facing HLS/WebRTC URLs (already carrying ``?token=``), the raw
media token, and the expiry. The token is returned ONCE at issue/renew time (only
its hash is persisted) so the client can attach it to WHEP requests that can't use
a query string.
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field


class LiveStartBody(BaseModel):
    """POST /cameras/{id}/live — start (or re-ensure) a live session.

    ``profile`` prefers the low-bandwidth sub-stream for live viewing; the service
    falls back to main/onvif when no sub profile exists.
    """

    model_config = ConfigDict(extra="forbid")
    profile: str = Field(default="sub", max_length=16)


class PlaybackSessionPublic(BaseModel):
    """The issued session — URLs + media token + expiry."""

    model_config = ConfigDict(extra="ignore")
    session_id: str
    camera_id: str
    kind: str = "live"
    profile: str
    hls_url: Optional[str] = None
    webrtc_url: Optional[str] = None
    rtsp_url: Optional[str] = None
    token: str
    expires_at: datetime
    ready: bool = False
