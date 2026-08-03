"""POS ingest/stream request + response shapes."""

from __future__ import annotations

from datetime import datetime, timezone

from pydantic import BaseModel, Field, field_validator


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class PosLine(BaseModel):
    """A single POS transaction text line (as ingested and as streamed)."""

    terminal: str = Field(..., description="POS terminal id (matches camera pos_overlay.source)")
    camera_id: str | None = Field(None, description="optional direct camera target")
    text: str = Field(..., description="the transaction text line to overlay")
    ts: str = Field(default_factory=_now_iso, description="ISO-8601 timestamp of the line")


class PosIngestBody(BaseModel):
    """POS push payload — a SINGLE line (top-level fields) or a BATCH (``lines``).

    Single:  ``{"terminal": "POS-1", "text": "ITEM  MILK  1.99"}``
    Batch:   ``{"lines": [{"terminal": "POS-1", "text": "..."}, ...]}``

    ``terminal`` may be omitted on a line IFF ``camera_id`` is given — the terminal is
    then resolved from that camera's ``pos_overlay.source``.
    """

    # Single-line form (top-level).
    terminal: str | None = None
    camera_id: str | None = None
    text: str | None = None
    ts: str | None = None
    # Batch form.
    lines: list["PosIngestLineIn"] | None = None

    @field_validator("lines")
    @classmethod
    def _cap_batch(cls, v):
        if v is not None and len(v) > 500:
            raise ValueError("batch too large (max 500 lines)")
        return v


class PosIngestLineIn(BaseModel):
    terminal: str | None = None
    camera_id: str | None = None
    text: str
    ts: str | None = None


class PosIngestResult(BaseModel):
    accepted: int = Field(..., description="lines accepted + fanned out")
    terminals: list[str] = Field(default_factory=list, description="distinct terminals touched")


PosIngestBody.model_rebuild()
