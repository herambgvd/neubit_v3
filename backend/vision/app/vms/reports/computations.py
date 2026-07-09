"""Operational report computations (P6-B) — pure, tenant-scoped DB aggregations.

Each ``compute_*`` returns a plain report dict (``{kind, window, rows, totals, ...}``)
derived entirely from vision's own tables — no ffmpeg, no network. The report kinds map
to the VMS operational surfaces:

  * ``camera-uptime``      — online % per camera over the window (from CameraHealth samples).
  * ``recording-coverage`` — recorded seconds vs expected wall-clock per camera (Recording).
  * ``storage-usage``      — bytes used per StoragePool + total (Recording sizes by pool).
  * ``event-stats``        — VmsEvent counts by type / severity / camera.
  * ``health-summary``     — a one-shot roll-up (current status + 24h event/error counts).

Every query is tenant-scoped via ``kernel.auth.scoped`` (super-admin sees all tenants).
An optional ``camera_id`` filter narrows to one camera. Graceful: an empty window yields a
report with zero rows (not an error) so a scheduled report on a quiet estate still delivers.

Ported concepts from ``gvd_nvr`` (uptime/coverage/storage dashboards) to the v3 tenant-
scoped ORM. Pure + individually unit-testable (each takes an ``AsyncSession`` + ``Scope``).
"""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from kernel.auth import Scope, scoped

from app.vms.models import Camera, CameraHealth, Recording, StoragePool, VmsEvent

REPORT_KINDS = (
    "camera-uptime",
    "recording-coverage",
    "storage-usage",
    "event-stats",
    "health-summary",
)


def _aware(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=timezone.utc)


def _iso(dt: datetime | None) -> str | None:
    d = _aware(dt)
    return d.astimezone(timezone.utc).isoformat() if d else None


async def _cameras(db: AsyncSession, scope: Scope, camera_id: str | None) -> list[Camera]:
    stmt = scoped(select(Camera), Camera, scope)
    if camera_id:
        stmt = stmt.where(Camera.id == camera_id)
    return list((await db.execute(stmt.order_by(Camera.name.asc()))).scalars().all())


def _window(from_: datetime, to: datetime) -> dict:
    return {"from": _iso(from_), "to": _iso(to), "seconds": max(0.0, (to - from_).total_seconds())}


# ── camera-uptime ────────────────────────────────────────────────────────────────
async def compute_camera_uptime(
    db: AsyncSession, scope: Scope, from_: datetime, to: datetime, camera_id: str | None
) -> dict:
    """Online % per camera = online samples / total samples in the window."""
    cams = await _cameras(db, scope, camera_id)
    rows = []
    for cam in cams:
        base = (
            scoped(select(CameraHealth.status), CameraHealth, scope)
            .where(CameraHealth.camera_id == cam.id)
            .where(CameraHealth.captured_at >= from_)
            .where(CameraHealth.captured_at < to)
        )
        total = (
            await db.execute(select(func.count()).select_from(base.subquery()))
        ).scalar_one()
        online = (
            await db.execute(
                select(func.count()).select_from(
                    base.where(CameraHealth.status == "online").subquery()
                )
            )
        ).scalar_one()
        pct = round(100.0 * online / total, 2) if total else 0.0
        rows.append({
            "camera_id": cam.id,
            "camera_name": cam.name,
            "samples": int(total),
            "online_samples": int(online),
            "uptime_pct": pct,
        })
    avg = round(sum(r["uptime_pct"] for r in rows) / len(rows), 2) if rows else 0.0
    return {
        "kind": "camera-uptime",
        "window": _window(from_, to),
        "rows": rows,
        "totals": {"cameras": len(rows), "avg_uptime_pct": avg},
    }


# ── recording-coverage ───────────────────────────────────────────────────────────
async def compute_recording_coverage(
    db: AsyncSession, scope: Scope, from_: datetime, to: datetime, camera_id: str | None
) -> dict:
    """Recorded seconds (clamped to the window) vs expected wall-clock, per camera."""
    cams = await _cameras(db, scope, camera_id)
    expected = max(0.0, (to - from_).total_seconds())
    rows = []
    for cam in cams:
        recs = (
            await db.execute(
                scoped(
                    select(Recording.start_time, Recording.end_time, Recording.file_size),
                    Recording,
                    scope,
                )
                .where(Recording.camera_id == cam.id)
                .where(Recording.start_time < to)
                .where((Recording.end_time.is_(None)) | (Recording.end_time > from_))
            )
        ).all()
        recorded = 0.0
        total_bytes = 0
        for start, end, size in recs:
            s = max(_aware(start), from_)
            e = min(_aware(end) or to, to)
            if e > s:
                recorded += (e - s).total_seconds()
            total_bytes += int(size or 0)
        recorded = min(recorded, expected)  # overlaps can't exceed the window
        pct = round(100.0 * recorded / expected, 2) if expected else 0.0
        rows.append({
            "camera_id": cam.id,
            "camera_name": cam.name,
            "expected_seconds": round(expected, 1),
            "recorded_seconds": round(recorded, 1),
            "coverage_pct": pct,
            "segments": len(recs),
            "bytes": total_bytes,
        })
    avg = round(sum(r["coverage_pct"] for r in rows) / len(rows), 2) if rows else 0.0
    return {
        "kind": "recording-coverage",
        "window": _window(from_, to),
        "rows": rows,
        "totals": {
            "cameras": len(rows),
            "avg_coverage_pct": avg,
            "total_bytes": sum(r["bytes"] for r in rows),
        },
    }


# ── storage-usage ────────────────────────────────────────────────────────────────
async def compute_storage_usage(
    db: AsyncSession, scope: Scope, from_: datetime, to: datetime, camera_id: str | None
) -> dict:
    """Bytes + segment count per StoragePool (+ an unpooled bucket) + a grand total.

    Sums ``Recording.file_size`` grouped by ``storage_pool_id`` over recordings CREATED
    in the window (the growth in that period), tenant-scoped. Pool names are resolved
    from StoragePool; recordings with no pool land under ``(unpooled)``.
    """
    pools = {
        p.id: p
        for p in (await db.execute(scoped(select(StoragePool), StoragePool, scope))).scalars().all()
    }
    stmt = (
        scoped(
            select(
                Recording.storage_pool_id,
                func.count().label("segments"),
                func.coalesce(func.sum(Recording.file_size), 0).label("bytes"),
            ),
            Recording,
            scope,
        )
        .where(Recording.created_at >= from_)
        .where(Recording.created_at < to)
        .group_by(Recording.storage_pool_id)
    )
    if camera_id:
        stmt = stmt.where(Recording.camera_id == camera_id)
    grouped = (await db.execute(stmt)).all()
    rows = []
    for pool_id, segments, byts in grouped:
        pool = pools.get(pool_id)
        rows.append({
            "pool_id": pool_id,
            "pool_name": pool.name if pool else ("(unpooled)" if pool_id is None else pool_id),
            "pool_type": pool.pool_type if pool else None,
            "max_size_bytes": pool.max_size_bytes if pool else None,
            "segments": int(segments),
            "bytes": int(byts),
        })
    rows.sort(key=lambda r: r["bytes"], reverse=True)
    return {
        "kind": "storage-usage",
        "window": _window(from_, to),
        "rows": rows,
        "totals": {
            "pools": len(rows),
            "total_bytes": sum(r["bytes"] for r in rows),
            "total_segments": sum(r["segments"] for r in rows),
        },
    }


# ── event-stats ──────────────────────────────────────────────────────────────────
async def compute_event_stats(
    db: AsyncSession, scope: Scope, from_: datetime, to: datetime, camera_id: str | None
) -> dict:
    """VmsEvent counts by type, by severity, and by camera over the window."""
    def _base():
        s = (
            scoped(select(VmsEvent), VmsEvent, scope)
            .where(VmsEvent.occurred_at >= from_)
            .where(VmsEvent.occurred_at < to)
        )
        return s.where(VmsEvent.camera_id == camera_id) if camera_id else s

    async def _group(col):
        stmt = (
            scoped(select(col, func.count().label("n")), VmsEvent, scope)
            .where(VmsEvent.occurred_at >= from_)
            .where(VmsEvent.occurred_at < to)
            .group_by(col)
        )
        if camera_id:
            stmt = stmt.where(VmsEvent.camera_id == camera_id)
        return {(k if k is not None else "(none)"): int(n) for k, n in (await db.execute(stmt)).all()}

    by_type = await _group(VmsEvent.event_type)
    by_severity = await _group(VmsEvent.severity)
    by_camera = await _group(VmsEvent.camera_id)
    total = (
        await db.execute(select(func.count()).select_from(_base().subquery()))
    ).scalar_one()

    # Resolve camera ids → names for the by-camera breakdown.
    cam_names = {
        c.id: c.name
        for c in (await db.execute(scoped(select(Camera), Camera, scope))).scalars().all()
    }
    rows = [
        {"camera_id": cid, "camera_name": cam_names.get(cid, cid), "events": n}
        for cid, n in sorted(by_camera.items(), key=lambda kv: kv[1], reverse=True)
    ]
    return {
        "kind": "event-stats",
        "window": _window(from_, to),
        "rows": rows,
        "by_type": by_type,
        "by_severity": by_severity,
        "totals": {"total_events": int(total)},
    }


# ── health-summary ───────────────────────────────────────────────────────────────
async def compute_health_summary(
    db: AsyncSession, scope: Scope, from_: datetime, to: datetime, camera_id: str | None
) -> dict:
    """A one-shot estate roll-up: camera status counts + window event/error tallies."""
    cams = await _cameras(db, scope, camera_id)
    status_counts: dict[str, int] = {}
    for cam in cams:
        status_counts[cam.status] = status_counts.get(cam.status, 0) + 1

    ev = await compute_event_stats(db, scope, from_, to, camera_id)
    by_sev = ev.get("by_severity", {})
    return {
        "kind": "health-summary",
        "window": _window(from_, to),
        "rows": [
            {"metric": "cameras_total", "value": len(cams)},
            {"metric": "cameras_online", "value": status_counts.get("online", 0)},
            {"metric": "cameras_offline", "value": status_counts.get("offline", 0)},
            {"metric": "events_total", "value": ev["totals"]["total_events"]},
            {"metric": "events_critical", "value": by_sev.get("critical", 0)},
            {"metric": "events_alarm", "value": by_sev.get("alarm", 0)},
        ],
        "status_counts": status_counts,
        "totals": {"cameras": len(cams), "events": ev["totals"]["total_events"]},
    }


_COMPUTE = {
    "camera-uptime": compute_camera_uptime,
    "recording-coverage": compute_recording_coverage,
    "storage-usage": compute_storage_usage,
    "event-stats": compute_event_stats,
    "health-summary": compute_health_summary,
}


async def compute_report(
    kind: str,
    db: AsyncSession,
    scope: Scope,
    from_: datetime,
    to: datetime,
    camera_id: str | None = None,
) -> dict:
    """Dispatch to the right ``compute_*`` for ``kind`` (raises ValueError if unknown)."""
    fn = _COMPUTE.get(kind)
    if fn is None:
        raise ValueError(f"unknown report kind: {kind}")
    return await fn(db, scope, from_, to, camera_id)
