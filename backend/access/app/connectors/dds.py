"""DDS connector — OData v4 REST + SignalR EventsHub, faithful to neubit_v2.

Ported from neubit_v2's ``backend/gates/app/adapter/dds.py`` (OData client) and
``backend/gates/app/adapter/signalr.py`` + ``ingestion/signalr_handlers.py``
(SignalR EventsHub + event normalization). All the load-bearing shapes are kept
VERBATIM from v2:

OData (v2 ``dds.py``):
    base:     GET/POST/PATCH/DELETE  {base_url}/odata/{EntitySet}
    by-id:    {base_url}/odata/{EntitySet}({uid})
    list:     ?$top=&$skip=  — vendor caps $top at 50 (DDS_ODATA_TOP_CAP)
    body:     the collection lives under the ``value`` key of the response
    action:   POST {base_url}/odata/{EntitySet}/{Action}
    entity sets (v2 ``reconciler.ENTITY_TYPES`` + ``hardware`` + ``commands``):
        API_Cardholders, API_Cards, API_AccessGroups, API_WeeklyPrograms,
        API_ScheduledMAGs, API_ScheduledAdditionalReaders,
        API_Sites, API_Controllers, API_Readers, API_Inputs, API_Outputs,
        API_AlarmZones, API_Areas
    auth (v2 ``dds._auth`` / ``_headers``):
        basic → HTTP Basic (username:secret) ; jwt → Bearer {secret}

SignalR (v2 ``signalr.py`` / ``signalr_handlers.py``):
    hub:      {base_url}/Hub/EventsHub   (signalrcore HubConnectionBuilder)
    auth:     HTTP Basic header (base64 username:api_key) — DDS recommends Basic
              for long-lived connections (their JWTs are short-lived)
    methods:  AccessEventArrived, AlarmEventArrived, CommEventArrived,
              TechnicalEventArrived, AuditEventArrived, GeneralEventArrived,
              IOEventArrived, StatusUpdate      (8, verbatim)
    category: HUB_TO_CATEGORY maps each method → access/alarm/comm/technical/
              audit/general/io/health
    fields:   DateTime|dateTime|JournalUpdateDateTime, Type|type, UID|uid

The DDS-side action names ported from v2 ``commands/routes.py`` (kept as
constants for the LATER commands phase):
    Outputs: Activate, ActivateContinuously, Deactivate, ReturnToNormal,
             OpenAllDoorRelays, ReturnToNormalAllDoorRelays
    AlarmZones: ArmAlarmZone, DisarmAlarmZone, ReturnAlarmZoneToWeeklyProgram
    Controllers: InitializeController ; Sites: StartAllPolling, StopAllPolling
"""

from __future__ import annotations

import asyncio
import base64
import logging
from typing import Any

import httpx

from .base import (
    ConnectionResult,
    ControllerConnector,
    ControllerEvent,
    EventCallback,
)

log = logging.getLogger("access.connectors.dds")

DEFAULT_TIMEOUT = 10
DDS_ODATA_TOP_CAP = 50  # vendor caps $top at 50 per request (v2 verbatim)
MAX_ROWS = 20000        # reconcile safety ceiling (v2 verbatim)

# Logical collection → DDS OData entity set (v2 reconciler.ENTITY_TYPES).
COLLECTION_ENTITY_SETS: dict[str, str] = {
    "cardholders": "API_Cardholders",
    "cards": "API_Cards",
    "access_groups": "API_AccessGroups",
    "schedules": "API_WeeklyPrograms",
    "scheduled_mags": "API_ScheduledMAGs",
    "scheduled_readers": "API_ScheduledAdditionalReaders",
}

# Read-only hardware entity sets (v2 hardware/routes.py) — seam for later phase.
HARDWARE_ENTITY_SETS: dict[str, str] = {
    "sites": "API_Sites",
    "controllers": "API_Controllers",
    "readers": "API_Readers",
    "inputs": "API_Inputs",
    "outputs": "API_Outputs",
    "alarm_zones": "API_AlarmZones",
    "areas": "API_Areas",
}

# DDS OData actions (v2 commands/routes.py) — seam for later commands phase.
DDS_ACTIONS: dict[str, tuple[str, str]] = {
    "output.activate": ("API_Outputs", "Activate"),
    "output.activate_continuous": ("API_Outputs", "ActivateContinuously"),
    "output.deactivate": ("API_Outputs", "Deactivate"),
    "output.return_to_normal": ("API_Outputs", "ReturnToNormal"),
    "output.open_all_doors": ("API_Outputs", "OpenAllDoorRelays"),
    "output.return_to_normal_all": ("API_Outputs", "ReturnToNormalAllDoorRelays"),
    "alarm_zone.arm": ("API_AlarmZones", "ArmAlarmZone"),
    "alarm_zone.disarm": ("API_AlarmZones", "DisarmAlarmZone"),
    "alarm_zone.return_to_schedule": ("API_AlarmZones", "ReturnAlarmZoneToWeeklyProgram"),
    "controller.initialize": ("API_Controllers", "InitializeController"),
    "site.start_polling": ("API_Sites", "StartAllPolling"),
    "site.stop_polling": ("API_Sites", "StopAllPolling"),
}

# SignalR hub methods → event category (v2 signalr_handlers.HUB_TO_CATEGORY).
HUB_METHODS: tuple[str, ...] = (
    "AccessEventArrived",
    "AlarmEventArrived",
    "CommEventArrived",
    "TechnicalEventArrived",
    "AuditEventArrived",
    "GeneralEventArrived",
    "IOEventArrived",
    "StatusUpdate",
)

HUB_TO_CATEGORY: dict[str, str] = {
    "AccessEventArrived": "access",
    "AlarmEventArrived": "alarm",
    "CommEventArrived": "comm",
    "TechnicalEventArrived": "technical",
    "GeneralEventArrived": "general",
    "AuditEventArrived": "audit",
    "IOEventArrived": "io",
    "StatusUpdate": "health",
}


class DDSHTTPError(Exception):
    """Raised when DDS OData returns >= 400 (v2 verbatim)."""

    def __init__(self, status_code: int, body_text: str) -> None:
        self.status_code = status_code
        self.body_text = body_text
        super().__init__(f"DDS HTTP {status_code}: {body_text[:200]}")


class DDSConnector(ControllerConnector):
    """Concrete connector for a DDS controller instance.

    Constructed with the instance's connection params + the DECRYPTED secret
    (the service decrypts before building the connector — the connector never
    touches the DB or the encryption key).
    """

    brand = "dds"

    def __init__(
        self,
        *,
        base_url: str,
        auth_type: str,
        username: str,
        secret: str,
        verify_tls: bool = False,
        reconnect_max_seconds: int = 300,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.auth_type = auth_type or "basic"
        self.username = username or ""
        self._secret = secret or ""
        self.verify_tls = verify_tls
        self.reconnect_max_seconds = reconnect_max_seconds
        self._hub: Any = None
        self._stop = asyncio.Event()

    # ── HTTP plumbing (v2 dds._client / _auth / _headers) ────────────────
    def _client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(verify=self.verify_tls, timeout=DEFAULT_TIMEOUT)

    def _auth(self) -> httpx.BasicAuth | None:
        if self.auth_type == "basic":
            return httpx.BasicAuth(self.username, self._secret)
        return None

    def _headers(self) -> dict[str, str]:
        if self.auth_type == "jwt":
            return {"Authorization": f"Bearer {self._secret}"}
        return {}

    # ── OData primitives (v2 dds.odata_*) ────────────────────────────────
    async def _odata_get(self, entity_set: str, *, params: dict | None = None) -> dict:
        try:
            async with self._client() as c:
                r = await c.get(
                    f"{self.base_url}/odata/{entity_set}",
                    params=params,
                    auth=self._auth(),
                    headers=self._headers(),
                )
                if r.status_code >= 400:
                    raise DDSHTTPError(r.status_code, r.text)
                return r.json()
        except DDSHTTPError:
            raise
        except Exception as exc:
            raise DDSHTTPError(502, f"DDS request failed: {exc}") from None

    async def _odata_list(
        self, entity_set: str, *, top: int | None = None, skip: int = 0
    ) -> list[dict]:
        """Paginated GET, chunking $top around the 50-row cap (v2 odata_list)."""
        collected: list[dict] = []
        cursor_skip = skip
        remaining = top
        pages = 0
        while True:
            if remaining is not None:
                if remaining <= 0:
                    break
                page_size = min(DDS_ODATA_TOP_CAP, remaining)
            else:
                if pages >= 1000:
                    log.warning("odata_list %s hit safety ceiling", entity_set)
                    break
                page_size = DDS_ODATA_TOP_CAP

            body = await self._odata_get(
                entity_set, params={"$top": page_size, "$skip": cursor_skip}
            )
            page = body.get("value")
            if not isinstance(page, list) or not page:
                break
            collected.extend(page)
            cursor_skip += len(page)
            if remaining is not None:
                remaining -= len(page)
            pages += 1
            if len(page) < page_size:
                break
        return collected

    async def _odata_get_one(self, entity_set: str, uid: str) -> dict:
        """GET a single entity by key: {base}/odata/{Set}({uid}) (v2 odata_get_one)."""
        try:
            async with self._client() as c:
                r = await c.get(
                    f"{self.base_url}/odata/{entity_set}({uid})",
                    auth=self._auth(),
                    headers=self._headers(),
                )
                if r.status_code >= 400:
                    raise DDSHTTPError(r.status_code, r.text)
                return r.json()
        except DDSHTTPError:
            raise
        except Exception as exc:
            raise DDSHTTPError(502, f"DDS request failed: {exc}") from None

    async def _odata_post(self, entity_set: str, body: dict) -> dict:
        """POST create: {base}/odata/{Set} (v2 odata_post)."""
        try:
            async with self._client() as c:
                r = await c.post(
                    f"{self.base_url}/odata/{entity_set}",
                    json=body,
                    auth=self._auth(),
                    headers=self._headers(),
                )
                if r.status_code >= 400:
                    raise DDSHTTPError(r.status_code, r.text)
                return r.json()
        except DDSHTTPError:
            raise
        except Exception as exc:
            raise DDSHTTPError(502, f"DDS request failed: {exc}") from None

    async def _odata_patch(self, entity_set: str, uid: str, body: dict) -> dict:
        """PATCH by key: {base}/odata/{Set}({uid}) (v2 odata_patch)."""
        try:
            async with self._client() as c:
                r = await c.patch(
                    f"{self.base_url}/odata/{entity_set}({uid})",
                    json=body,
                    auth=self._auth(),
                    headers=self._headers(),
                )
                if r.status_code == 204 or not r.content:
                    return {}
                if r.status_code >= 400:
                    raise DDSHTTPError(r.status_code, r.text)
                return r.json()
        except DDSHTTPError:
            raise
        except Exception as exc:
            raise DDSHTTPError(502, f"DDS request failed: {exc}") from None

    async def _odata_delete(self, entity_set: str, uid: str) -> None:
        """DELETE by key: {base}/odata/{Set}({uid}) (v2 odata_delete)."""
        try:
            async with self._client() as c:
                r = await c.delete(
                    f"{self.base_url}/odata/{entity_set}({uid})",
                    auth=self._auth(),
                    headers=self._headers(),
                )
                if r.status_code == 204:
                    return
                if r.status_code >= 400:
                    raise DDSHTTPError(r.status_code, r.text)
        except DDSHTTPError:
            raise
        except Exception as exc:
            raise DDSHTTPError(502, f"DDS request failed: {exc}") from None

    async def _odata_action(
        self, entity_set: str, action: str, body: dict | None = None
    ) -> dict | None:
        try:
            async with self._client() as c:
                r = await c.post(
                    f"{self.base_url}/odata/{entity_set}/{action}",
                    json=body or {},
                    auth=self._auth(),
                    headers=self._headers(),
                )
                if r.status_code >= 400:
                    raise DDSHTTPError(r.status_code, r.text)
                if r.status_code == 204 or not r.content:
                    return None
                return r.json()
        except DDSHTTPError:
            raise
        except Exception as exc:
            raise DDSHTTPError(502, f"DDS request failed: {exc}") from None

    # ── ControllerConnector interface ────────────────────────────────────
    def uid_of(self, dto: dict[str, Any]) -> str | None:
        return dto.get("UID") or dto.get("uid")

    async def test_connection(self) -> ConnectionResult:
        """Probe DDS. Tries a cheap OData read (top=1 cardholders) which also
        exercises auth. Never raises — returns ok/error (v2 probe semantics)."""
        try:
            async with self._client() as c:
                r = await c.get(
                    f"{self.base_url}/odata/API_Cardholders",
                    params={"$top": 1},
                    auth=self._auth(),
                    headers=self._headers(),
                )
            if r.status_code < 400:
                return ConnectionResult(
                    ok=True, detail={"status_code": r.status_code, "odata": True}
                )
            return ConnectionResult(
                ok=False,
                error=f"HTTP {r.status_code}",
                detail={"status_code": r.status_code, "body": r.text[:200]},
            )
        except Exception as exc:
            # Some httpx transport errors stringify to "" — surface the type so the
            # operator always gets an actionable message (e.g. ConnectTimeout).
            msg = str(exc) or exc.__class__.__name__
            return ConnectionResult(ok=False, error=msg, detail={"error_type": type(exc).__name__})

    async def list_collection(self, collection: str) -> list[dict[str, Any]]:
        entity_set = COLLECTION_ENTITY_SETS.get(collection)
        if entity_set is None:
            raise ValueError(f"unknown DDS collection: {collection}")
        return await self._odata_list(entity_set, top=MAX_ROWS)

    # ── write-through entity CRUD (v2 dds.odata_post/patch/delete/get_one) ──
    def _entity_set(self, collection: str) -> str:
        entity_set = COLLECTION_ENTITY_SETS.get(collection)
        if entity_set is None:
            raise ValueError(f"unknown DDS collection: {collection}")
        return entity_set

    async def get_entity(self, collection: str, remote_uid: str) -> dict[str, Any]:
        return await self._odata_get_one(self._entity_set(collection), remote_uid)

    async def create_entity(
        self, collection: str, body: dict[str, Any]
    ) -> dict[str, Any]:
        return await self._odata_post(self._entity_set(collection), body)

    async def update_entity(
        self, collection: str, remote_uid: str, body: dict[str, Any]
    ) -> dict[str, Any]:
        entity_set = self._entity_set(collection)
        await self._odata_patch(entity_set, remote_uid, body)
        # DDS PATCH may 204 with no body; re-read for the canonical DTO (v2 flow).
        return await self._odata_get_one(entity_set, remote_uid)

    async def delete_entity(self, collection: str, remote_uid: str) -> None:
        await self._odata_delete(self._entity_set(collection), remote_uid)

    # Direct-set variants for cross-collection writes (e.g. card↔cardholder
    # assignment writes to API_Cards while operating from the cardholder route).
    async def get_entity_set(self, entity_set: str, remote_uid: str) -> dict[str, Any]:
        return await self._odata_get_one(entity_set, remote_uid)

    async def patch_entity_set(
        self, entity_set: str, remote_uid: str, body: dict[str, Any]
    ) -> dict[str, Any]:
        await self._odata_patch(entity_set, remote_uid, body)
        return await self._odata_get_one(entity_set, remote_uid)

    async def list_hardware(self, hardware_set: str) -> list[dict[str, Any]]:
        entity_set = HARDWARE_ENTITY_SETS.get(hardware_set)
        if entity_set is None:
            raise ValueError(f"unknown DDS hardware set: {hardware_set}")
        return await self._odata_list(entity_set, top=MAX_ROWS)

    async def invoke_action(
        self, action: str, params: dict[str, Any] | None = None
    ) -> dict[str, Any] | None:
        mapping = DDS_ACTIONS.get(action)
        if mapping is None:
            raise ValueError(f"unknown DDS action: {action}")
        entity_set, dds_action = mapping
        return await self._odata_action(entity_set, dds_action, params)

    # ── SignalR EventsHub (v2 signalr.SignalRClient) ─────────────────────
    def _basic_header(self) -> str:
        raw = f"{self.username}:{self._secret}".encode("utf-8")
        return "Basic " + base64.b64encode(raw).decode("ascii")

    @staticmethod
    def _normalize_event(hub_method: str, payload: dict) -> ControllerEvent | None:
        """Map a raw hub payload → brand-neutral ControllerEvent (v2 handler)."""
        category = HUB_TO_CATEGORY.get(hub_method)
        if not category:
            return None
        occurred_at = (
            payload.get("DateTime")
            or payload.get("dateTime")
            or payload.get("JournalUpdateDateTime")
            or payload.get("journalUpdateDateTime")
        )
        event_type = payload.get("Type") or payload.get("type") or hub_method
        remote_uid = payload.get("UID") or payload.get("uid") or None
        door_ref = (
            payload.get("DoorUID")
            or payload.get("doorUID")
            or payload.get("ReaderUID")
            or None
        )
        cardholder_ref = (
            payload.get("CardholderUID") or payload.get("cardholderUID") or None
        )
        return ControllerEvent(
            category=category,
            event_type=str(event_type),
            raw=payload,
            remote_uid=str(remote_uid) if remote_uid else None,
            occurred_at=str(occurred_at) if occurred_at else None,
            result=None,  # normalized result mapping is a later phase (v2 kept raw)
            door_ref=str(door_ref) if door_ref else None,
            cardholder_ref=str(cardholder_ref) if cardholder_ref else None,
        )

    def _build_hub(self, loop: asyncio.AbstractEventLoop, callback: EventCallback):
        """Build a signalrcore hub bound to this instance's EventsHub (v2 _build)."""
        from signalrcore.hub_connection_builder import HubConnectionBuilder

        hub_url = f"{self.base_url}/Hub/EventsHub"
        hub = (
            HubConnectionBuilder()
            .with_url(
                hub_url,
                options={
                    "headers": {"Authorization": self._basic_header()},
                    "verify_ssl": self.verify_tls,
                },
            )
            .with_automatic_reconnect(
                {
                    "type": "raw",
                    "keep_alive_interval": 10,
                    "reconnect_interval": 5,
                    "max_attempts": 20,
                }
            )
            .build()
        )

        def _schedule(coro) -> None:
            if loop.is_running():
                asyncio.run_coroutine_threadsafe(coro, loop)

        hub.on_open(lambda: log.info("SignalR connected: %s", hub_url))
        hub.on_close(lambda: log.warning("SignalR closed: %s", hub_url))
        hub.on_error(lambda data: log.error("SignalR error: %s", data))

        for method in HUB_METHODS:
            def make_handler(m: str):
                def _inner(args):
                    payload = args[0] if args else {}
                    if not isinstance(payload, dict):
                        payload = {"value": payload}
                    ev = self._normalize_event(m, payload)
                    if ev is not None:
                        _schedule(callback(ev))
                return _inner
            hub.on(method, make_handler(method))
        return hub

    async def subscribe_events(self, callback: EventCallback) -> None:
        """Connect the EventsHub and fan events to ``callback`` until stopped.

        signalrcore runs its own background thread; handlers are bounced to this
        asyncio loop. Reconnect/backoff is handled here (in addition to
        signalrcore's automatic reconnect) so a dead controller never crashes the
        service — the supervisor keeps this coroutine alive.
        """
        self._stop.clear()
        loop = asyncio.get_running_loop()
        backoff = 1
        while not self._stop.is_set():
            try:
                self._hub = self._build_hub(loop, callback)
                # signalrcore's start() is a BLOCKING call (opens the socket on the
                # calling thread). Run it in the default executor so it never stalls
                # the asyncio event loop (which would block the whole service).
                await loop.run_in_executor(None, self._hub.start)
                backoff = 1
                # Hold the coroutine open; signalrcore threads deliver events.
                while not self._stop.is_set():
                    await asyncio.sleep(1)
                break
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 — never crash the supervisor
                log.warning(
                    "SignalR connect failed for %s: %s; retry in %ss",
                    self.base_url, exc, backoff,
                )
                try:
                    await asyncio.wait_for(self._stop.wait(), timeout=backoff)
                except asyncio.TimeoutError:
                    pass
                backoff = min(backoff * 2, self.reconnect_max_seconds)
        # Clean teardown on stop.
        await self.stop_events()

    async def stop_events(self) -> None:
        self._stop.set()
        hub = self._hub
        self._hub = None
        if hub is not None:
            # hub.stop() is also blocking — run off the loop if we're on one.
            try:
                loop = asyncio.get_running_loop()
                await loop.run_in_executor(None, hub.stop)
            except RuntimeError:
                try:
                    hub.stop()
                except Exception:  # noqa: BLE001
                    pass
            except Exception:  # noqa: BLE001
                pass

    async def aclose(self) -> None:
        await self.stop_events()
