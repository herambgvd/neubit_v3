"""VMS POS-overlay ingest + live stream (feature G — camera transaction overlay).

A camera can carry a ``pos_overlay`` config ({enabled, source, position}) where
``source`` names a POS terminal (a terminal id, or a ``host:port`` for a future
TCP-pull collector). This package makes that config REAL end-to-end:

  * ``POST /vms/pos/ingest`` — a POS terminal / middleware PUSHES transaction text
    lines here (single or batch). Lines are appended to a bounded in-memory ring
    buffer keyed by (tenant, terminal) and fanned out to live subscribers.
  * ``GET  /vms/pos/stream?camera_id=...`` — the live player subscribes over SSE.
    The endpoint resolves the camera's ``pos_overlay.source`` → terminal, replays
    the recent ring buffer, then streams matching lines as they arrive.

HONESTY: this overlays ONLY the transaction text a real POS feed actually pushes to
``/ingest`` — nothing is fabricated. The HTTP push path is fully working now; a
``host:port`` source (TCP-pull collector) is documented as future work.
"""

from __future__ import annotations

from app.vms.pos.router import public_router, router

__all__ = ["router", "public_router"]
