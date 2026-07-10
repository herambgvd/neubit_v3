"""Stream codec policy — force the web (sub) stream to H.264 for zero-transcode live.

Chrome WebRTC can't decode H.265, so an H.265 sub-stream forces a CPU-heavy
H.265→H.264 transcode on the live hot-path. Cameras/NVRs support per-stream codecs —
the fix is to push the SUB (web-viewing) stream to H.264 AT THE DEVICE so live view
plays directly, while the MAIN stream stays H.265 for storage-efficient recording.

This module is the tiny policy gate for the auto-enforce-on-onboard hook + the manual
apply endpoints. It is intentionally minimal — storage-free, a single env flag:

  * ``VE_ENFORCE_H264_WEB`` (default ``true``) — when on, onboarding a camera that has
    an H.265 sub-stream best-effort pushes it to H.264 (async, non-blocking, logged).

The transcode fallback (mediamtx ``/h264`` path + the LivePlayer H.265→H.264 fallback)
STAYS as a safety net for devices that can't be reconfigured — this policy only avoids
the transcode where the device CAN serve an H.264 sub-stream. Kept dependency-light so
it can be imported anywhere (onboarding hot path, apply endpoints) without a cycle.
"""

from __future__ import annotations

import os

# The codec browsers can always decode over WebRTC/HLS — the web (sub) stream target.
WEB_CODEC = "h264"
# The role of the stream live view prefers (the small, browser-friendly one).
WEB_STREAM_ROLE = "sub"

_TRUTHY = {"1", "true", "yes", "on", "t", "y"}
_FALSY = {"0", "false", "no", "off", "f", "n"}


def enforce_h264_web() -> bool:
    """Is the "force H.264 web (sub) stream" policy ON? ``VE_ENFORCE_H264_WEB`` (default
    ``true``). Any unrecognised value → the default (on) — the policy is opt-OUT."""
    raw = os.environ.get("VE_ENFORCE_H264_WEB", "").strip().lower()
    if raw in _FALSY:
        return False
    if raw in _TRUTHY:
        return True
    return True  # default ON


def needs_web_codec_enforcement(sub_codec: str | None) -> bool:
    """Should we push the sub-stream to H.264? True when the policy is ON AND the current
    sub codec is known-and-not-H.264 (unknown → don't churn a device we can't read)."""
    if not enforce_h264_web():
        return False
    if not sub_codec:
        return False
    return _norm(sub_codec) != "H264"


def _norm(codec: str | None) -> str | None:
    if not codec:
        return None
    s = str(codec).upper().replace("-", "").replace(".", "")
    if "265" in s or "HEVC" in s:
        return "H265"
    if "264" in s or s == "AVC":
        return "H264"
    if "JPEG" in s or "MJPEG" in s:
        return "MJPEG"
    return s or None
