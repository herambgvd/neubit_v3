"""Controller-connector abstraction — the v3 improvement over v2's hardcoded DDS.

v2's access-control module (``neubit_v2/backend/gates``) talked to the DDS
controller directly: ``app.adapter.dds`` (OData REST) + ``app.adapter.signalr``
(the EventsHub) were imported straight into the reconciler, routes, and ingestion
worker. There was no seam — adding a second brand (ESSL, etc.) would have meant
forking every call site.

v3 introduces a brand-agnostic seam: every controller integration implements
``ControllerConnector``. The service layer (instance CRUD, reconcile, mirror
listing, event ingestion) depends ONLY on this interface; ``factory.get_connector``
picks the concrete class by ``instance.brand``. Only DDS is implemented for now;
new brands drop in without touching the service.

The interface is intentionally the SUBSET the foundation phase needs:

* ``test_connection`` — probe reachability/auth (used by POST .../test-connection).
* ``list_<collection>`` (via ``list_collection``) — pull an entity set for the
  reconciler → AccessMirror upsert. The concrete connector maps a logical
  collection name (``cardholders`` / ``cards`` / ``access_groups`` / ``schedules``
  / ``scheduled_mags`` / ``scheduled_readers``) to its own remote entity set.
* ``subscribe_events`` — open the real-time event stream (DDS SignalR) and invoke
  the async callback per event; runs until cancelled, reconnecting internally.
* ``invoke_action`` — OData-action / command passthrough (door unlock, zone
  arm/disarm, …). Defined here so the seam is complete, but NOT wired to any
  endpoint in this phase (commands are a LATER phase).
* ``list_hardware`` — read-only hardware-set proxy (controllers/readers/…). Also
  part of the seam; NOT wired to an endpoint this phase (hardware proxy = later).

All methods are async. Connectors degrade GRACEFULLY: ``test_connection`` returns
an error result instead of raising, and the reconcile path catches per-collection
fetch failures. ``subscribe_events`` reconnects with backoff and only raises if it
gives up permanently, so the listener supervisor can restart it.
"""

from __future__ import annotations

import abc
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

# The logical mirror collections the reconciler syncs. Each concrete connector
# maps these to its own remote entity-set names (DDS → API_Cardholders, …).
# NOTE: access_groups + schedules are NOT reconciled from the controller — in v2
# they are LOCAL, instance-scoped catalogs (see app/access/catalog.py), not DDS
# mirror entities. They are intentionally excluded here so reconcile never creates
# mirror rows for them (which would shadow the local catalog).
MIRROR_COLLECTIONS: tuple[str, ...] = (
    "cardholders",
    "cards",
    "scheduled_mags",
    "scheduled_readers",
)


@dataclass(frozen=True)
class ConnectionResult:
    """Outcome of ``test_connection`` — never an exception, always a value."""

    ok: bool
    detail: dict[str, Any] = field(default_factory=dict)
    error: str | None = None


@dataclass(frozen=True)
class ControllerEvent:
    """One real-time event surfaced by ``subscribe_events``.

    Brand-neutral shape the ingestion layer persists + publishes:
      * ``category`` — access | alarm | comm | technical | audit | general | io | health
      * ``event_type`` — the controller's event type string (best-effort)
      * ``remote_uid`` — the controller-side entity UID, if present
      * ``occurred_at`` — ISO-8601 timestamp string (best-effort; None → now)
      * ``result`` — normalized access result (granted/denied/…) when derivable
      * ``door_ref`` / ``cardholder_ref`` — controller-side refs when present
      * ``raw`` — the verbatim controller payload (persisted for audit/replay)
    """

    category: str
    event_type: str
    raw: dict[str, Any]
    remote_uid: str | None = None
    occurred_at: str | None = None
    result: str | None = None
    door_ref: str | None = None
    cardholder_ref: str | None = None


# The async callback the connector invokes for each real-time event.
EventCallback = Callable[[ControllerEvent], Awaitable[None]]


class ControllerConnector(abc.ABC):
    """Brand-agnostic access-controller interface. One instance per registered
    controller; constructed by ``factory.get_connector(instance, secret)``."""

    #: The brand key this connector serves (e.g. "dds"). Set by subclasses.
    brand: str = "generic"

    # ── reachability ────────────────────────────────────────────────────
    @abc.abstractmethod
    async def test_connection(self) -> ConnectionResult:
        """Probe the controller (reachability + auth). MUST NOT raise — return a
        ``ConnectionResult(ok=False, error=...)`` on any failure."""

    # ── entity mirroring (reconcile) ────────────────────────────────────
    @abc.abstractmethod
    async def list_collection(self, collection: str) -> list[dict[str, Any]]:
        """Fetch every remote entity for a logical ``collection`` (one of
        ``MIRROR_COLLECTIONS``). Returns raw DTO dicts (each with an id under the
        connector's uid key). Raises on transport/HTTP failure — the reconciler
        catches per-collection so one bad set doesn't abort the whole run."""

    def uid_of(self, dto: dict[str, Any]) -> str | None:
        """Extract the remote UID from a DTO (brand-specific key). Default: 'UID'."""
        return dto.get("UID") or dto.get("uid") or dto.get("id")

    # ── real-time events ────────────────────────────────────────────────
    @abc.abstractmethod
    async def subscribe_events(self, callback: EventCallback) -> None:
        """Open the controller's real-time event stream and invoke ``callback``
        for each event. Runs until cancelled; reconnects internally with backoff.
        Raises only if the connection is permanently lost (supervisor restarts)."""

    async def stop_events(self) -> None:
        """Ask an active ``subscribe_events`` loop to stop (best-effort)."""
        return None

    # ── write-through entity CRUD (Phase 2) ─────────────────────────────
    async def get_entity(self, collection: str, remote_uid: str) -> dict[str, Any]:
        """Fetch one remote entity by UID from a logical mirror ``collection``.

        Raises on transport/HTTP failure (callers translate to a clean HTTP
        error). Present so write-through CRUD can re-read after a mutation.
        """
        raise NotImplementedError(f"{self.brand}: get_entity not implemented")

    async def create_entity(
        self, collection: str, body: dict[str, Any]
    ) -> dict[str, Any]:
        """Create a remote entity in a logical mirror ``collection`` and return
        the created DTO (source-of-truth for the local mirror upsert)."""
        raise NotImplementedError(f"{self.brand}: create_entity not implemented")

    async def update_entity(
        self, collection: str, remote_uid: str, body: dict[str, Any]
    ) -> dict[str, Any]:
        """Patch a remote entity by UID and return the resulting DTO."""
        raise NotImplementedError(f"{self.brand}: update_entity not implemented")

    async def delete_entity(self, collection: str, remote_uid: str) -> None:
        """Delete a remote entity by UID."""
        raise NotImplementedError(f"{self.brand}: delete_entity not implemented")

    # ── actions / commands (Phase 2) ────────────────────────────────────
    async def invoke_action(
        self, action: str, params: dict[str, Any] | None = None
    ) -> dict[str, Any] | None:
        """Invoke a controller command/OData-action (door unlock, zone arm, …)."""
        raise NotImplementedError(f"{self.brand}: invoke_action not implemented")

    # ── hardware listing (Phase 2) ──────────────────────────────────────
    async def list_hardware(self, hardware_set: str) -> list[dict[str, Any]]:
        """Read-only proxy of a hardware entity set (controllers/readers/…)."""
        raise NotImplementedError(f"{self.brand}: list_hardware not implemented")

    async def aclose(self) -> None:
        """Release any held resources (HTTP client, hub). Best-effort."""
        return None
