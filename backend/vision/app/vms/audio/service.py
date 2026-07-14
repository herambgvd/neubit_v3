"""Two-way-audio (talk) service — talk-session issuer (G6), tenant-scoped.

Mirrors the live-session issuer (``vms.live.service``): loads the camera under the
caller's scope, confirms the device is backchannel-capable, resolves the backchannel
target via the driver, and mints a short-lived ``sub_type="talk"`` token the frontend
carries to open an uplink (mic → WHIP-into-MediaMTX / backchannel).

Discipline:
  * The camera read goes through ``kernel.auth.assert_owned`` (tenant isolation).
  * A non-backchannel camera is a clean 409 (``TalkNotSupported``) — not a 500.
  * The talk session is STATELESS (token-only, like the media token) — no DB row; the
    ``session_id`` is a fresh UUID baked into the token claim for audit/correlation.
  * The real on-wire push to a device speaker is # LIVE-VALIDATE (brand-specific); the
    service resolves the CAPABILITY + target, the media-plane/browser does the push.
"""

from __future__ import annotations

import logging
import os
import uuid
from datetime import datetime, timezone

from kernel.auth import Scope, assert_owned
from kernel.errors import AppError

from app.vms.common.crypto import decrypt_secret
from app.vms.common.media_token import media_token_ttl, mint_talk_token
from app.vms.drivers import Credentials, TalkTarget, get_driver
from app.vms.models import Camera

log = logging.getLogger("vision.audio_service")


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class TalkNotSupported(AppError):
    """The camera has no detected backchannel (speaker) → a clean 409."""

    code = "TALK_UNSUPPORTED"
    status_code = 409


class TalkUpstreamError(AppError):
    """The device/media-plane could not provide a talk target → a clean 502."""

    code = "MEDIA_UPSTREAM"
    status_code = 502


def _whip_base() -> str | None:
    """The gateway-routed WHIP publish base the browser pushes mic audio to.

    ``VE_TALK_WHIP_BASE`` (e.g. ``/api/v1/vms/media/whip`` or an absolute MediaMTX WHIP
    URL). None when unset — the frontend then falls back to the driver ``target_url``.
    """
    v = (os.environ.get("VE_TALK_WHIP_BASE") or "").strip()
    return v.rstrip("/") or None


class AudioTalkService:
    """Tenant-scoped talk-session issuer."""

    def __init__(self, db, scope: Scope, *, bearer: str | None = None) -> None:
        self.db = db
        self.scope = scope
        self.bearer = bearer

    async def _camera(self, camera_id: str) -> Camera:
        row = await self.db.get(Camera, camera_id)
        assert_owned(row, self.scope, message="camera not found")
        return row

    def _creds_for(self, row: Camera) -> Credentials:
        return Credentials(
            username=row.onvif_user or "admin",
            password=decrypt_secret(row.onvif_enc_pass) or "",
            port=row.onvif_port or 80,
            rtsp_port=(row.network_info or {}).get("rtsp_port") or 554,
        )

    def _capable(self, camera: Camera) -> bool:
        """Backchannel from the stored capability matrix (driver-detected at probe)."""
        return bool((camera.onvif_capabilities or {}).get("backchannel"))

    async def _resolve_target(self, camera: Camera, profile: str) -> TalkTarget:
        """Best-effort live resolve of the backchannel target via the driver.

        Graceful: an unreachable device / driver error falls back to a store-only
        target (capability known from ``onvif_capabilities`` even if the device is
        momentarily unreachable). NEVER raises here — the caller decides on support.
        """
        host = camera.onvif_host or (camera.network_info or {}).get("ip")
        if not host:
            return TalkTarget(supported=self._capable(camera))
        driver = get_driver(camera.brand)
        try:
            return await driver.talk_target(host, self._creds_for(camera), profile=profile)
        except Exception as exc:  # noqa: BLE001 — graceful: fall back to stored cap
            log.info("talk target resolve failed for %s (%s): %s", camera.id, host, exc)
            return TalkTarget(supported=self._capable(camera))
        finally:
            await driver.aclose()

    async def start_talk(self, camera_id: str, profile: str, *, actor):
        """Issue a talk session for a backchannel-capable camera.

        409 when the camera has no detected backchannel; otherwise mints a talk token
        and returns the WHIP/backchannel target for the frontend. Loads the camera
        under the caller's scope (tenant isolation)."""
        camera = await self._camera(camera_id)

        target = await self._resolve_target(camera, profile)
        # A camera is talk-capable if EITHER the live driver resolved a backchannel OR
        # the stored capability matrix says so (device momentarily unreachable).
        if not (target.supported or self._capable(camera)):
            raise TalkNotSupported("camera has no two-way audio (backchannel) capability")

        session_id = str(uuid.uuid4())
        tenant_str = str(self.scope.tenant_id) if self.scope.tenant_id else None
        token, exp = mint_talk_token(
            tenant_id=tenant_str, camera_id=camera.id, session_id=session_id
        )

        # WHIP is the practical browser flow (mic → MediaMTX → camera backchannel). The
        # driver target_url (RTSP backchannel / brand push) is advisory for a server-side
        # forwarder. Whichever the frontend uses carries the talk token.
        whip_base = _whip_base()
        whip_url = None
        kind = target.kind or "rtsp_backchannel"
        if whip_base:
            whip_url = f"{whip_base}/{camera.id}?token={token}"
            kind = "whip"

        from .schemas import TalkSessionPublic

        return TalkSessionPublic(
            session_id=session_id,
            camera_id=camera.id,
            kind=kind,
            target_url=target.url,
            whip_url=whip_url,
            codec=target.codec,
            token=token,
            expires_at=datetime.fromtimestamp(exp, tz=timezone.utc),
            live_validate=True,
            extra={
                "require": (target.extra or {}).get("require"),
                "ttl_seconds": media_token_ttl(),
                "profile": profile,
            },
        )
