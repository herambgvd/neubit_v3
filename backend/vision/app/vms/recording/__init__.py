"""VMS recording domain — the segment MIRROR, and nothing else.

The recorder owns recording. It holds the policy (mode, schedule, retention), it
reconciles that policy every tick, it writes the segments and it keeps the disk.
What is left here is the one thing that is not about storage:

  * ``RecordingConsumer`` — subscribes to the Go ``nvr``'s
    ``tenant.<id>.vms.recording.segment`` events → persists ``Recording`` rows,
    so a clip the linkage engine asked for can be pointed at once it lands.

WHAT IS GONE, AND WHY IT IS NOT COMING BACK. First a recording CONFIG surface,
manual start/stop and a scheduler that evaluated the same weekly windows the
recorder's own reconciler does — two schedulers starting and stopping one
recording. Then the BROWSE router (``/vms/cameras/{id}/recordings``,
``/vms/recordings/{id}``) and the whole playback package with it: both answered
about footage in this service's own storage, and this service has none. The
console asks the recorder that wrote the frames
(``/vms/federation/nodes/{id}/cameras/{id}/…``); a second answer from an empty
table is how two timelines end up disagreeing about the same camera.
"""

from __future__ import annotations

from .consumer import RecordingConsumer

__all__ = ["RecordingConsumer"]
