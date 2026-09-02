"""ffmpeg concat/remux helpers for clip export (P4-B).

The export worker calls ``concat_segments`` to fuse the covered fmp4 recording
segments into a single mp4, trimmed to the exact [from, to] window:

  * FAST PATH (``-c copy``): stream-copy the segments (no re-encode) via the ffmpeg
    *concat demuxer* (a list file of ``file '<path>'`` lines). This is near-instant and
    lossless — used whenever the segments share a codec (the common case: one camera /
    one profile writes uniform fmp4). Head/tail trimming uses ``-ss`` / ``-to`` on the
    concatenated timeline so the clip starts/ends at the requested instant.
  * The output is remuxed into an mp4 container with ``+faststart`` so the moov atom is
    at the front (progressive download / seek-friendly).

Everything is subprocess-based (``asyncio.create_subprocess_exec``) with a bounded
timeout; a non-zero exit / missing ffmpeg raises ``ExportFfmpegError`` which the worker
maps to ``status=failed`` (never crashes the loop). S3-tiered segments (``s3://`` path)
are NOT concatenable in-place — the worker skips those windows with a clear error
(a P4-C/P6 enhancement can stage them locally first).

Segment ordering + the head-offset are computed by the caller (the worker) from the
Recording rows; this module is pure ffmpeg mechanics + a list-file writer.
"""

from __future__ import annotations

import asyncio
import logging
import os
import shlex
import tempfile

log = logging.getLogger("vision.export.ffmpeg")

# Cap a single concat so a pathological window can't wedge the worker forever.
_FFMPEG_TIMEOUT_SEC = 900.0


class ExportFfmpegError(Exception):
    """ffmpeg failed / not installed / produced no output → the job is ``failed``."""


def _write_concat_list(segment_paths: list[str]) -> str:
    """Write an ffmpeg concat-demuxer list file, return its path. Caller unlinks it.

    Each line is ``file '<abs-path>'`` with single-quotes escaped per the concat-demuxer
    grammar (``'`` → ``'\\''``). The paths are the ordered local fmp4 segment files.
    """
    fd, list_path = tempfile.mkstemp(prefix="vms-export-", suffix=".txt")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            for p in segment_paths:
                escaped = p.replace("'", "'\\''")
                fh.write(f"file '{escaped}'\n")
    except Exception:  # noqa: BLE001
        try:
            os.unlink(list_path)
        except OSError:
            pass
        raise
    return list_path


def _drawtext_escape(s: str) -> str:
    """Escape a string for ffmpeg's ``drawtext`` text= value (``:``, ``'``, ``\\``, ``%``)."""
    return (
        s.replace("\\", "\\\\")
        .replace(":", "\\:")
        .replace("'", "\\'")
        .replace("%", "\\%")
    )


def build_watermark_filter(text: str) -> str:
    """A ``drawtext`` filter drawing ``text`` bottom-left with a translucent box + a
    live wall-clock timestamp appended (``%{localtime}``) — the site/camera/time overlay.

    White text on a semi-opaque black box, small padding, anchored 12px from the
    bottom-left. Uses ffmpeg's builtin ``%{localtime}`` so the burned-in time reflects
    render time (documented; a per-frame recorded-time overlay is a later refinement).
    """
    label = _drawtext_escape(text)
    return (
        f"drawtext=text='{label} %{{localtime}}':"
        "x=12:y=h-th-12:fontsize=18:fontcolor=white:"
        "box=1:boxcolor=black@0.5:boxborderw=6"
    )


async def concat_segments(
    segment_paths: list[str],
    out_path: str,
    *,
    head_offset_sec: float = 0.0,
    duration_sec: float | None = None,
    watermark_text: str | None = None,
) -> None:
    """Concat + trim ``segment_paths`` → ``out_path`` (mp4).

    ``head_offset_sec`` trims the front of the concatenated timeline (the requested
    ``from`` may fall inside the first segment); ``duration_sec`` caps the total length
    (the requested ``to`` may fall inside the last segment). Both are optional — omit
    to keep the whole concatenated span.

    FAST PATH (``watermark_text is None``): stream-copy (``-c copy``) — near-instant,
    lossless. RE-ENCODE PATH (``watermark_text`` given): a visible ``drawtext`` overlay
    (site/camera/time) is burned in, which requires decoding + re-encoding the video
    (H.264, ``-preset veryfast``); audio is stream-copied. Watermarking trades speed for
    a tamper-visible, provenance-stamped clip.

    Raises ``ExportFfmpegError`` on a missing binary, a non-zero exit, or an empty
    output. The output dir is created if absent.
    """
    if not segment_paths:
        raise ExportFfmpegError("no segments to concat")

    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    list_path = _write_concat_list(segment_paths)

    # ffmpeg concat demuxer. ``-ss`` before ``-i`` on a concat list seeks on the
    # (concatenated) input timeline; ``-t`` caps duration. ``+faststart`` moves moov to
    # the front for progressive playback.
    args = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y"]
    if head_offset_sec and head_offset_sec > 0:
        args += ["-ss", f"{head_offset_sec:.3f}"]
    args += ["-f", "concat", "-safe", "0", "-i", list_path]
    if duration_sec and duration_sec > 0:
        args += ["-t", f"{duration_sec:.3f}"]
    if watermark_text:
        # RE-ENCODE: burn in the drawtext overlay (video re-encoded; audio copied).
        args += [
            "-vf", build_watermark_filter(watermark_text),
            "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
            "-c:a", "copy",
        ]
    else:
        # FAST PATH: stream-copy (keyframe-accurate copy-trim of the fmp4 segments).
        args += ["-c", "copy"]
    args += ["-movflags", "+faststart", out_path]

    try:
        try:
            proc = await asyncio.create_subprocess_exec(
                *args,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except (FileNotFoundError, OSError) as exc:
            raise ExportFfmpegError(f"ffmpeg not available: {exc}") from exc

        try:
            _stdout, stderr = await asyncio.wait_for(
                proc.communicate(), timeout=_FFMPEG_TIMEOUT_SEC
            )
        except asyncio.TimeoutError as exc:
            try:
                proc.kill()
            except ProcessLookupError:
                pass
            raise ExportFfmpegError("ffmpeg concat timed out") from exc

        if proc.returncode != 0:
            detail = (stderr or b"").decode("utf-8", "replace")[-500:]
            log.info("ffmpeg concat failed (%s): %s", " ".join(shlex.quote(a) for a in args), detail)
            raise ExportFfmpegError(f"ffmpeg exited {proc.returncode}: {detail}")
    finally:
        try:
            os.unlink(list_path)
        except OSError:
            pass

    if not os.path.exists(out_path) or os.path.getsize(out_path) == 0:
        raise ExportFfmpegError("ffmpeg produced no output")
