"""VMS event-linkage domain (P5-B) — action rules + the NATS linkage consumer.

  * ``models`` (in ``app.vms.models.linkage``) — LinkageRule + LinkageFire.
  * ``service`` — LinkageRuleService (tenant-scoped CRUD) + LinkageEngine (match →
    scope → schedule → cooldown → execute actions → audit).
  * ``actions`` — the individual action executors (start_recording / notify / ptz_preset
    / trigger_output / popup), each graceful (a failure logs + continues).
  * ``consumer`` — LinkageConsumer: subscribes to ``tenant.*.vms.>`` (camera events) AND
    ``tenant.*.access.>`` (access door events) and drives the engine. Wired in
    ``app.main`` lifespan.
  * ``door_camera`` — door→camera resolution for access↔video verification.

The engine reuses the events bus (``app.vms.common.events``), the nvr client
(``app.vms.common.nvr_client``) via the recording service, and the driver seam
(through the owning recorder, ``app.vms.federation``) — no new infra.
"""

from __future__ import annotations

from .consumer import LinkageConsumer
from .service import LinkageEngine, LinkageRuleService

__all__ = ["LinkageConsumer", "LinkageEngine", "LinkageRuleService"]
