"""ffmpeg motion-analysis + score→hit-interval helpers for forensic search (G4).

Pure, non-AI Video Motion Detection (VMD) over a recorded fmp4 segment: crop the
drawn region, downsample to a low analysis fps, and emit a per-frame SCENE-CHANGE
score with ffmpeg's ``select`` + ``metadata=print`` filters. Thresholding those
scores over time yields the HIT INTERVALS the frontend plots on the timeline.

── The exact filter chain ────────────────────────────────────────────────────
For one region and one segment we run (video only, no audio, no output file — the
scores go to stderr as metadata):

    ffmpeg -hide_banner -nostats -i <segment> -an \
      -vf "crop=iw*W:ih*H:iw*X:ih*Y,fps=<sample_fps>,\
           select='gte(scene\\,0)',metadata=print:file=-" \
      -f null -

  * ``crop=iw*W:ih*H:iw*X:ih*Y`` — crop to the NORMALIZED region (x/y/w/h in 0..1),
    scaled to pixels via ffmpeg's ``iw``/``ih`` so the search is resolution-independent
    and needs no probe.
  * ``fps=<sample_fps>`` — decimate to the analysis rate (default 4 fps, capped) so a
    long window doesn't decode every frame; this is the time resolution of the scores.
  * ``select='gte(scene\\,0)'`` — a no-op selector whose side effect is to compute
    ``lavfi.scene_score`` (the fraction-of-frame changed, 0..1) into frame metadata for
    EVERY frame (``gte(scene,0)`` is always true).
  * ``metadata=print:file=-`` — print each frame's ``pts_time`` + the
    ``lavfi.scene_score`` to stderr as ``frame:… pts_time:<t>`` / ``lavfi.scene_score=<s>``
    lines that ``parse_scene_scores`` reads.

``scene_score`` is a frame-DIFFERENCE energy over the cropped region, so it is exactly
"how much moved inside the drawn box" — the non-AI motion signal we threshold. (An
alternative, ``scdet``, only prints scores at detected cuts; ``select=gte(scene,0)`` +
metadata gives us the DENSE per-sample series we need to build intervals.)

Everything is subprocess-based with a bounded timeout; a missing binary / non-zero exit
raises ``MotionFfmpegError`` which the worker maps to a partial result + note (never
crashes the loop). The score→interval math (``scores_to_intervals``) is a pure function,
fixture-tested independently of ffmpeg.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import shlex

log = logging.getLogger("vision.motion_search.ffmpeg")

# Cap a single segment-analysis pass so a pathological input can't wedge the worker.
_FFMPEG_TIMEOUT_SEC = 600.0

# ``metadata=print`` emits blocks like:
#   frame:0    pts:0       pts_time:0
#   lavfi.scene_score=0.043210
# We pair each ``pts_time`` with the next ``lavfi.scene_score`` seen.
_PTS_RE = re.compile(r"pts_time:([0-9]+(?:\.[0-9]+)?)")
_SCORE_RE = re.compile(r"lavfi\.scene_score=([0-9]+(?:\.[0-9]+)?)")


class MotionFfmpegError(Exception):
    """ffmpeg failed / not installed → the segment is skipped (partial result + note)."""


def build_motion_filter(region: dict, sample_fps: float) -> str:
    """The ``-vf`` chain for one NORMALIZED region {x,y,w,h} at ``sample_fps``.

    Clamps the region into 0..1 and guards a zero/negative box (falls back to the
    whole frame). Returns the crop → fps → scene-score → metadata-print chain.
    """
    x = _clamp01(region.get("x", 0.0))
    y = _clamp01(region.get("y", 0.0))
    w = _clamp01(region.get("w", 1.0))
    h = _clamp01(region.get("h", 1.0))
    # Keep the crop inside the frame; a degenerate box → whole frame.
    if w <= 0 or h <= 0:
        x, y, w, h = 0.0, 0.0, 1.0, 1.0
    if x + w > 1.0:
        w = max(0.01, 1.0 - x)
    if y + h > 1.0:
        h = max(0.01, 1.0 - y)
    fps = max(0.5, float(sample_fps))
    crop = f"crop=iw*{w:.4f}:ih*{h:.4f}:iw*{x:.4f}:ih*{y:.4f}"
    # ``select='gte(scene\,0)'`` — always-true selector whose side effect computes
    # lavfi.scene_score for every frame; comma inside the expr is escaped for the chain.
    return (
        f"{crop},fps={fps:g},select='gte(scene\\,0)',metadata=print:file=-"
    )


def parse_scene_scores(text: str) -> list[tuple[float, float]]:
    """Parse ffmpeg ``metadata=print`` output → ``[(pts_time, scene_score), …]``.

    Robust to the two-line block layout (``pts_time`` then ``lavfi.scene_score``): we
    walk lines, remember the latest ``pts_time``, and attach the next scene score to it.
    Lines without a pending pts (e.g. the very first frame sometimes has no score) are
    skipped. The series is returned in emission (time) order.
    """
    out: list[tuple[float, float]] = []
    pending_t: float | None = None
    for line in text.splitlines():
        m_t = _PTS_RE.search(line)
        if m_t:
            pending_t = float(m_t.group(1))
            continue
        m_s = _SCORE_RE.search(line)
        if m_s and pending_t is not None:
            out.append((pending_t, float(m_s.group(1))))
            pending_t = None
    return out


def scores_to_intervals(
    scores: list[tuple[float, float]],
    *,
    threshold: float,
    min_duration_sec: float = 0.5,
    merge_gap_sec: float = 1.5,
    sample_fps: float = 4.0,
) -> list[dict]:
    """Threshold a ``(t, score)`` series into merged hit intervals (pure function).

    A sample is "hot" when ``score >= threshold``. Consecutive hot samples form a run;
    runs separated by a gap <= ``merge_gap_sec`` are merged (bridging brief dips). A run
    shorter than ``min_duration_sec`` is dropped (de-noise). Each interval's ``score`` is
    the PEAK sample score within it (0..1). ``end`` extends one sample-period past the
    last hot sample so a single hot frame still has a visible width.

    Returns ``[{start, end, score}, …]`` with float seconds relative to the series' time
    base (the worker offsets these to absolute recording time).
    """
    period = 1.0 / max(0.5, sample_fps)
    hot = [(t, s) for (t, s) in scores if s >= threshold]
    if not hot:
        return []
    hot.sort(key=lambda p: p[0])

    intervals: list[dict] = []
    run_start = hot[0][0]
    run_end = hot[0][0]
    run_peak = hot[0][1]
    prev_t = hot[0][0]
    for t, s in hot[1:]:
        if t - prev_t <= merge_gap_sec:
            # same (or bridged) run
            run_end = t
            run_peak = max(run_peak, s)
        else:
            intervals.append({"start": run_start, "end": run_end + period, "score": round(run_peak, 4)})
            run_start = t
            run_end = t
            run_peak = s
        prev_t = t
    intervals.append({"start": run_start, "end": run_end + period, "score": round(run_peak, 4)})

    # De-noise: drop sub-minimum-duration runs.
    return [iv for iv in intervals if (iv["end"] - iv["start"]) >= min_duration_sec]


def sensitivity_to_threshold(sensitivity: float) -> float:
    """Map operator sensitivity (0..1, higher = more sensitive) → a scene threshold.

    scene_score is small for typical motion (a person crossing a region is often a few
    percent of the crop). We map sensitivity linearly into a low band: sensitivity 1.0
    → 0.002 (very sensitive), 0.5 → ~0.02, 0.0 → 0.04 (only big changes). Documented +
    tunable on real footage (``# LIVE-VALIDATE``).
    """
    s = _clamp01(sensitivity)
    # threshold = 0.04 - s*0.038  → [0.002 .. 0.04]
    return round(0.04 - s * 0.038, 5)


async def analyze_segment(
    segment_path: str,
    region: dict,
    *,
    sample_fps: float,
) -> list[tuple[float, float]]:
    """Run the motion filter over ONE segment/region → ``[(pts_time, score), …]``.

    ``pts_time`` is relative to the SEGMENT start (the caller offsets it to absolute
    recording time). Raises ``MotionFfmpegError`` on a missing binary / non-zero exit /
    a timeout — the worker catches it, notes the skipped segment, and continues.
    """
    if not segment_path:
        raise MotionFfmpegError("no segment path")

    vf = build_motion_filter(region, sample_fps)
    args = [
        "ffmpeg", "-hide_banner", "-nostats", "-loglevel", "info",
        "-i", segment_path, "-an",
        "-vf", vf,
        "-f", "null", "-",
    ]

    try:
        proc = await asyncio.create_subprocess_exec(
            *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except (FileNotFoundError, OSError) as exc:
        raise MotionFfmpegError(f"ffmpeg not available: {exc}") from exc

    try:
        # ``metadata=print:file=-`` writes to STDOUT; ffmpeg logs go to stderr.
        stdout, stderr = await asyncio.wait_for(
            proc.communicate(), timeout=_FFMPEG_TIMEOUT_SEC
        )
    except asyncio.TimeoutError as exc:
        try:
            proc.kill()
        except ProcessLookupError:
            pass
        raise MotionFfmpegError("ffmpeg motion analysis timed out") from exc

    if proc.returncode != 0:
        detail = (stderr or b"").decode("utf-8", "replace")[-500:]
        log.info(
            "ffmpeg motion analysis failed (%s): %s",
            " ".join(shlex.quote(a) for a in args), detail,
        )
        raise MotionFfmpegError(f"ffmpeg exited {proc.returncode}: {detail}")

    # metadata=print:file=- goes to stdout; be lenient and scan both streams.
    text = (stdout or b"").decode("utf-8", "replace")
    if "lavfi.scene_score" not in text:
        text += "\n" + (stderr or b"").decode("utf-8", "replace")
    return parse_scene_scores(text)


def _clamp01(v) -> float:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return 0.0
    if f < 0.0:
        return 0.0
    if f > 1.0:
        return 1.0
    return f


def ffmpeg_available() -> bool:
    """Best-effort check that the ffmpeg binary is on PATH (for a health/debug read)."""
    from shutil import which

    return which("ffmpeg") is not None
