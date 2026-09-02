"""MediaMTX single-frame grab + short-lived cache for camera snapshots.

The ONVIF ``GetSnapshotUri`` path (``driver.get_snapshot``) does not work for
NVR-channel cameras (many NVRs don't expose a per-channel HTTP JPEG endpoint).
But those cameras ARE published into MediaMTX for live view, so we can pull a
single frame straight off the live path with ffmpeg — codec-agnostic, so it
works for both H.264 and H.265 sources.

  * Path convention mirrors the Go ``nvr`` (``mediamtx.PathName``):
    ``cameras/<tenant>/<camera>/<profile>`` where an absent tenant → ``platform``.
    We prefer the ``sub`` profile (low-res) — plenty for a thumbnail and cheap.
  * The grab is a bounded ``asyncio`` subprocess (never blocks the event loop,
    never raises past this module — degrades to ``None``).
  * Results are cached in-memory per (camera, profile) for a short TTL so the
    16-tile grid + repeated thumbnail loads don't spawn an ffmpeg + activate a
    MediaMTX on-demand source on every request.

NOTE: grabbing a frame activates the camera's on-demand MediaMTX source briefly
(the source spins down again after MediaMTX's idle timeout). The cache bounds how
often that happens — at most one activation per camera per TTL window.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time

log = logging.getLogger("vision.snapshot_frame")

# In-cluster MediaMTX RTSP base. vision→mediamtx is the internal docker DNS name
# (``rtsp://mediamtx:8554``); ``VE_MEDIAMTX_RTSP_BASE`` overrides for other topologies
# (the nvr service already reads the same var; default there is localhost for the
# ONVIF-server URLs, so we DON'T reuse that default — vision's internal default is
# the service name).
_DEFAULT_RTSP_BASE = "rtsp://mediamtx:8554"

# Hard wall-clock stop for the frame grab. The on-demand MediaMTX source has to
# connect to the camera + pull a keyframe, so allow generous headroom.
_FFMPEG_TIMEOUT_SEC = 15.0

# How long a grabbed JPEG stays fresh in the in-memory cache.
_CACHE_TTL_SEC = 30.0

# {(camera_id, profile): (monotonic_ts, jpeg_bytes)}
_cache: dict[tuple[str, str], tuple[float, bytes]] = {}


def rtsp_base() -> str:
    return (os.environ.get("VE_MEDIAMTX_RTSP_BASE") or _DEFAULT_RTSP_BASE).rstrip("/")


def mediamtx_path(tenant_id, camera_id: str, profile: str = "sub") -> str:
    """MediaMTX path for a camera+profile — mirrors Go ``mediamtx.PathName``.

    An absent tenant falls back to ``platform`` (same as the Go streams handler),
    so platform-scoped cameras resolve to the same path vision/nvr publish under.
    """
    tenant = str(tenant_id) if tenant_id else "platform"
    prof = profile or "main"
    return f"cameras/{tenant}/{camera_id}/{prof}"


def cache_get(camera_id: str, profile: str) -> bytes | None:
    """Return a cached JPEG if still fresh, else ``None`` (and evict if stale)."""
    entry = _cache.get((camera_id, profile))
    if entry is None:
        return None
    ts, jpeg = entry
    if (time.monotonic() - ts) <= _CACHE_TTL_SEC:
        return jpeg
    _cache.pop((camera_id, profile), None)
    return None


def cache_put(camera_id: str, profile: str, jpeg: bytes) -> None:
    if jpeg:
        _cache[(camera_id, profile)] = (time.monotonic(), jpeg)


async def grab_frame(
    rtsp_url: str,
    *,
    timeout_sec: float = _FFMPEG_TIMEOUT_SEC,
) -> bytes | None:
    """Grab ONE JPEG frame from ``rtsp_url`` via ffmpeg. Returns bytes or ``None``.

    Codec-agnostic (ffmpeg decodes H.264/H.265 alike) and non-blocking (async
    subprocess, output captured from stdout). NEVER raises — a missing binary, a
    non-zero exit, a timeout, or empty output all degrade to ``None`` so the
    endpoint 502s gracefully and the frontend shows its placeholder.
    """
    if not rtsp_url:
        return None

    args = [
        "ffmpeg",
        "-nostdin",
        "-loglevel", "error",
        "-rtsp_transport", "tcp",
        "-analyzeduration", "5M",
        "-probesize", "5M",
        "-i", rtsp_url,
        "-frames:v", "1",
        "-q:v", "4",
        "-f", "mjpeg",
        "pipe:1",
    ]

    proc = None
    try:
        try:
            proc = await asyncio.create_subprocess_exec(
                *args,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except (FileNotFoundError, OSError) as exc:
            log.info("snapshot frame-grab: ffmpeg not available: %s", exc)
            return None

        try:
            stdout, stderr = await asyncio.wait_for(
                proc.communicate(), timeout=timeout_sec
            )
        except asyncio.TimeoutError:
            log.info("snapshot frame-grab timed out (%s)", rtsp_url)
            try:
                proc.kill()
                await proc.wait()
            except (ProcessLookupError, OSError):
                pass
            return None

        if proc.returncode != 0 or not stdout:
            detail = (stderr or b"").decode("utf-8", "replace")[-300:]
            log.info(
                "snapshot frame-grab failed (rc=%s, %s): %s",
                proc.returncode, rtsp_url, detail,
            )
            return None
        return stdout
    except Exception as exc:  # noqa: BLE001 — snapshot must NEVER crash the request
        log.info("snapshot frame-grab unexpected error (%s): %s", rtsp_url, exc)
        # Reap a dangling proc if the failure was after spawn.
        if proc is not None and proc.returncode is None:
            try:
                proc.kill()
                await proc.wait()
            except (ProcessLookupError, OSError):
                pass
        return None
