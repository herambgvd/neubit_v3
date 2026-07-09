"""WS-Discovery advertiser — announces OUR VMS as an ONVIF device (P6-C).

Ported from gvd_nvr ``onvif_device/discovery.py``. Sends WS-Discovery Hello multicasts
(239.255.255.250:3702) so ONVIF clients (Milestone / Genetec / onvif-tester) auto-find
us on the LAN. The advertised XAddr points at our gateway-routed ``/onvif/device_service``.

GRACEFUL: multicast is frequently unavailable in a bridged Docker network — if the
``wsdiscovery`` package is missing OR the socket can't bind/multicast, we log and DISABLE
the advertiser (the SOAP server still works; clients add us manually by URL). It never
crashes the app.

The responder is process-wide (not per-tenant) — it advertises the DEVICE; which tenant a
client sees is decided later by the WS-Security creds it presents to the SOAP endpoints.
Only starts when at least one tenant has an enabled ``OnvifServerConfig`` (checked at
lifespan start; re-checked lazily is a later refinement).
"""

from __future__ import annotations

import asyncio
import logging
import os
import socket
import uuid

log = logging.getLogger("vision.onvif_server.discovery")

try:
    from wsdiscovery import QName, Scope, WSDiscovery
    from wsdiscovery.service import Service

    _HAS_WSDISCOVERY = True
except Exception:  # noqa: BLE001 — package optional in the container
    _HAS_WSDISCOVERY = False


def _advertise_host() -> str:
    env_host = os.environ.get("ONVIF_XADDR_HOST", "").strip()
    if env_host:
        return env_host
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(0.5)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:  # noqa: BLE001
        return "127.0.0.1"


class OnvifDiscoveryAdvertiser:
    """Publishes OUR VMS as an ONVIF NetworkVideoTransmitter via WS-Discovery Hello."""

    HELLO_INTERVAL = 60  # seconds

    def __init__(self) -> None:
        self._wsd = None
        self._service = None
        self._task: asyncio.Task | None = None
        self._running = False
        self._epr = uuid.uuid4().urn

    def _build_service(self):
        host = _advertise_host()
        port = os.environ.get("ONVIF_XADDR_PORT", "").strip()
        xaddr = (
            f"http://{host}:{port}/onvif/device_service"
            if port
            else f"http://{host}/onvif/device_service"
        )
        return Service(
            types=[
                QName(
                    "http://www.onvif.org/ver10/network/wsdl",
                    "NetworkVideoTransmitter",
                )
            ],
            scopes=[
                Scope("onvif://www.onvif.org/type/video_server"),
                Scope("onvif://www.onvif.org/type/network_video_transmitter"),
                Scope("onvif://www.onvif.org/Profile/Streaming"),
                Scope("onvif://www.onvif.org/Profile/G"),
                Scope("onvif://www.onvif.org/name/Neubit-VMS"),
            ],
            xAddrs=[xaddr],
            epr=self._epr,
            instanceId=1,
        )

    async def start(self) -> None:
        if not _HAS_WSDISCOVERY:
            log.info("WS-Discovery unavailable (wsdiscovery not installed) — "
                     "ONVIF clients must add us by URL")
            return
        if self._running:
            return
        self._running = True
        self._task = asyncio.create_task(self._run(), name="onvif_ws_discovery")
        log.info("ONVIF WS-Discovery advertiser started")

    async def _run(self) -> None:
        try:
            self._wsd = WSDiscovery()
            self._wsd.start()
            self._service = self._build_service()
            self._wsd._sendHello(self._service)
        except Exception as exc:  # noqa: BLE001 — multicast unavailable in Docker → degrade
            log.info("WS-Discovery init failed (multicast unavailable?): %s — "
                     "ONVIF clients must add us by URL", exc)
            self._running = False
            return
        while self._running:
            try:
                await asyncio.sleep(self.HELLO_INTERVAL)
                if not self._running:
                    break
                self._service = self._build_service()
                self._wsd._sendHello(self._service)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                log.debug("WS-Discovery heartbeat error: %s", exc)

    async def stop(self) -> None:
        self._running = False
        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        if self._wsd and self._service:
            try:
                self._wsd._sendBye(self._service)
            except Exception:  # noqa: BLE001
                pass
            try:
                self._wsd.stop()
            except Exception:  # noqa: BLE001
                pass
        log.info("ONVIF WS-Discovery advertiser stopped")


advertiser = OnvifDiscoveryAdvertiser()
