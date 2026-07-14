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

from app.vms.models import (
    Bookmark,
    Camera,
    CameraHealth,
    EvidenceLock,
    ExportJob,
    MotionSearchJob,
    Recording,
    StoragePool,
    VmsEvent,
)

REPORT_KINDS = (
    "camera-uptime",
    "recording-coverage",
    "storage-usage",
    "event-stats",
    "health-summary",
    "operator-activity",
    "alarm-response",
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


# ── operator-activity ─────────────────────────────────────────────────────────────
async def compute_operator_activity(
    db: AsyncSession, scope: Scope, from_: datetime, to: datetime, camera_id: str | None
) -> dict:
    """Per-operator activity rollup over the window, from VISION's own actor-stamped rows.

    SOURCE — HONESTY NOTE: the full operator audit trail (logins, config changes, PTZ,
    playback, evidence access) lives in CORE's tenant-scoped ``audit_log`` (the P6-D
    ``security/audit/video`` events vision POSTs there are recorded in core). Vision cannot
    query core's DB directly, so this report aggregates ONLY the operator actions that
    leave an actor-stamped row in vision's OWN tables:

      * ``export``        — ExportJob.requested_by     (clip exports)
      * ``motion_search`` — MotionSearchJob.requested_by (forensic searches)
      * ``bookmark``      — Bookmark.created_by        (marked moments)
      * ``evidence_lock`` — EvidenceLock.created_by    (legal holds placed)
      * ``evidence_release``— EvidenceLock.released_by (legal holds released)
      * ``event_ack``     — VmsEvent.acknowledged_by   (alarms acknowledged)

    Each row is one operator with a per-action breakdown + a total. This is an operator-
    ACTIVITY rollup of what vision can see; for the complete audit (logins / config / raw
    playback) the frontend should link to core's Activity log. Tenant-scoped; an optional
    ``camera_id`` narrows the camera-bearing sources (bookmarks/exports/motion/evidence/
    event-ack). Empty window → zero rows (not an error).
    """
    # (action_label, model, actor_column, time_column, has_camera)
    sources = [
        ("export", ExportJob, ExportJob.requested_by, ExportJob.created_at, True),
        ("motion_search", MotionSearchJob, MotionSearchJob.requested_by, MotionSearchJob.created_at, True),
        ("bookmark", Bookmark, Bookmark.created_by, Bookmark.created_at, True),
        ("evidence_lock", EvidenceLock, EvidenceLock.created_by, EvidenceLock.created_at, True),
        ("evidence_release", EvidenceLock, EvidenceLock.released_by, EvidenceLock.released_at, True),
        ("event_ack", VmsEvent, VmsEvent.acknowledged_by, VmsEvent.acknowledged_at, True),
    ]
    # operator -> {action -> count}
    by_operator: dict[str, dict[str, int]] = {}
    action_totals: dict[str, int] = {}
    for action, model, actor_col, time_col, has_cam in sources:
        stmt = (
            scoped(select(actor_col, func.count().label("n")), model, scope)
            .where(actor_col.is_not(None))
            .where(time_col >= from_)
            .where(time_col < to)
            .group_by(actor_col)
        )
        if camera_id and has_cam:
            stmt = stmt.where(model.camera_id == camera_id)
        for operator, n in (await db.execute(stmt)).all():
            key = str(operator)
            by_operator.setdefault(key, {})[action] = int(n)
            action_totals[action] = action_totals.get(action, 0) + int(n)

    rows = []
    for operator, actions in by_operator.items():
        total = sum(actions.values())
        rows.append({
            "operator": operator,
            "total_actions": total,
            "exports": actions.get("export", 0),
            "motion_searches": actions.get("motion_search", 0),
            "bookmarks": actions.get("bookmark", 0),
            "evidence_locks": actions.get("evidence_lock", 0),
            "evidence_releases": actions.get("evidence_release", 0),
            "event_acks": actions.get("event_ack", 0),
        })
    rows.sort(key=lambda r: r["total_actions"], reverse=True)
    return {
        "kind": "operator-activity",
        "window": _window(from_, to),
        "rows": rows,
        "by_action": action_totals,
        "totals": {
            "operators": len(rows),
            "total_actions": sum(action_totals.values()),
        },
        "source_note": (
            "Aggregated from vision's actor-stamped rows (exports, motion searches, "
            "bookmarks, evidence locks/releases, event acks). The full operator audit "
            "trail (logins, config changes, raw playback) lives in core's Activity log."
        ),
    }


# ── alarm-response ────────────────────────────────────────────────────────────────
async def compute_alarm_response(
    db: AsyncSession, scope: Scope, from_: datetime, to: datetime, camera_id: str | None
) -> dict:
    """Alarm acknowledgement analytics over the window, from VISION's ``VmsEvent`` rows.

    SOURCE — HONESTY NOTE: workflow owns full incident lifecycle (assignment, resolution,
    escalation); vision does NOT own incidents. What vision CAN see is the raw camera/
    system event with its ``acknowledged`` / ``acknowledged_at`` fields, so this report
    computes ack-rate + time-to-ack (occurred_at → acknowledged_at) from ``VmsEvent``. It
    only covers alarm-tier events (severity in alarm|critical) — the operator-actionable
    ones. For full incident response-time analytics (assign→resolve) the frontend should
    use workflow's incident reports; this is the camera-side ack view vision derives.

    Rows = per-camera ack stats; ``by_severity`` + top-level totals give the estate view.
    Time-to-ack is in seconds (avg / max over acknowledged alarm events). Tenant-scoped;
    optional ``camera_id`` narrows to one camera. Empty window → zero rows.
    """
    ALARM_SEVERITIES = ("alarm", "critical")

    def _alarm_base():
        s = (
            scoped(select(VmsEvent), VmsEvent, scope)
            .where(VmsEvent.occurred_at >= from_)
            .where(VmsEvent.occurred_at < to)
            .where(VmsEvent.severity.in_(ALARM_SEVERITIES))
        )
        return s.where(VmsEvent.camera_id == camera_id) if camera_id else s

    events = list((await db.execute(_alarm_base())).scalars().all())

    # Per-camera aggregation + global time-to-ack samples.
    per_cam: dict[str, dict] = {}
    ttas: list[float] = []  # time-to-ack seconds (global)
    by_severity: dict[str, dict[str, int]] = {}
    for ev in events:
        cid = ev.camera_id or "(system)"
        cam = per_cam.setdefault(cid, {"alarms": 0, "acked": 0, "tta": []})
        cam["alarms"] += 1
        sev = by_severity.setdefault(ev.severity, {"alarms": 0, "acked": 0})
        sev["alarms"] += 1
        if ev.acknowledged:
            cam["acked"] += 1
            sev["acked"] += 1
            occurred = _aware(ev.occurred_at)
            acked_at = _aware(ev.acknowledged_at)
            if occurred and acked_at and acked_at >= occurred:
                secs = (acked_at - occurred).total_seconds()
                cam["tta"].append(secs)
                ttas.append(secs)

    # Resolve camera names.
    cam_names = {
        c.id: c.name
        for c in (await db.execute(scoped(select(Camera), Camera, scope))).scalars().all()
    }
    rows = []
    for cid, agg in per_cam.items():
        acked = agg["acked"]
        alarms = agg["alarms"]
        tta = agg["tta"]
        rows.append({
            "camera_id": cid,
            "camera_name": cam_names.get(cid, cid),
            "alarms": alarms,
            "acknowledged": acked,
            "unacknowledged": alarms - acked,
            "ack_rate_pct": round(100.0 * acked / alarms, 2) if alarms else 0.0,
            "avg_time_to_ack_s": round(sum(tta) / len(tta), 1) if tta else None,
            "max_time_to_ack_s": round(max(tta), 1) if tta else None,
        })
    rows.sort(key=lambda r: r["alarms"], reverse=True)

    total_alarms = len(events)
    total_acked = sum(1 for ev in events if ev.acknowledged)
    return {
        "kind": "alarm-response",
        "window": _window(from_, to),
        "rows": rows,
        "by_severity": {
            sev: {
                **counts,
                "ack_rate_pct": round(100.0 * counts["acked"] / counts["alarms"], 2)
                if counts["alarms"] else 0.0,
            }
            for sev, counts in by_severity.items()
        },
        "totals": {
            "alarms": total_alarms,
            "acknowledged": total_acked,
            "unacknowledged": total_alarms - total_acked,
            "ack_rate_pct": round(100.0 * total_acked / total_alarms, 2) if total_alarms else 0.0,
            "avg_time_to_ack_s": round(sum(ttas) / len(ttas), 1) if ttas else None,
            "max_time_to_ack_s": round(max(ttas), 1) if ttas else None,
        },
        "source_note": (
            "Derived from vision's VmsEvent ack fields (alarm/critical severity). Full "
            "incident response-time analytics (assign→resolve) live in the workflow service."
        ),
    }


_COMPUTE = {
    "camera-uptime": compute_camera_uptime,
    "recording-coverage": compute_recording_coverage,
    "storage-usage": compute_storage_usage,
    "event-stats": compute_event_stats,
    "health-summary": compute_health_summary,
    "operator-activity": compute_operator_activity,
    "alarm-response": compute_alarm_response,
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
