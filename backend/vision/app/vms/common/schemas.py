"""Cross-domain VMS schema primitives (pydantic v2).

Only genuinely shared building blocks live here — the typed status/type literals
that mirror the plain-string model columns and are referenced by more than one
domain (cameras / nvr / groups). Domain-owned shapes stay in their own package
(``cameras/schemas.py``, ``nvr/schemas.py``, ``groups/schemas.py``).
"""

from __future__ import annotations

from typing import Literal

# ── Shared literals (match the plain-string model columns) ──────────────────────

CameraStatus = Literal["online", "offline", "connecting", "error"]
ConnectionType = Literal["rtsp", "onvif", "nvr_channel"]
RecordingMode = Literal["continuous", "schedule", "motion", "manual"]
ProfileName = Literal["main", "sub", "third"]
NvrStatus = Literal["online", "offline", "connecting", "error", "unknown"]
NodeStatus = Literal["online", "offline", "draining", "error", "unknown"]
AclSubjectType = Literal["role", "user", "group"]
AclTargetType = Literal["camera", "group"]
AclPrivilege = Literal["view_live", "playback", "export", "ptz", "config"]
