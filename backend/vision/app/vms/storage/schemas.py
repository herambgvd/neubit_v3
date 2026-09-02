"""Recording integrity / lock schemas.

The storage data-plane schemas (StoragePool + TierRule CRUD, pool usage, RAID
health) were retired along with the VMS storage control-plane — the NVR owns
storage/retention/tiering/RAID. Only the recording integrity/lock/verify
request+response shapes remain.
"""

from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, ConfigDict, Field


# ── recording integrity / lock (request + response of lock/unlock/verify) ─────
class RecordingLockBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    reason: Optional[str] = Field(default=None, max_length=255)


class RecordingIntegrityResult(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: str
    integrity_status: str  # verified | corrupted | missing | unchecked
    checksum: Optional[str] = None
    locked: bool
    locked_by: Optional[str] = None
