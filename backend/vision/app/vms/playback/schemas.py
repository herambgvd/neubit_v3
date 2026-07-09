"""Recorded-playback request/response schemas (pydantic v2, P4-A).

  * ``PlaybackStartBody``       — POST body for a recorded session (from/to/profile).
  * ``PlaybackRange``           — one recorded time-range (start + duration) from nvr.
  * ``RecordedPlaybackPublic``  — the issued recorded session: the token-carrying
    playback HLS URL + ranges + window + expiry (mirrors the live PlaybackSession).
  * ``TimelineSegment``         — one coverage/gap block on the scrub bar.
  * ``TimelineResponse``        — coverage + gaps + total recorded seconds for a day.
"""

from __future__ import annotations

from datetime import datetime
from typing import List, Optional

from pydantic import BaseModel, ConfigDict, Field


class PlaybackStartBody(BaseModel):
    """POST /cameras/{id}/playback — start a recorded-playback session over [from,to]."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)
    # ``from`` is a Python keyword → alias.
    from_: datetime = Field(alias="from")
    to: datetime
    profile: str = Field(default="main", max_length=16)


class PlaybackRange(BaseModel):
    """One recorded time-range MediaMTX reports for the path."""

    model_config = ConfigDict(extra="ignore")
    start: datetime
    duration: float  # seconds


class RecordedPlaybackPublic(BaseModel):
    """The issued recorded session — playback URL (with ``?token=``) + ranges + window."""

    model_config = ConfigDict(extra="ignore", populate_by_name=True)
    session_id: str
    camera_id: str
    kind: str = "recorded"
    profile: str
    hls_url: Optional[str] = None  # the token-carrying playback /get URL
    token: str
    from_: datetime = Field(serialization_alias="from")
    to: datetime
    ranges: List[PlaybackRange] = Field(default_factory=list)
    expires_at: datetime


class TimelineSegment(BaseModel):
    """A contiguous [start, end] block on the scrub bar (coverage or gap)."""

    model_config = ConfigDict(extra="ignore")
    start: datetime
    end: datetime


class TimelineMarker(BaseModel):
    """One event marker plotted on the scrub bar (P5-B).

    Sourced from ``VmsEvent`` rows whose ``occurred_at`` falls in the window — the P5-C
    scrub bar renders a tick per marker (colour by severity) and jumps playback to ``t``
    on click. ``event_id`` links back to the event feed / a start-recording clip.
    """

    model_config = ConfigDict(extra="ignore")
    t: datetime
    event_type: str
    severity: str
    event_id: str
    camera_id: Optional[str] = None


class TimelineResponse(BaseModel):
    """Recording coverage + gaps (+ event markers) for the scrub bar over the window.

    ``coverage`` are the merged recorded blocks; ``gaps`` the holes between them
    within [from, to]; ``total_seconds`` the summed recorded duration; ``markers`` the
    VmsEvent ticks at their ``occurred_at`` (P5-B).
    """

    model_config = ConfigDict(extra="ignore", populate_by_name=True)
    camera_id: str
    from_: datetime = Field(serialization_alias="from")
    to: datetime
    coverage: List[TimelineSegment] = Field(default_factory=list)
    gaps: List[TimelineSegment] = Field(default_factory=list)
    markers: List[TimelineMarker] = Field(default_factory=list)
    total_seconds: float = 0.0
