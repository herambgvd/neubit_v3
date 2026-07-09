"""Video-decoder service — tenant-scoped CRUD + live probe (VW-B).

Mirrors the camera service: every read goes through ``kernel.auth.scoped``; every by-id
fetch through ``assert_owned`` (cross-tenant → NotFound → 404); new rows are stamped with
the caller's ``tenant_id``. The decoder-management password is stored REVERSIBLY encrypted
(``common.crypto.encrypt_secret``) and decrypted in-memory only for a driver call.

``test`` runs a live ``DecoderDriver.probe()`` against the appliance (graceful — an
unreachable decoder returns ``reachable=False``, never an error).

``build_credentials`` / ``resolve_driver`` are the seam the wall service (decoder push)
reuses: given a decoder id it returns the driver + decrypted creds so ``push_cell`` can
call ``driver.display(...)``.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from kernel.auth import Scope, assert_owned, scoped
from kernel.errors import ConflictError

from app.vms.common.crypto import decrypt_secret, encrypt_secret
from app.vms.drivers.decoder_base import DecoderCredentials, DecoderDriver
from app.vms.drivers.decoder_factory import get_decoder_driver
from app.vms.models import VideoDecoder

from .decoder_schemas import (
    DecoderCreate,
    DecoderListResponse,
    DecoderPublic,
    DecoderTestResult,
    DecoderUpdate,
)

log = logging.getLogger("vision.videowall.decoder")


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _actor_id(actor) -> str | None:
    if actor is None:
        return None
    return str(getattr(actor, "user_id", "")) or None


class VideoDecoderService:
    """Tenant-scoped hardware video-decoder CRUD + live probe."""

    def __init__(self, db: AsyncSession, scope: Scope) -> None:
        self.db = db
        self.scope = scope

    # ── row fetch (ownership-checked) ───────────────────────────────────────
    async def _decoder(self, decoder_id: str) -> VideoDecoder:
        row = await self.db.get(VideoDecoder, decoder_id)
        assert_owned(row, self.scope, message="Video decoder not found")
        return row

    # ── CRUD ────────────────────────────────────────────────────────────────
    async def create(self, body: DecoderCreate, *, actor) -> DecoderPublic:
        dup = await self.db.scalar(
            scoped(select(VideoDecoder), VideoDecoder, self.scope).where(
                VideoDecoder.name == body.name
            )
        )
        if dup is not None:
            raise ConflictError("a video decoder with this name already exists")
        actor_id = _actor_id(actor)
        row = VideoDecoder(
            tenant_id=self.scope.tenant_id,
            name=body.name,
            brand=body.brand,
            host=body.host,
            port=body.port,
            username=body.username,
            enc_password=encrypt_secret(body.password) if body.password else None,
            channel_count=body.channel_count,
            is_enabled=body.is_enabled,
            created_by=actor_id,
            updated_by=actor_id,
        )
        self.db.add(row)
        await self.db.commit()
        await self.db.refresh(row)
        return DecoderPublic.from_row(row)

    async def list(self, *, skip: int = 0, limit: int = 50) -> DecoderListResponse:
        stmt = (
            scoped(select(VideoDecoder), VideoDecoder, self.scope)
            .order_by(VideoDecoder.created_at.desc())
            .offset(skip)
            .limit(limit)
        )
        count_stmt = scoped(
            select(func.count()).select_from(VideoDecoder), VideoDecoder, self.scope
        )
        rows = (await self.db.execute(stmt)).scalars().all()
        total = int(await self.db.scalar(count_stmt) or 0)
        return DecoderListResponse(
            items=[DecoderPublic.from_row(r) for r in rows], total=total
        )

    async def get(self, decoder_id: str) -> DecoderPublic:
        return DecoderPublic.from_row(await self._decoder(decoder_id))

    async def update(self, decoder_id: str, body: DecoderUpdate, *, actor) -> DecoderPublic:
        row = await self._decoder(decoder_id)
        data = body.model_dump(exclude_unset=True)
        for k in {"name", "brand", "host", "port", "username", "channel_count", "is_enabled"} & set(data):
            setattr(row, k, data[k])
        if "password" in data:
            # Empty string clears the stored password; a value re-encrypts it.
            row.enc_password = encrypt_secret(data["password"]) if data["password"] else None
        actor_id = _actor_id(actor)
        if actor_id:
            row.updated_by = actor_id
        row.updated_at = _utcnow()
        await self.db.commit()
        await self.db.refresh(row)
        return DecoderPublic.from_row(row)

    async def delete(self, decoder_id: str) -> None:
        row = await self._decoder(decoder_id)
        await self.db.delete(row)
        await self.db.commit()

    # ── live probe (test) ────────────────────────────────────────────────────
    async def test(self, decoder_id: str) -> DecoderTestResult:
        row = await self._decoder(decoder_id)
        driver = get_decoder_driver(row.brand)
        if driver is None:
            return DecoderTestResult(reachable=False, error=f"unsupported decoder brand: {row.brand}")
        info = await driver.probe(row.host, self._creds(row))
        return DecoderTestResult(
            reachable=info.reachable,
            manufacturer=info.manufacturer,
            model=info.model,
            firmware=info.firmware,
            serial_number=info.serial_number,
            channel_count=info.channel_count,
            error=info.error,
        )

    # ── wall-push seam (reused by VideoWallService) ──────────────────────────
    def _creds(self, row: VideoDecoder) -> DecoderCredentials:
        """Build in-memory plaintext creds from a decoder row (password decrypted)."""
        return DecoderCredentials(
            username=row.username or "admin",
            password=decrypt_secret(row.enc_password) or "",
            port=row.port,
        )

    async def resolve_driver(
        self, decoder_id: str
    ) -> tuple[DecoderDriver, VideoDecoder, DecoderCredentials] | None:
        """Fetch an OWNED, enabled decoder + its driver + decrypted creds, or ``None`` if
        the decoder is missing / cross-tenant / disabled / an unsupported brand. Returns
        ``None`` (never raises) so the wall service treats it as "no decoder push".
        Ownership is enforced via ``scoped`` — a foreign decoder yields ``None``."""
        row = await self.db.scalar(
            scoped(select(VideoDecoder), VideoDecoder, self.scope).where(
                VideoDecoder.id == decoder_id
            )
        )
        if row is None or not row.is_enabled:
            return None
        driver = get_decoder_driver(row.brand)
        if driver is None:
            return None
        return driver, row, self._creds(row)
