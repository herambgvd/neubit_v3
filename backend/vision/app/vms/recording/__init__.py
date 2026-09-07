"""VMS recording domain — the cross-recorder READ MODEL, and nothing else.

The recorder owns recording. It holds the policy (mode, schedule, retention), it
reconciles that policy every tick, and it writes the segments. What no single
recorder can do is answer "show me this camera's footage across the estate", so this
is what remains here:

  * ``RecordingConsumer`` — subscribes to the Go ``nvr``'s
    ``tenant.<id>.vms.recording.segment`` events → persists ``Recording`` rows.
  * ``router`` — browse those rows.

What used to be here and is gone: a recording CONFIG surface, manual start/stop, and
a ``RecordingScheduler`` that evaluated the same weekly windows the recorder's own
reconciler evaluates — two schedulers starting and stopping one recording. Config and
control now go to the recorder that owns the camera (``/vms/federation/…``).
"""

from __future__ import annotations

from .consumer import RecordingConsumer
from .router import router

__all__ = ["router", "RecordingConsumer"]
