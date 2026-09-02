"""Clip-export domain (P4-B) — concat recorded fmp4 segments → downloadable mp4.

Self-contained domain package (``schemas`` + ``service`` + ``router``) plus the
lifespan background ``ExportWorker`` that does the ffmpeg concat/remux. Mirrors the
recording/playback domains' layout:

  * ``POST /vms/cameras/{id}/export {from, to, format?=mp4}`` (gate ``vms.export``) →
    resolve the covered ``Recording`` fmp4 segments → create a QUEUED ``ExportJob`` →
    ``{job_id, status}``.
  * ``GET  /vms/export/{job_id}``          → the job status/result.
  * ``GET  /vms/export/{job_id}/download`` → stream the produced mp4 (gate + tenant).

The worker (``ExportWorker``, started in ``app.main`` lifespan like the retention +
recording workers) picks queued jobs, ffmpeg-concats (``-c copy`` fast path; trims
head/tail to the exact window) the covered segments into the downloads area, and sets
status + file_size. Bounded concurrency; graceful on missing segments / ffmpeg error →
``status=failed``.
"""

from __future__ import annotations

from .router import router
from .worker import ExportWorker

__all__ = ["router", "ExportWorker"]
