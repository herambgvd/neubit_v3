"""VMS camera device-event ingestion domain (P5-A).

Turns per-camera device notifications (ONVIF PullPoint / brand alarm streams) into
normalized, deduped, persisted ``VmsEvent`` rows and publishes them on the NATS spine
(``tenant.<id>.vms.camera.<event_type>``) — the exact subject family the workflow
correlation engine consumes (``tenant.*.vms.>``) to raise SOP incidents. No AI:
device-level events only (motion / tamper / video-loss / IO / line / zone / audio) +
system events (camera online/offline, recording-error, storage-low).

Pieces:
  * ``normalize``  — driver event_type → the normalized VmsEvent event_type + the
    dedup-key + envelope builders (pure; unit-tested).
  * ``service``    — ``VmsEventService`` (persist+publish an event; the events feed +
    per-camera list + ack), tenant-scoped.
  * ``supervisor`` — ``EventSupervisor`` (lifespan task): re-scans event-enabled
    cameras on a tick, opens/reaps per-camera subscriptions (bounded concurrency,
    reconnect/backoff, graceful), and drives each event through normalize→persist→publish.
  * ``router``     — the events REST surface (list / per-camera list / ack).

The service's ``ingest_device_event`` is the single normalize→dedupe→persist→publish
entry point — the supervisor calls it per subscription callback, the health sampler /
P3 workers call ``ingest_system_event`` for system events, and the tests drive it with
fabricated notifications (no real ONVIF device needed for the pipeline).
"""

from __future__ import annotations

from .router import router
from .supervisor import EventSupervisor

__all__ = ["router", "EventSupervisor"]
