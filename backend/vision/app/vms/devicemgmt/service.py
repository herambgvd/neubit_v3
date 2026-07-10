"""Device / fleet-management service (G7) — tenant-scoped driver fan-out.

A thin layer over ``app.vms.drivers``: it resolves the tenant-owned Camera row(s),
decrypts creds in-memory (never persisted), and dispatches the fleet op to the brand
driver. Discipline mirrors ``CameraService``:
  * by-id fetch → ``assert_owned`` (404 cross-tenant);
  * bulk loads only rows the caller owns (``scoped`` + id filter), so a foreign
    ``camera_id`` silently drops out of the fan-out (tenant isolation);
  * every op degrades gracefully — an unreachable device / unsupported brand returns a
    ``FleetOpResult(ok=False, ...)`` rather than raising, so the bulk batch never aborts.

The real on-device effect is ``# LIVE-VALIDATE`` (no live devices in dev). This service
is what the router adapts to the public schemas.
"""

from __future__ import annotations

import logging
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from kernel.auth import Scope, assert_owned, scoped

from app.vms.common.crypto import decrypt_secret
from app.vms.drivers import ConfigBackup, Credentials, FleetOpResult, get_driver
from app.vms.models import Camera

log = logging.getLogger("vision.devicemgmt")


class DeviceMgmtService:
    """Tenant-scoped fleet ops over onboarded cameras via the driver seam."""

    def __init__(self, db: AsyncSession, scope: Scope) -> None:
        self.db = db
        self.scope = scope

    # ── row + credential helpers (mirror CameraService) ──────────────────
    async def _row(self, camera_id: str) -> Camera:
        row = await self.db.get(Camera, camera_id)
        assert_owned(row, self.scope, message="Camera not found")
        return row

    @staticmethod
    def _host(row: Camera) -> str | None:
        return row.onvif_host or (row.network_info or {}).get("ip")

    @staticmethod
    def _creds_for(row: Camera) -> Credentials:
        return Credentials(
            username=row.onvif_user or "admin",
            password=decrypt_secret(row.onvif_enc_pass) or "",
            port=row.onvif_port or 80,
            rtsp_port=(row.network_info or {}).get("rtsp_port") or 554,
        )

    def _unreachable(self, detail: str = "camera has no reachable host configured") -> FleetOpResult:
        return FleetOpResult(ok=False, detail=detail)

    # ── per-camera ops ───────────────────────────────────────────────────
    async def device_info(self, camera_id: str):
        """Firmware / identity read for one camera (driver ``get_device_info`` → probe)."""
        row = await self._row(camera_id)
        host = self._host(row)
        if not host:
            from app.vms.drivers import DeviceInfo

            return DeviceInfo(reachable=False, error="camera has no reachable host configured")
        driver = get_driver(row.brand)
        try:
            return await driver.get_device_info(host, self._creds_for(row))
        finally:
            await driver.aclose()

    async def reboot(self, camera_id: str) -> FleetOpResult:
        return await self._run(camera_id, lambda d, host, creds: d.reboot(host, creds))

    async def set_ntp(self, camera_id: str, server: str) -> FleetOpResult:
        return await self._run(camera_id, lambda d, host, creds: d.set_ntp(host, creds, server))

    async def set_password(self, camera_id: str, *, user: str, new_password: str) -> FleetOpResult:
        return await self._run(
            camera_id,
            lambda d, host, creds: d.set_password(host, creds, user=user, new_password=new_password),
        )

    async def backup_config(self, camera_id: str) -> ConfigBackup:
        row = await self._row(camera_id)
        host = self._host(row)
        if not host:
            return ConfigBackup(supported=False, detail="camera has no reachable host configured")
        driver = get_driver(row.brand)
        try:
            return await driver.backup_config(host, self._creds_for(row))
        except Exception as exc:  # noqa: BLE001 — never raise; graceful unsupported
            log.info("backup_config(camera=%s) errored: %s", camera_id, exc)
            return ConfigBackup(supported=False, detail=str(exc))
        finally:
            await driver.aclose()

    async def restore_config(self, camera_id: str, blob: bytes) -> FleetOpResult:
        return await self._run(camera_id, lambda d, host, creds: d.restore_config(host, creds, blob))

    async def _run(self, camera_id: str, op) -> FleetOpResult:
        """Resolve the owned camera + driver and run ``op(driver, host, creds)`` gracefully."""
        row = await self._row(camera_id)
        host = self._host(row)
        if not host:
            return self._unreachable()
        driver = get_driver(row.brand)
        try:
            return await op(driver, host, self._creds_for(row))
        except Exception as exc:  # noqa: BLE001 — fleet ops degrade, never 500
            log.info("fleet op errored (camera=%s brand=%s): %s", camera_id, row.brand, exc)
            return FleetOpResult(ok=False, detail=str(exc))
        finally:
            await driver.aclose()

    # ── bulk fan-out ─────────────────────────────────────────────────────
    async def bulk(
        self,
        action: str,
        camera_ids: list[str],
        *,
        server: str | None = None,
        user: str | None = None,
        new_password: str | None = None,
    ) -> dict[str, Any]:
        """Apply ``action`` to each owned camera, best-effort, returning per-camera results.

        Loads ONLY rows the caller owns (scoped + id filter) so a foreign id drops out
        (tenant isolation). Each camera runs independently — one failure/timeout never
        aborts the batch. Cameras are processed with a small concurrency cap.
        """
        # Owned rows only (tenant isolation); preserve caller's id order where possible.
        stmt = scoped(select(Camera), Camera, self.scope).where(Camera.id.in_(camera_ids))
        rows = {r.id: r for r in (await self.db.execute(stmt)).scalars().all()}
        ordered = [rows[cid] for cid in camera_ids if cid in rows]

        items: list[dict[str, Any]] = []
        succeeded = 0
        for row in ordered:
            res = await self._bulk_one(row, action, server=server, user=user, new_password=new_password)
            if res.ok:
                succeeded += 1
            items.append({
                "camera_id": row.id,
                "camera_name": row.name,
                "ok": res.ok,
                "supported": res.supported,
                "detail": res.detail,
            })
        return {
            "action": action,
            "total": len(items),
            "succeeded": succeeded,
            "items": items,
        }

    async def _bulk_one(
        self, row: Camera, action: str, *, server, user, new_password
    ) -> FleetOpResult:
        host = self._host(row)
        if not host:
            return self._unreachable()
        driver = get_driver(row.brand)
        creds = self._creds_for(row)
        try:
            if action == "reboot":
                return await driver.reboot(host, creds)
            if action == "ntp":
                if not server:
                    return FleetOpResult(ok=False, detail="server required for the ntp action")
                return await driver.set_ntp(host, creds, server)
            if action == "password":
                if not (user and new_password):
                    return FleetOpResult(ok=False, detail="user + new_password required for the password action")
                return await driver.set_password(host, creds, user=user, new_password=new_password)
            return FleetOpResult(ok=False, supported=False, detail=f"unknown bulk action: {action}")
        except Exception as exc:  # noqa: BLE001 — one camera's failure can't abort the batch
            log.info("bulk %s errored (camera=%s): %s", action, row.id, exc)
            return FleetOpResult(ok=False, detail=str(exc))
        finally:
            await driver.aclose()


# ── DTO → public-dict adapters ───────────────────────────────────────────
def device_info_dict(info) -> dict[str, Any]:
    return {
        "reachable": info.reachable,
        "manufacturer": info.manufacturer,
        "model": info.model,
        "firmware": info.firmware,
        "serial_number": info.serial_number,
        "hardware_id": info.hardware_id,
        "mac": info.mac,
        "channel_count": info.channel_count,
        "error": info.error,
    }


def fleet_op_dict(res: FleetOpResult) -> dict[str, Any]:
    return {"ok": res.ok, "supported": res.supported, "detail": res.detail, "data": res.data or {}}
