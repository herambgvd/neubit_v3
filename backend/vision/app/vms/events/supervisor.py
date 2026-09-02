"""Event-supervisor (P5-A) — per-camera device-event subscriptions → NATS.

The lifespan task that turns event-enabled cameras into a live NATS stream. It runs
its own DB session (NOT request-scoped) and, on a periodic re-scan (like the health
sampler discovers cameras), opens one subscription per active
``onvif_events_enabled`` camera and reaps subscriptions for cameras that were
disabled / deleted. Each subscription drives the driver's ``subscribe_events`` and
routes every mapped ``DeviceEvent`` through ``VmsEventService.ingest_device_event``
(normalize → dedupe → persist → publish ``tenant.<id>.vms.camera.<event_type>``).

Discipline (mirrors HealthSampler + the driver seam):
  * **Bounded concurrency** — a per-camera worker task; a semaphore caps how many
    subscriptions open at once during a re-scan so 200 cameras don't stampede the SDK.
  * **Reconnect / backoff** — a subscription that fails is retried by the driver's own
    reconnect loop; a worker that crashes is restarted by the next re-scan tick.
  * **Graceful** — an unreachable camera / a driver whose SDK is missing
    (``NotImplementedError`` from ``subscribe_events``) → the worker exits quietly (no
    events, no crash); a dead camera NEVER stalls the others (each worker is isolated).
  * **No-op friendly** — the synthetic testpat camera (no ONVIF) simply produces no
    events; the supervisor logs it and moves on.

Scale note (P6): at 1000ch the Go ``nvr`` connection-dense pool owns high-throughput
ingestion — but it publishes on this EXACT NATS subject/envelope, so that move is a
drop-in and this supervisor is the functionally-complete control-side path today.

Config (env, ``VE_`` prefix):
  * ``VE_EVENT_SUPERVISOR_ENABLED``      — master switch (default "1"; "0" disables).
  * ``VE_EVENT_RESCAN_INTERVAL_SEC``     — seconds between camera re-scans (default 30).
  * ``VE_EVENT_SUB_CONCURRENCY``         — max subscriptions opening at once (default 16).
"""

from __future__ import annotations

import asyncio
import logging
import os

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from kernel.auth import Scope

from app.vms.common.crypto import decrypt_secret
from app.vms.drivers import Credentials, DeviceEvent, get_driver
from app.vms.models import Camera

from .service import VmsEventService

log = logging.getLogger("vision.event_supervisor")

# A platform scope for the background writer (the supervisor authorizes off the
# camera row, not a caller — it only ever writes an event under the camera's tenant).
_PLATFORM_SCOPE = Scope(tenant_id=None, is_superadmin=True)


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, "").strip() or default)
    except (TypeError, ValueError):
        return default


def supervisor_enabled() -> bool:
    return (os.getenv("VE_EVENT_SUPERVISOR_ENABLED", "1").strip() or "1") != "0"


def rescan_interval_sec() -> int:
    return max(5, _env_int("VE_EVENT_RESCAN_INTERVAL_SEC", 30))


def sub_concurrency() -> int:
    return max(1, _env_int("VE_EVENT_SUB_CONCURRENCY", 16))


def _host_for(camera: Camera) -> str | None:
    return camera.onvif_host or (camera.network_info or {}).get("ip")


def _creds_for(camera: Camera) -> Credentials:
    """Build driver ``Credentials`` from a stored camera row (decrypting in-memory)."""
    return Credentials(
        username=camera.onvif_user or "admin",
        password=decrypt_secret(camera.onvif_enc_pass) or "",
        port=camera.onvif_port or 80,
        rtsp_port=(camera.network_info or {}).get("rtsp_port") or 554,
    )


class _CameraSubscription:
    """One camera's live subscription: a driver ``subscribe_events`` loop + the
    per-event callback that normalizes → persists → publishes. Isolated per camera so
    a failure here never affects another camera."""

    def __init__(
        self,
        camera_id: str,
        tenant_id,
        brand: str,
        host: str,
        creds: Credentials,
        topic_allow: list[str],
        sessionmaker: async_sessionmaker[AsyncSession],
    ) -> None:
        self.camera_id = camera_id
        self.tenant_id = tenant_id
        self.brand = brand
        self.host = host
        self.creds = creds
        self.topic_allow = topic_allow
        self._sessionmaker = sessionmaker
        self._driver = get_driver(brand)
        self._task: asyncio.Task | None = None

    def start(self) -> None:
        self._task = asyncio.create_task(self._run())

    async def stop(self) -> None:
        try:
            await self._driver.stop_events()
        except Exception:  # noqa: BLE001
            pass
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None

    async def _on_event(self, evt: DeviceEvent) -> None:
        """Per-event callback: normalize → dedupe → persist → publish (own DB session)."""
        try:
            async with self._sessionmaker() as db:
                svc = VmsEventService(db, _PLATFORM_SCOPE)
                await svc.ingest_device_event(
                    tenant_id=self.tenant_id,
                    camera_id=self.camera_id,
                    driver_event_type=evt.event_type,
                    severity=evt.severity,
                    title=evt.title,
                    raw=dict(evt.metadata or {}),
                    source="onvif" if self.brand == "onvif" else "brand",
                    occurred_at=evt.occurred_at,
                    topic_allow=self.topic_allow or None,
                )
        except Exception as exc:  # noqa: BLE001 — one bad event must not kill the sub
            log.warning("event ingest failed for camera %s: %s", self.camera_id, exc)

    async def _run(self) -> None:
        """Drive the driver subscription; graceful on SDK-missing / unreachable."""
        try:
            await self._driver.subscribe_events(self.host, self.creds, self._on_event)
        except asyncio.CancelledError:
            raise
        except NotImplementedError:
            # Brand driver has no event subscription (or the ONVIF SDK isn't installed)
            # → no events for this camera. Not an error; just nothing to do.
            log.info(
                "camera %s (%s): event subscription unavailable — no device events",
                self.camera_id, self.brand,
            )
        except Exception as exc:  # noqa: BLE001 — a dead camera never stalls others
            log.warning("camera %s subscription ended: %s", self.camera_id, exc)


class EventSupervisor:
    """Manages the fleet of per-camera subscriptions; re-scans on a tick."""

    def __init__(self, sessionmaker: async_sessionmaker[AsyncSession]) -> None:
        self._sessionmaker = sessionmaker
        self._subs: dict[str, _CameraSubscription] = {}
        self._task: asyncio.Task | None = None
        self._running = False

    async def start(self) -> None:
        if self._running:
            return
        if not supervisor_enabled():
            log.info("event supervisor disabled (VE_EVENT_SUPERVISOR_ENABLED=0)")
            return
        self._running = True
        self._task = asyncio.create_task(self._loop())
        log.info(
            "event supervisor started (rescan=%ss concurrency=%s)",
            rescan_interval_sec(), sub_concurrency(),
        )

    async def stop(self) -> None:
        self._running = False
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
        # Reap every live subscription.
        for sub in list(self._subs.values()):
            await sub.stop()
        self._subs.clear()
        log.info("event supervisor stopped")

    async def _loop(self) -> None:
        # Small settle before the first scan (let NATS/DB warm up).
        try:
            await asyncio.sleep(min(8, rescan_interval_sec()))
        except asyncio.CancelledError:
            return
        while self._running:
            try:
                await self.reconcile()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 — one bad scan must not kill the loop
                log.warning("event supervisor reconcile error: %s", exc)
            try:
                await asyncio.sleep(rescan_interval_sec())
            except asyncio.CancelledError:
                return

    async def reconcile(self) -> int:
        """One re-scan: open subscriptions for newly event-enabled cameras, reap
        subscriptions for cameras that were disabled / deleted / turned off. Returns
        the number of ACTIVE subscriptions after the pass (handy for tests + logging).
        """
        async with self._sessionmaker() as db:
            rows = (
                await db.execute(
                    select(Camera).where(
                        Camera.is_enabled.is_(True),
                        Camera.onvif_events_enabled.is_(True),
                    )
                )
            ).scalars().all()
        wanted = {c.id: c for c in rows}

        # Reap subscriptions no longer wanted.
        for cam_id in list(self._subs):
            if cam_id not in wanted:
                await self._subs.pop(cam_id).stop()

        # Open subscriptions for newly-wanted cameras (bounded).
        sem = asyncio.Semaphore(sub_concurrency())
        to_open = [c for cid, c in wanted.items() if cid not in self._subs]

        async def _open(cam: Camera) -> None:
            async with sem:
                host = _host_for(cam)
                if not host:
                    log.info("camera %s event-enabled but has no host — skipping", cam.id)
                    return
                sub = _CameraSubscription(
                    camera_id=cam.id,
                    tenant_id=cam.tenant_id,
                    brand=cam.brand or "onvif",
                    host=host,
                    creds=_creds_for(cam),
                    topic_allow=list(cam.onvif_event_topics or []),
                    sessionmaker=self._sessionmaker,
                )
                sub.start()
                self._subs[cam.id] = sub
                log.info("opened event subscription for camera %s (%s@%s)", cam.id, cam.brand, host)

        if to_open:
            await asyncio.gather(*(_open(c) for c in to_open))
        return len(self._subs)

    def active_camera_ids(self) -> set[str]:
        """The camera_ids with a live subscription (test/introspection helper)."""
        return set(self._subs)
