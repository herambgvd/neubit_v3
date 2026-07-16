"""Live-streaming service — PlaybackSession issuer + media-token verify.

The control-plane half of live streaming (D8): vision loads the camera (tenant-
scoped, decrypts creds), builds the RTSP source URL (prefer the sub-stream for
live bandwidth), asks the Go ``nvr`` to bring the MediaMTX path up, mints a
short-lived signed media token, persists a ``PlaybackSession`` and returns the
browser-facing URLs (with ``?token=`` appended, v2 pattern).

Discipline mirrors the camera/nvr services:
  * every read/by-id goes through ``kernel.auth.scoped`` / ``assert_owned``;
    new rows are stamped with the caller's ``tenant_id``.
  * credentials are decrypted only in-memory (``vms.common.crypto``) to build the
    RTSP URL — never persisted plain.
  * GRACEFUL: an unreachable camera (no RTSP derivable) or a down nvr surfaces as a
    clean 502 (``LiveUpstreamError``), never a 500.

The media token is stateless (``vms.common.media_token``); the session row stores
only its HASH. ``verify_token`` is the ForwardAuth hot path — a single HMAC verify,
no DB on the fast path.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from urllib.parse import quote

import jwt
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from kernel.auth import Scope, assert_owned, scoped
from kernel.errors import AppError, NotFoundError

from app.vms.common.crypto import decrypt_secret
from app.vms.common.media_token import (
    mint_media_token,
    token_hash,
    verify_media_token,
)
from app.vms.common.node_routing import node_base_for_camera
from app.vms.common.nvr_client import NvrClient, NvrUnavailable
from app.vms.models import Camera, MediaProfile, PlaybackSession

log = logging.getLogger("vision.live_service")


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _actor_id(actor) -> str | None:
    if actor is None:
        return None
    return str(getattr(actor, "user_id", "")) or None


class LiveUpstreamError(AppError):
    """Camera unreachable / nvr down / no RTSP derivable → a clean 502 (never 500)."""

    code = "MEDIA_UPSTREAM"
    status_code = 502


def _append_token(url: str | None, token: str) -> str | None:
    """Append ``?token=<t>`` (or ``&token=``) so the browser's HLS/WHEP requests
    carry the media token Traefik ForwardAuth validates. v2 token-in-query pattern."""
    if not url:
        return url
    sep = "&" if "?" in url else "?"
    return f"{url}{sep}token={quote(token, safe='')}"


class LiveService:
    """Tenant-scoped PlaybackSession issuer over ``playback_sessions``."""

    def __init__(self, db: AsyncSession, scope: Scope, *, bearer: str | None = None) -> None:
        self.db = db
        self.scope = scope
        self.bearer = bearer
        # The caller's JWT is forwarded to nvr so its ensure/drop authorize under
        # the caller's own grants (shared-JWT service-to-service). ``self.nvr`` is the
        # GLOBAL/default client (``VE_NVR_URL``) — used only for estate-wide calls; every
        # PER-CAMERA op routes to the camera's assigned MediaNode via ``_nvr_for`` (MN-1b).
        self.nvr = NvrClient(bearer=bearer)

    async def _nvr_for(self, camera_or_id) -> NvrClient:
        """An ``NvrClient`` bound to THIS camera's recorder-node base URL (MN-1b).

        Resolves the camera's ``media_node_id`` → ``MediaNode.api_url``. An unassigned
        camera (or missing node) yields ``base_url=None`` → we return the shared
        ``self.nvr`` (global ``VE_NVR_URL``) UNCHANGED — this keeps the single-node path
        byte-identical (and preserves ``self.nvr = stub`` test injection)."""
        base = await node_base_for_camera(self.db, self.scope.tenant_id, camera_or_id)
        if base is None:
            return self.nvr
        return NvrClient(bearer=self.bearer, base_url=base)

    # ── row helpers ─────────────────────────────────────────────────────
    async def _camera(self, camera_id: str) -> Camera:
        row = await self.db.get(Camera, camera_id)
        assert_owned(row, self.scope, message="camera not found")
        return row

    async def _session(self, session_id: str) -> PlaybackSession:
        row = await self.db.get(PlaybackSession, session_id)
        assert_owned(row, self.scope, message="playback session not found")
        return row

    async def _rtsp_source_for(self, camera: Camera, profile: str) -> str | None:
        """Derive the RTSP source URL for ``profile`` (prefer sub-stream for live).

        Order: the requested profile's stored ``MediaProfile.rtsp_path`` → the
        ``sub`` then ``main`` MediaProfile path → a constructed ONVIF/RTSP fallback
        from ``onvif_host``/creds. Credentials are injected into the URL (decrypted
        in-memory). Returns ``None`` when nothing is derivable (→ 502 upstream)."""
        profiles = {
            p.name: p
            for p in (
                await self.db.execute(
                    select(MediaProfile).where(MediaProfile.camera_id == camera.id)
                )
            )
            .scalars()
            .all()
        }
        # Preference chain: requested → sub → main → any.
        chosen = None
        for name in (profile, "sub", "main"):
            mp = profiles.get(name)
            if mp and mp.rtsp_path:
                chosen = mp.rtsp_path
                break
        if chosen is None:
            for mp in profiles.values():
                if mp.rtsp_path:
                    chosen = mp.rtsp_path
                    break

        username = camera.onvif_user or ""
        password = decrypt_secret(camera.onvif_enc_pass) or ""
        # Only embed creds when BOTH are present — a user-only / pass-only RTSP URL
        # is rejected by MediaMTX ("username and password must be both provided").
        use_creds = bool(username and password)

        if chosen:
            return _inject_rtsp_creds(chosen, username, password) if use_creds else chosen

        # Fallback: construct a Hikvision-style RTSP from host + rtsp_port.
        host = camera.onvif_host or (camera.network_info or {}).get("ip")
        if not host:
            return None
        rtsp_port = (camera.network_info or {}).get("rtsp_port") or 554
        # NOTE: channel 0 is a VALID NVR channel index — use an explicit None check,
        # never `or 1` (that would silently rewrite channel 0 → 1 and pull the wrong
        # feed; it hid a real bug where a channel-0 camera streamed the wrong source).
        channel = camera.nvr_channel_number if camera.nvr_channel_number is not None else 1
        # sub-stream is channel*100+2, main is *01 (Hik convention) — coarse fallback.
        sub = 2 if profile == "sub" else 1
        stream_path = f"/Streaming/Channels/{channel:d}0{sub:d}"
        base = f"rtsp://{host}:{rtsp_port}{stream_path}"
        return _inject_rtsp_creds(base, username, password) if use_creds else base

    # ── start / renew / release ─────────────────────────────────────────
    async def start_live(self, camera_id: str, profile: str, *, actor):
        """Load camera → build RTSP → nvr ensure → mint token → persist session."""
        camera = await self._camera(camera_id)
        rtsp_url = await self._rtsp_source_for(camera, profile)
        if not rtsp_url:
            raise LiveUpstreamError("camera has no reachable RTSP stream to publish")

        try:
            nvr = await self._nvr_for(camera)
            ensured = await nvr.ensure_stream(
                camera_id=camera.id, rtsp_url=rtsp_url, profile=profile
            )
        except NvrUnavailable as exc:
            raise LiveUpstreamError(exc.message) from exc

        tenant_str = str(self.scope.tenant_id) if self.scope.tenant_id else None
        row = PlaybackSession(
            tenant_id=self.scope.tenant_id,
            camera_id=camera.id,
            kind="live",
            profile=profile,
            mediamtx_name=ensured.get("name"),
            node=ensured.get("node"),
            hls_url=ensured.get("hls_url"),
            webrtc_url=ensured.get("webrtc_url"),
            rtsp_url=ensured.get("rtsp_url"),
            created_by=_actor_id(actor),
        )
        self.db.add(row)
        await self.db.flush()  # assign row.id for the token claim

        token, exp = mint_media_token(
            tenant_id=tenant_str, camera_id=camera.id, session_id=row.id
        )
        row.token_hash = token_hash(token)
        row.expires_at = datetime.fromtimestamp(exp, tz=timezone.utc)
        await self.db.commit()
        await self.db.refresh(row)

        return _public(row, token, ready=bool(ensured.get("ready")))

    async def renew(self, session_id: str, *, actor):
        """Re-mint the token (extend TTL) WITHOUT re-ensuring — long views don't drop."""
        row = await self._session(session_id)
        tenant_str = str(row.tenant_id) if row.tenant_id else None
        token, exp = mint_media_token(
            tenant_id=tenant_str, camera_id=row.camera_id, session_id=row.id
        )
        row.token_hash = token_hash(token)
        row.expires_at = datetime.fromtimestamp(exp, tz=timezone.utc)
        row.updated_at = _utcnow()
        await self.db.commit()
        await self.db.refresh(row)
        return _public(row, token, ready=True)

    async def release(self, session_id: str, *, actor) -> None:
        """Release: best-effort nvr path DELETE + delete the session row."""
        row = await self._session(session_id)
        camera_id, profile = row.camera_id, row.profile
        # Resolve the camera's node BEFORE deleting the session row (needs the camera).
        nvr = await self._nvr_for(camera_id)
        await self.db.delete(row)
        await self.db.commit()
        # Best-effort teardown of the MediaMTX path (never blocks/raises the delete).
        await nvr.drop_stream(camera_id=camera_id, profile=profile)

    # ── verify (Traefik ForwardAuth hot path) ───────────────────────────
    async def verify(self, token: str, *, check_camera: bool = False) -> dict:
        """Validate a media token → its claims. Fast + stateless (single HMAC).

        Raises ``UnauthorizedError`` (401) on a bad/expired/wrong-type token and
        ``NotFoundError`` (mapped to 403 by the router) when ``check_camera`` and the
        camera is not in the token's tenant. The DB check is OFF by default — the hot
        path decodes+verifies the JWT only."""
        from kernel.errors import UnauthorizedError

        try:
            claims = verify_media_token(token)
        except (jwt.PyJWTError, ValueError) as exc:
            raise UnauthorizedError(f"invalid media token: {exc}") from exc

        if check_camera:
            # Optional per-request DB cross-check: camera exists in the token tenant.
            cam = await self.db.get(Camera, claims.get("camera_id"))
            if cam is None:
                raise NotFoundError("camera not found")
            tok_tenant = claims.get("tenant_id")
            cam_tenant = str(cam.tenant_id) if cam.tenant_id else "platform"
            if tok_tenant not in (cam_tenant, "platform"):
                raise NotFoundError("camera not in token tenant")
        return claims


# ── helpers ────────────────────────────────────────────────────────────────


def _public(row: PlaybackSession, token: str, *, ready: bool):
    from .schemas import PlaybackSessionPublic

    return PlaybackSessionPublic(
        session_id=row.id,
        camera_id=row.camera_id,
        kind=row.kind,
        profile=row.profile,
        hls_url=_append_token(row.hls_url, token),
        webrtc_url=_append_token(row.webrtc_url, token),
        rtsp_url=row.rtsp_url,  # RTSP creds ride the path server-side; no browser token.
        token=token,
        expires_at=row.expires_at,
        ready=ready,
    )


def _inject_rtsp_creds(url: str, username: str, password: str) -> str:
    """Inject percent-encoded rtsp creds into a URL authority (idempotent).

    Ported from the ONVIF driver's ``_inject_creds`` — skips URLs that already carry
    an ``@`` in the authority so a stored profile path with creds is left intact."""
    if not username or "://" not in url:
        return url
    proto, rest = url.split("://", 1)
    authority = rest.split("/", 1)[0]
    if "@" in authority:
        return url
    user = quote(username, safe="")
    pwd = quote(password or "", safe="")
    return f"{proto}://{user}:{pwd}@{rest}"
