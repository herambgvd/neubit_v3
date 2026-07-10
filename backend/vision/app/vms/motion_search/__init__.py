"""Forensic (non-AI) motion-search domain (G4) — ffmpeg VMD over recorded segments.

Self-contained domain package (``schemas`` + ``service`` + ``router`` + ``ffmpeg``) plus
the lifespan background ``MotionSearchWorker`` that does the ffmpeg motion analysis.
Mirrors the export domain's async-job layout:

  * ``POST /vms/cameras/{id}/motion-search {from, to, regions[], sensitivity?}``
    (gate ``vms.playback.view``) → resolve the covered ``Recording`` fmp4 segments →
    create a QUEUED ``MotionSearchJob`` → ``{job_id, status}``.
  * ``GET  /vms/motion-search/{job_id}`` → the job status/result (hit intervals when done).

The worker (``MotionSearchWorker``, started in ``app.main`` lifespan like the export +
retention workers) picks queued jobs, crops each drawn region + runs the ffmpeg
scene/motion filter over the covering segments, thresholds the scores into hit intervals,
and stores them. Bounded concurrency; graceful on missing segments / ffmpeg error →
partial hits + a note (only a fully-unanalyzable job fails).

This is NOT AI — pure ffmpeg Video Motion Detection (VMD), Milestone "Smart Search" style.
Region rects are NORMALIZED 0..1 of the frame (resolution-independent).
"""

from __future__ import annotations

from .router import router
from .worker import MotionSearchWorker

__all__ = ["router", "MotionSearchWorker"]
