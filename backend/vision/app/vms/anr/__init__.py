"""ANR (Automatic Network Replenishment) domain (P6-A) — edge-recording backfill.

When a continuously-recording camera comes back after an outage, its edge SD-card /
onboard NVR usually still holds the footage the Go ``nvr`` missed while the stream
was down. The Go ``nvr`` DETECTS the gap (from the ``recording_segments`` ledger),
opens an ``ANRJob``, and publishes ``tenant.<id>.vms.anr.request`` on the NATS spine.

This domain is the FULFILLER half (it lives in vision because vision owns the device
credentials + the brand drivers — the Go ``nvr`` has neither). The
``AnrConsumer`` (started in ``app.main`` lifespan, like the recording consumer):

  1. loads the camera (tenant-scoped from the event) + resolves the footage SOURCE —
     an NVR channel (→ the NVR's driver over the NVR host) or an edge/Profile-G camera
     (→ the camera's own driver);
  2. reuses the P4-B driver footage search (``search_recordings`` +
     ``get_playback_uri``) over the gap window to get the replay RTSP URI;
  3. ffmpeg-pulls that replay stream into an fmp4 segment on the SHARED ``recordings``
     volume under ``cameras/<tenant>/<camera>/<profile>/<gap-start>.mp4`` — the exact
     layout the Go ``nvr`` segment tracker (P3-A) watches, so the pulled segment is
     picked up + emitted as ``recording.segment`` → persisted as a ``Recording`` row
     by the ``RecordingConsumer`` (no double-write here);
  4. publishes ``tenant.<id>.vms.anr.result`` ``{job_id, status, backfilled_segments,
     error?}`` — the Go ``nvr`` result-consumer closes the ``ANRJob``.

Graceful + idempotent by construction: an unreachable edge/NVR, no on-device footage,
or an ffmpeg failure → ``result{status:failed, error}`` (never crashes the consumer);
a duplicate ``anr.request`` for a ``job_id`` already being fulfilled is a no-op.
"""

from __future__ import annotations

from .consumer import AnrConsumer
from .service import AnrFulfiller

__all__ = ["AnrConsumer", "AnrFulfiller"]
