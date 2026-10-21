"""Each recorder's cameras, kept for when the recorder is not there to ask (SCRUM-334).

Written by the node heartbeat, which already reads every recorder's full camera list
each cycle. Read by the estate camera list for any recorder that is down, so its
cameras stay on every screen — marked offline, with the reason — instead of
disappearing until it comes back. See ``models/node_camera.py`` for why.
"""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.vms.federation.client import ESTATE_CAMERA_PAGE
from app.vms.models import MediaNode, NodeCamera

# Why a camera that reads offline is offline when the camera is not the reason.
RECORDER_OFFLINE = "recorder_offline"  # the heartbeat has the recorder down
RECORDER_UNREACHABLE = "recorder_unreachable"  # it is up, but this read failed


def _listed(cameras: list[dict]) -> dict[str, dict]:
    """The recorder's cameras by their id on the recorder, first copy of each."""
    out: dict[str, dict] = {}
    for cam in cameras:
        remote_id = str(cam.get("id") or "").strip() if isinstance(cam, dict) else ""
        if remote_id and remote_id not in out:
            out[remote_id] = cam
    return out


async def sync_node_cameras(db: AsyncSession, node: MediaNode, cameras: list[dict]) -> None:
    """Make the stored copy of ``node``'s cameras match the list it just served.

    Does not commit; the heartbeat owns the transaction. A camera the recorder no
    longer lists is removed, but only when the list could not have been cut short:
    a full page proves nothing about what lies past it.
    """
    now = datetime.now(timezone.utc)
    stored = {
        row.remote_id: row
        for row in (
            await db.execute(select(NodeCamera).where(NodeCamera.node_id == node.id))
        ).scalars()
    }
    listed = _listed(cameras)
    for remote_id, cam in listed.items():
        row = stored.get(remote_id)
        if row is None:
            row = NodeCamera(node_id=node.id, remote_id=remote_id)
            db.add(row)
        row.tenant_id = node.tenant_id
        row.name = str(cam.get("name") or "")[:255]
        row.data = dict(cam)
        row.synced_at = now
    if len(cameras) >= ESTATE_CAMERA_PAGE:
        return
    for remote_id, row in stored.items():
        if remote_id not in listed:
            await db.delete(row)


async def stored_cameras(db: AsyncSession, node_ids: list[str]) -> dict[str, list[NodeCamera]]:
    """The stored cameras of each node in ``node_ids``, by node id."""
    out: dict[str, list[NodeCamera]] = {}
    if not node_ids:
        return out
    rows = (
        await db.execute(select(NodeCamera).where(NodeCamera.node_id.in_(node_ids)))
    ).scalars()
    for row in rows:
        out.setdefault(row.node_id, []).append(row)
    return out


def _channel_key(row: NodeCamera) -> tuple:
    channel = (row.data or {}).get("channel_number")
    return (channel if isinstance(channel, int) else 1 << 30, row.name.lower(), row.remote_id)


def offline_rows(node: MediaNode, rows: list[NodeCamera], reason: str) -> list[dict]:
    """``node``'s stored cameras in the estate list's shape, as cameras that cannot
    be reached: ``status`` offline (so nothing dials them), plus why, and how old the
    copy is."""
    out: list[dict] = []
    for row in sorted(rows, key=_channel_key):
        cam = dict(row.data or {})
        cam.update(
            id=row.remote_id,
            name=row.name or cam.get("name") or row.remote_id,
            status="offline",
            node_id=str(node.id),
            node_name=node.name,
            node_reachable=False,
            status_reason=reason,
            last_synced_at=row.synced_at.isoformat() if row.synced_at else None,
        )
        out.append(cam)
    return out


__all__ = [
    "RECORDER_OFFLINE",
    "RECORDER_UNREACHABLE",
    "offline_rows",
    "stored_cameras",
    "sync_node_cameras",
]
