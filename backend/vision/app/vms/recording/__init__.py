"""VMS recording domain (P3-A).

Self-contained ``schemas`` + ``service`` + ``router`` (recording policy + browse),
plus two background collaborators started in ``app.main`` lifespan:

  * ``RecordingConsumer`` — subscribes to the Go ``nvr``'s
    ``tenant.<id>.vms.recording.segment`` events → persists ``Recording`` rows.
  * ``RecordingScheduler`` — evaluates ``recording_mode='schedule'`` weekly windows
    and drives the nvr start/stop as windows open/close.

Modes: continuous + schedule are built + working; motion/event are WIRED (the nvr's
event-clip entry point + trigger_type column) but FIRED by P5.
"""

from __future__ import annotations

from .consumer import RecordingConsumer
from .router import router
from .scheduler import RecordingScheduler

__all__ = ["router", "RecordingConsumer", "RecordingScheduler"]
