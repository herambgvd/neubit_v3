"""ffmpeg pull helper for ANR backfill (P6-A).

The ANR fulfiller pulls a replay RTSP/URI (from the edge SD-card or the NVR's own
storage, via the P4-B driver ``get_playback_uri``) and writes it as an fmp4 segment
onto the shared ``recordings`` volume under the SAME on-disk layout the Go ``nvr``
segment tracker watches — so the pulled footage flows through the normal
segment-tracker → ``recording.segment`` → ``Recording`` row path (no double-write).

  * SOURCE is an RTSP replay URI (ONVIF Profile-G ``rtsp://…?…`` / Hikvision/CP-Plus
    time-window playback URL). ``pull_segment`` stream-copies it (``-c copy``,
    near-instant + lossless — the on-device H.264/H.265 is preserved) into an fmp4
    (``-movflags`` frag) file. A duration cap (``-t``) bounds the pull to the gap
    length so a mis-behaving replay stream can't run forever, and a wall-clock timeout
    hard-stops the subprocess.
  * OUTPUT filename matches MediaMTX's ``%Y-%m-%d_%H-%M-%S-%f.mp4`` template (micros
    separated by ``-``, UTC) stamped at the gap START so the tracker parses the right
    ``started_at`` + the coverage lines up with the hole.

Everything is subprocess-based (``asyncio.create_subprocess_exec``) with a bounded
timeout; a non-zero exit / missing ffmpeg / empty output raises ``AnrFfmpegError``
which the fulfiller maps to ``result{status:failed}`` (never crashes the loop).
"""

from __future__ import annotations

import asyncio
import logging
import os
import shlex
from datetime import datetime, timezone

log = logging.getLogger("vision.anr.ffmpeg")

# Cap a single ANR pull so a wedged replay stream can't hold a slot forever. The
# ``-t`` duration cap already bounds normal work; this is the hard wall-clock stop.
_FFMPEG_TIMEOUT_SEC = 1800.0


class AnrFfmpegError(Exception):
    """ffmpeg failed / not installed / produced no output → the job is ``failed``."""


def segment_filename(start: datetime) -> str:
    """MediaMTX-style segment filename for ``start`` (UTC): ``%Y-%m-%d_%H-%M-%S-%f.mp4``.

    Micros are separated with ``-`` (not ``.``) to match the Go tracker's
    ``parseSegmentStart`` — which splits on the LAST ``-`` and treats the tail as
    microseconds. A 6-digit zero-padded micros field keeps the parse unambiguous.
    """
    s = start.astimezone(timezone.utc)
    return f"{s.strftime('%Y-%m-%d_%H-%M-%S')}-{s.microsecond:06d}.mp4"


async def pull_segment(
    source_uri: str,
    out_path: str,
    *,
    duration_sec: float | None = None,
) -> int:
    """Pull ``source_uri`` (replay RTSP) → ``out_path`` (fmp4). Returns the byte size.

    Stream-copies (``-c copy``) the on-device footage into a fragmented mp4 so the
    original codec is preserved and the pull is near-instant. ``duration_sec`` caps the
    pull to the gap length (omit to pull until the source ends). ``-rtsp_transport tcp``
    keeps replay reliable over lossy links. The output dir is created if absent.

    Raises ``AnrFfmpegError`` on a missing binary, a non-zero exit, a timeout, or an
    empty output — the caller maps that to a failed ANR result.
    """
    if not source_uri:
        raise AnrFfmpegError("no source URI to pull")

    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)

    args = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y"]
    # RTSP replay is more reliable over TCP; harmless for a non-RTSP source (ffmpeg
    # ignores -rtsp_transport when the input isn't rtsp://).
    if source_uri.startswith("rtsp://"):
        args += ["-rtsp_transport", "tcp"]
    args += ["-i", source_uri]
    if duration_sec and duration_sec > 0:
        args += ["-t", f"{duration_sec:.3f}"]
    # Stream-copy into a fragmented mp4 (fmp4) — same container family the live record
    # path writes, playable + concatenable by the export path.
    args += [
        "-c", "copy",
        "-movflags", "+frag_keyframe+empty_moov+default_base_moof",
        "-f", "mp4",
        out_path,
    ]

    try:
        try:
            proc = await asyncio.create_subprocess_exec(
                *args,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except (FileNotFoundError, OSError) as exc:
            raise AnrFfmpegError(f"ffmpeg not available: {exc}") from exc

        try:
            _stdout, stderr = await asyncio.wait_for(
                proc.communicate(), timeout=_FFMPEG_TIMEOUT_SEC
            )
        except asyncio.TimeoutError as exc:
            try:
                proc.kill()
            except ProcessLookupError:
                pass
            raise AnrFfmpegError("ffmpeg pull timed out") from exc

        if proc.returncode != 0:
            detail = (stderr or b"").decode("utf-8", "replace")[-500:]
            log.info(
                "ffmpeg anr pull failed (%s): %s",
                " ".join(shlex.quote(a) for a in args), detail,
            )
            raise AnrFfmpegError(f"ffmpeg exited {proc.returncode}: {detail}")
    finally:
        pass

    try:
        size = os.path.getsize(out_path)
    except OSError:
        size = 0
    if size == 0:
        # Clean up a zero-byte artifact so the segment tracker never sees it.
        try:
            os.unlink(out_path)
        except OSError:
            pass
        raise AnrFfmpegError("ffmpeg produced no output")
    return size
