"""Workflow literal types, and the pure rules defined over them.

These strings are persisted in DB columns and are also the literals the REST API
accepts and returns, so renaming a member is a data + contract change.

``is_legal_status_change`` and ``bump_priority`` live here rather than in a
service because two callers enforce them: the instance service and the escalation
sweep.
"""

from __future__ import annotations

from enum import Enum


# ── Enums ────────────────────────────────────────────────────────────


class InstancePriority(str, Enum):
    CRITICAL = "critical"
    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"


# RESOLVED is v3's name for what v2 called COMPLETED.
class InstanceStatus(str, Enum):
    PENDING = "pending"
    ACTIVE = "active"
    PAUSED = "paused"
    RESOLVED = "resolved"
    CANCELLED = "cancelled"


# The terminal / closed statuses (no further mutation allowed).
CLOSED_STATUSES = {InstanceStatus.RESOLVED, InstanceStatus.CANCELLED}


# Legal manual status edges, used by InstanceService.change_status. A no-op (X → X)
# is always allowed. transition()/escalate() have their own machine and are not
# gated by this map.
LEGAL_STATUS_EDGES: dict[InstanceStatus, set[InstanceStatus]] = {
    InstanceStatus.PENDING: {InstanceStatus.ACTIVE, InstanceStatus.CANCELLED},
    InstanceStatus.ACTIVE: {
        InstanceStatus.PAUSED,
        InstanceStatus.RESOLVED,
        InstanceStatus.CANCELLED,
    },
    InstanceStatus.PAUSED: {
        InstanceStatus.ACTIVE,
        InstanceStatus.RESOLVED,
        InstanceStatus.CANCELLED,
    },
    InstanceStatus.RESOLVED: set(),
    InstanceStatus.CANCELLED: set(),
}


def is_legal_status_change(current: InstanceStatus, target: InstanceStatus) -> bool:
    """True iff moving current → target is a legal manual status change.

    A no-op (same status) is always legal; otherwise the edge must be in
    ``LEGAL_STATUS_EDGES``. Terminal states have no outgoing edges.
    """
    if current == target:
        return True
    return target in LEGAL_STATUS_EDGES.get(current, set())


class ThreatLevelValue(str, Enum):
    NORMAL = "normal"
    ELEVATED = "elevated"
    HIGH = "high"
    CRITICAL = "critical"
    LOCKDOWN = "lockdown"


class FieldType(str, Enum):
    TEXT = "text"
    TEXTAREA = "textarea"
    NUMBER = "number"
    EMAIL = "email"
    PHONE = "phone"
    DATE = "date"
    DATETIME = "datetime"
    SELECT = "select"
    RADIO = "radio"
    CHECKBOX = "checkbox"
    BOOLEAN = "boolean"
    FILE = "file"
    RATING = "rating"
    MULTISELECT = "multiselect"


# Priority ordering for escalation bumps (low → critical).
PRIORITY_ORDER = [
    InstancePriority.LOW,
    InstancePriority.MEDIUM,
    InstancePriority.HIGH,
    InstancePriority.CRITICAL,
]


def bump_priority(current: InstancePriority, target: InstancePriority) -> InstancePriority:
    """Return the higher of two priorities (never de-escalates)."""
    if PRIORITY_ORDER.index(target) > PRIORITY_ORDER.index(current):
        return target
    return current

