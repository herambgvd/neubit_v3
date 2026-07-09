"""ONVIF-server domain (P6-C) — OUR VMS acts as an ONVIF device.

Makes the VMS discoverable + pullable by external VMS/recorders (Milestone / Genetec /
third-party NVRs): they WS-Discover us, ``GetProfiles`` our exposed cameras,
``GetStreamUri`` → our MediaMTX RTSP URLs, and pull recordings via Profile-G
(``GetRecordings`` / ``GetReplayUri`` → our recorded-playback URLs). A big interop/
enterprise differentiator.

Self-contained package:
  * ``schemas`` / ``service`` / ``router`` — the per-tenant ``OnvifServerConfig`` CRUD
    (JWT-gated ``vms.config.manage``): enable, exposed cameras, WS-Security service creds
    (password reversibly encrypted), advertised host/ports.
  * ``auth``    — WS-Security UsernameToken validation → resolves the tenant + config.
  * ``soap``    — the SOAP server (device/media/media2/recording/search/replay handlers),
    answering as an ONVIF device over OUR tenant-scoped data.
  * ``urls``    — StreamUri/SnapshotUri/ReplayUri → our MediaMTX/playback URLs.
  * ``discovery`` — the WS-Discovery advertiser (graceful when multicast is unavailable).

``config_router`` mounts under the service api_prefix (``/vms`` prefix); ``soap_router``
mounts at the app ROOT (``/onvif/*``); ``advertiser`` starts in the ``app.main`` lifespan.
"""

from __future__ import annotations

from .discovery import advertiser
from .router import config_router, soap_router

__all__ = ["config_router", "soap_router", "advertiser"]
