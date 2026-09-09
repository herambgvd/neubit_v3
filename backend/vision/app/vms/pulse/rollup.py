"""Turning per-recorder System-Monitor boards into one estate answer.

PURE. Every function here takes payloads and returns payloads, so the roll-up can
be tested without a node, a database or a network — which matters because the
interesting cases are the honest ones (a recorder that did not answer, a volume
whose usage could not be read, a camera whose link was never sampled), and those
are exactly the cases a live test cannot produce on demand.

THE RULE THE WHOLE FILE EXISTS TO KEEP: an estate figure must never be smoothed
over a recorder that did not answer. `109 of 112 cameras online` computed from two
recorders when three are enrolled is a lie of the worst kind — it looks precise.
So the totals count ONLY the recorders that answered, `partial` says whether any
did not, and the ones that did not are named. The node itself follows the same
discipline internally: it marks what it cannot measure `unmeasured` rather than
substituting a zero, and nothing here converts that back into a number.
"""

from __future__ import annotations

from typing import Any

# A volume this full is worth an operator's attention before it starts recycling
# footage they meant to keep. Not a failure — a warning with a number attached.
VOLUME_WARN_PCT = 85.0
VOLUME_CRITICAL_PCT = 95.0


def _num(value: Any) -> float | None:
    """A finite number, or None. Strings and nulls from a node payload never
    become 0 — a missing reading is not a reading of zero."""
    if isinstance(value, bool) or value is None:
        return None
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    return out if out == out and out not in (float("inf"), float("-inf")) else None


def volume_used_pct(volume: dict) -> float | None:
    """A volume's used percentage from the node's own usage block, or None.

    None covers both shapes the node sends for "I could not read this": a
    `usage_error` string instead of a usage object (an S3 pool, a path that does
    not statfs), and a usage object without the fields to compute from.
    """
    usage = volume.get("usage")
    if not isinstance(usage, dict):
        return None
    pct = _num(usage.get("used_percent"))
    if pct is not None:
        return pct
    total, used = _num(usage.get("total_bytes")), _num(usage.get("used_bytes"))
    if total and total > 0 and used is not None:
        return used / total * 100.0
    return None


def node_view(node_id: str, node_name: str, board: dict) -> dict:
    """One recorder's row in the estate view, from its sysmon board.

    A projection, not a copy: the board carries per-camera rows and a full license
    block that the estate strip has no room for and no use for. The drill-down
    route serves the whole board when an operator opens one recorder.
    """
    cameras = board.get("cameras") if isinstance(board.get("cameras"), dict) else {}
    verdict = board.get("verdict") if isinstance(board.get("verdict"), dict) else {}
    volumes = [v for v in (board.get("volumes") or []) if isinstance(v, dict)]

    return {
        "node_id": node_id,
        "node_name": node_name,
        "reachable": True,
        "generated_at": board.get("generated_at"),
        "verdict": {
            "level": verdict.get("level"),
            "headline": verdict.get("headline"),
            "detail": verdict.get("detail"),
        },
        "engine": board.get("engine") or {},
        # `sensors_reported` False means the box reported no usable hardware
        # sample. The system block then holds zeros, and a reader that ignores
        # this flag prints "0% CPU, 0°C" for a machine it never measured.
        "system": board.get("system") or {},
        "sensors_reported": bool(board.get("sensors_reported")),
        "retention_default_days": board.get("retention_default_days"),
        "cameras": {
            "total": int(cameras.get("total") or 0),
            "online": int(cameras.get("online") or 0),
            "recording_active": int(cameras.get("recording_active") or 0),
            # Tri-state on purpose: True/False are measurements, None means
            # nothing is recording so there is nothing to be gap-free about.
            "recording_gap_free": cameras.get("recording_gap_free"),
        },
        "volumes": [
            {
                "name": v.get("name"),
                "path": v.get("path"),
                "pool_type": v.get("pool_type"),
                "is_default": bool(v.get("is_default")),
                "used_percent": volume_used_pct(v),
                "usage": v.get("usage"),
                "usage_error": v.get("usage_error"),
            }
            for v in volumes
        ],
    }


def offline_cameras(node_id: str, node_name: str, board: dict) -> list[dict]:
    """The cameras this recorder says are not online, NAMED.

    A count tells an operator something is wrong; a name tells them where to go.
    Disabled cameras are left out — an operator took them out of service, so they
    are not a fault, and listing them buries the three that are.
    """
    cameras = board.get("cameras") if isinstance(board.get("cameras"), dict) else {}
    out = []
    for row in cameras.get("items") or []:
        if not isinstance(row, dict) or not row.get("enabled", True):
            continue
        if str(row.get("status") or "").lower() == "online":
            continue
        out.append({
            "camera_id": row.get("id"),
            "name": row.get("name"),
            "node_id": node_id,
            "node_name": node_name,
            "status": row.get("status"),
            "last_seen_at": row.get("last_seen_at"),
            "last_error": row.get("last_error"),
        })
    return out


def attention_items(nodes: list[dict], offline: list[dict], unreachable: list[dict]) -> list[dict]:
    """What needs an operator, worst first.

    Ranked by operational impact, which is not the same as by severity of the
    word used: a recorder nobody can reach outranks a full disk, because while it
    is unreachable every other number about it is unknown too.
    """
    items: list[dict] = []

    for node in unreachable:
        items.append({
            "severity": "critical",
            "kind": "recorder_unreachable",
            "item": f"{node.get('name')} did not answer",
            "where": node.get("name"),
            "detail": node.get("error"),
        })

    for node in nodes:
        level = str((node.get("verdict") or {}).get("level") or "").lower()
        if level == "down":
            items.append({
                "severity": "critical",
                "kind": "recorder_down",
                "item": (node["verdict"].get("headline") or "Recorder engine down"),
                "where": node["node_name"],
                "detail": node["verdict"].get("detail"),
            })
        elif level == "degraded":
            items.append({
                "severity": "warning",
                "kind": "recorder_degraded",
                "item": (node["verdict"].get("headline") or "Recorder degraded"),
                "where": node["node_name"],
                "detail": node["verdict"].get("detail"),
            })
        # Recording that is NOT gap-free is its own line: the recorder can be
        # green, every camera online, and footage still be missing.
        if node["cameras"].get("recording_gap_free") is False:
            items.append({
                "severity": "critical",
                "kind": "recording_gaps",
                "item": "Footage is not being written continuously",
                "where": node["node_name"],
                "detail": f"{node['cameras'].get('recording_active') or 0} camera(s) recording",
            })
        for vol in node.get("volumes") or []:
            pct = vol.get("used_percent")
            if pct is None:
                if vol.get("usage_error"):
                    items.append({
                        "severity": "warning",
                        "kind": "volume_unreadable",
                        "item": f"Storage usage unreadable — {vol.get('name')}",
                        "where": node["node_name"],
                        "detail": vol.get("usage_error"),
                    })
                continue
            if pct >= VOLUME_CRITICAL_PCT:
                items.append({
                    "severity": "critical", "kind": "volume_full",
                    "item": f"{vol.get('name')} is {pct:.0f}% full",
                    "where": node["node_name"],
                    "detail": vol.get("path"),
                })
            elif pct >= VOLUME_WARN_PCT:
                items.append({
                    "severity": "warning", "kind": "volume_high",
                    "item": f"{vol.get('name')} is {pct:.0f}% full",
                    "where": node["node_name"],
                    "detail": vol.get("path"),
                })

    for cam in offline:
        items.append({
            "severity": "warning",
            "kind": "camera_offline",
            "item": f"{cam.get('name') or cam.get('camera_id')} is {cam.get('status') or 'offline'}",
            "where": cam.get("node_name"),
            "detail": cam.get("last_error"),
            "camera_id": cam.get("camera_id"),
            "node_id": cam.get("node_id"),
        })

    order = {"critical": 0, "warning": 1, "info": 2}
    items.sort(key=lambda i: order.get(i["severity"], 9))
    return items


def overview(node_views: list[dict], unreachable: list[dict], offline: list[dict]) -> dict:
    """The whole estate answer.

    `partial` is the load-bearing field. With it, a console can say "3 of 4
    recorders answered" above the totals; without it the same totals read as the
    whole estate, and the missing recorder's cameras silently stop existing.
    """
    totals = {
        "recorders": len(node_views) + len(unreachable),
        "recorders_answered": len(node_views),
        "cameras_total": sum(n["cameras"]["total"] for n in node_views),
        "cameras_online": sum(n["cameras"]["online"] for n in node_views),
        "cameras_recording": sum(n["cameras"]["recording_active"] for n in node_views),
    }
    gap_flags = [n["cameras"]["recording_gap_free"] for n in node_views]
    measured = [g for g in gap_flags if g is not None]
    # Tri-state again, and the False branch wins: one recorder with gaps makes the
    # estate answer False even while the others are writing perfectly.
    totals["recording_gap_free"] = (
        None if not measured else (False if False in measured else True)
    )

    used = [v["used_percent"] for n in node_views for v in n["volumes"] if v["used_percent"] is not None]
    retentions = [n["retention_default_days"] for n in node_views if isinstance(n["retention_default_days"], int)]

    return {
        "partial": bool(unreachable),
        "totals": totals,
        "storage": {
            "worst_used_percent": max(used) if used else None,
            "volumes_measured": len(used),
            "volumes_total": sum(len(n["volumes"]) for n in node_views),
            # The shortest default retention across the estate: the horizon an
            # operator can actually promise, not an average nobody can act on.
            "retention_days_min": min(retentions) if retentions else None,
        },
        "nodes": node_views,
        "unreachable": unreachable,
        "offline_cameras": offline,
        "attention": attention_items(node_views, offline, unreachable),
    }
