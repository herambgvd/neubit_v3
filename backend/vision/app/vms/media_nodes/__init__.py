"""VMS media-node domain — recorder-machine registry + heartbeat (MN-1a).

Self-contained domain package (``schemas`` + ``service`` + ``router``), mirroring
``nvr`` / ``health``:

  * ``MediaNodeService`` — tenant-scoped CRUD over ``media_nodes``. Register onboards an
    INDEPENDENT recorder machine (its Go ``nvr`` ``api_url`` + MediaMTX media bases);
    delete is BLOCKED while cameras still reference the node (``Camera.media_node_id``).
  * ``NodeHeartbeatMonitor`` — estate-wide background loop (all tenants) that pings each
    node's ``<api_url>/api/v1/nvr/status`` and refreshes ``status`` + ``last_heartbeat``
    (+ ``used_channels`` when the node self-reports a channel count). Started in
    ``app.main`` lifespan; graceful-on-unreachable (a down node → ``offline``, never an
    exception). ``draining`` nodes are left as the operator set them.
  * ``router`` — ``/vms/media-nodes`` CRUD, gated ``vms.config.manage``.

This is the REGISTRY only — per-node stream/record/playback ROUTING is a later task.
"""

from __future__ import annotations

from .router import router
from .service import MediaNodeService, NodeHeartbeatMonitor

__all__ = ["router", "MediaNodeService", "NodeHeartbeatMonitor"]
