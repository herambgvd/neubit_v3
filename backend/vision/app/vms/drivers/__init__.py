"""VMS camera/NVR driver framework — the multi-brand seam (Python control-plane).

The onboarding + config service layer depends ONLY on the ``CameraDriver`` interface
and picks a concrete driver via ``get_driver(brand)``. This mirrors the access service's
``connectors`` package (ABC + factory + brand modules). Import surface:

    from app.vms.drivers import get_driver, CameraDriver, Credentials, PtzCommand

Brands:
  * ``onvif``    — OnvifDriver (default; faithful port of gvd_nvr ONVIF, Profile S/G/T).
  * ``hikvision``— HikvisionDriver (ISAPI HTTP Digest).
  * ``cpplus``   — CpPlusDriver (Dahua-lineage HTTP CGI; alias ``dahua``).
  * ``lumina``   — LuminaDriver (faithful port of neubit_v2's Lumina HTTP-API; NOT ONVIF).

Drivers are STATELESS (every method takes ``host`` + ``Credentials``), degrade
gracefully on unreachable hosts, and receive DECRYPTED creds in-memory only (the
service decrypts via ``app.vms.common.crypto`` first — the driver never touches the DB or key).
"""

from __future__ import annotations

from .base import (
    Capabilities,
    Channel,
    CameraDriver,
    Credentials,
    DeviceEvent,
    DeviceInfo,
    Discovered,
    DriverError,
    EventCallback,
    PtzCommand,
    StreamInfo,
    StreamUris,
    TalkTarget,
)
from .cpplus import CpPlusDriver
from .factory import get_driver, supported_brands
from .hikvision import HikvisionDriver
from .lumina import LuminaDriver
from .onvif import ONVIF_TOPIC_MAP, OnvifDriver

__all__ = [
    # interface + DTOs
    "CameraDriver",
    "Credentials",
    "Discovered",
    "DeviceInfo",
    "Channel",
    "StreamInfo",
    "StreamUris",
    "TalkTarget",
    "Capabilities",
    "PtzCommand",
    "DeviceEvent",
    "EventCallback",
    "DriverError",
    # factory
    "get_driver",
    "supported_brands",
    # concrete drivers
    "OnvifDriver",
    "HikvisionDriver",
    "CpPlusDriver",
    "LuminaDriver",
    "ONVIF_TOPIC_MAP",
]
