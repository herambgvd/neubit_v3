"""RAID service — software-RAID (mdadm) health inspection for the VMS storage plane.

Enterprise VMS (Genetec/Milestone/CP-Plus) treat RAID as a MUST: a recording estate
records 24/7, disks fail routinely, and the operator must be told the instant an array
degrades so a disk is swapped BEFORE a second failure loses footage. The VMS does NOT
build the array (that's the OS / RAID controller); it MONITORS it and surfaces
health + alerts. This module is the read-only inspection half — ported from ``gvd_nvr``
``storage/raid_service.py`` and trimmed to the monitoring path (create/stop/remove are
privileged operator actions kept out of the tenant-facing service for now).

PREREQUISITES (real Linux appliance)
  * Linux kernel with the ``md`` software-RAID module.
  * ``mdadm`` installed (``apt install mdadm``). Read-only status needs no privileges.
  * ``lsblk`` for block-device discovery.

NON-LINUX (mac / Docker Desktop dev)
  ``probe_available()`` returns ``{available: False, reason: ...}`` and ``list_arrays()``
  / ``list_block_devices()`` return ``[]`` — the monitor idles cleanly and the UI shows
  "RAID inspection not available on this host". Everything degrades gracefully.
"""

from __future__ import annotations

import asyncio
import logging
import platform
import re
import shutil

log = logging.getLogger("vision.raid")

_LEVEL_RE = re.compile(r"Raid Level\s*:\s*(\S+)", re.IGNORECASE)
_STATE_RE = re.compile(r"State\s*:\s*(.+)", re.IGNORECASE)
_WORKING_RE = re.compile(r"Working Devices\s*:\s*(\d+)", re.IGNORECASE)
_FAILED_RE = re.compile(r"Failed Devices\s*:\s*(\d+)", re.IGNORECASE)
_TOTAL_RE = re.compile(r"Raid Devices\s*:\s*(\d+)", re.IGNORECASE)
_REBUILD_RE = re.compile(r"Rebuild Status\s*:\s*(.+)", re.IGNORECASE)
_PCT_RE = re.compile(r"(\d+)\s*%")


def _is_linux() -> bool:
    return platform.system() == "Linux"


def _mdadm_available() -> bool:
    return _is_linux() and shutil.which("mdadm") is not None


def _extract(text: str, pattern: re.Pattern) -> str | None:
    m = pattern.search(text)
    return m.group(1).strip() if m else None


def _derive_health(*, state: str, failed: int, rebuild: str | None) -> str:
    """Collapse mdadm's raw State + counts into one operator-facing status.

    healthy | degraded | rebuilding | failed | unknown
    """
    s = (state or "").lower()
    if rebuild or "recover" in s or "resync" in s or "rebuild" in s:
        return "rebuilding"
    if "failed" in s and failed and failed >= 2:
        return "failed"
    if failed and failed > 0 or "degraded" in s:
        return "degraded"
    if "clean" in s or "active" in s:
        return "healthy"
    return "unknown"


class RaidService:
    """Wrap ``mdadm`` for read-only RAID inspection. Never raises to the caller."""

    def probe_available(self) -> dict:
        """Availability status without raising — safe to call anywhere.

        ``kind`` tells the UI HOW to present storage health: ``software_raid`` = the
        native mdadm array view (Linux); ``hardware_raid`` = a controller-managed array
        (Windows / RAID card) where the OS sees ready-made volumes — the controller owns
        parity/rebuild, so we monitor per-VOLUME free-space + reachability (the storage
        pool cards' disk stats) rather than md arrays."""
        if not _is_linux():
            return {
                "available": False,
                "kind": "hardware_raid",
                "reason": (
                    f"Software-RAID (mdadm) inspection is Linux-only; this host is "
                    f"{platform.system()}. On a hardware-RAID appliance (Windows / RAID "
                    "controller) the array is managed by the controller — per-volume "
                    "capacity + health is shown on each storage pool."
                ),
            }
        if not _mdadm_available():
            return {
                "available": False,
                "kind": "hardware_raid",
                "reason": (
                    "mdadm not present — if this is a hardware-RAID appliance the array "
                    "is controller-managed; per-volume health is on each storage pool. "
                    "For Linux software RAID: apt install mdadm."
                ),
            }
        return {"available": True, "kind": "software_raid"}

    async def list_arrays(self) -> list[dict]:
        """Enumerate active md arrays with derived health. ``[]`` if unavailable."""
        if not self.probe_available().get("available"):
            return []
        try:
            proc = await asyncio.create_subprocess_exec(
                "mdadm", "--detail", "--scan",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=10)
        except (asyncio.TimeoutError, OSError) as exc:
            log.warning("mdadm --detail --scan failed: %s", exc)
            return []

        arrays: list[dict] = []
        for line in stdout.decode(errors="replace").splitlines():
            m = re.match(r"ARRAY\s+(\S+)", line)
            if m:
                detail = await self._detail(m.group(1))
                if detail:
                    arrays.append(detail)
        return arrays

    async def _detail(self, device: str) -> dict | None:
        try:
            proc = await asyncio.create_subprocess_exec(
                "mdadm", "--detail", device,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=10)
        except (asyncio.TimeoutError, OSError) as exc:
            log.debug("mdadm --detail %s failed: %s", device, exc)
            return None

        text = stdout.decode(errors="replace")
        failed = int(_extract(text, _FAILED_RE) or 0)
        working = int(_extract(text, _WORKING_RE) or 0)
        total = int(_extract(text, _TOTAL_RE) or 0)
        state = _extract(text, _STATE_RE) or "unknown"
        rebuild = _extract(text, _REBUILD_RE)
        pct = None
        if rebuild:
            pm = _PCT_RE.search(rebuild)
            if pm:
                pct = int(pm.group(1))
        return {
            "device": device,
            "level": (_extract(text, _LEVEL_RE) or "unknown"),
            "state": state,
            "health": _derive_health(state=state, failed=failed, rebuild=rebuild),
            "working_devices": working,
            "failed_devices": failed,
            "total_devices": total,
            "rebuild_status": rebuild,
            "rebuild_percent": pct,
        }

    async def list_block_devices(self) -> list[dict]:
        """List physical disks (``lsblk`` type=disk) — candidates for an array."""
        if not shutil.which("lsblk"):
            return []
        try:
            proc = await asyncio.create_subprocess_exec(
                "lsblk", "-d", "-n", "-o", "NAME,SIZE,TYPE,MODEL",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=10)
        except (asyncio.TimeoutError, OSError) as exc:
            log.debug("lsblk failed: %s", exc)
            return []
        devices: list[dict] = []
        for line in stdout.decode(errors="replace").splitlines():
            parts = line.split(None, 3)
            if len(parts) >= 3 and parts[2] == "disk":
                devices.append({
                    "name": f"/dev/{parts[0]}",
                    "size": parts[1],
                    "model": parts[3].strip() if len(parts) > 3 else "",
                })
        return devices


# Module singleton — cheap, stateless.
raid_service = RaidService()
