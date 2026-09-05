"""Workflow literal types, and the pure rules defined over them.

Kept faithful to neubit_v2: these strings are persisted in DB columns AND are the
literals the REST API accepts and returns, so renaming a member is a data +
contract change, never a tidy-up.

The rules that live here (``is_legal_status_change``, ``bump_priority``) are here
rather than in a service because more than one caller enforces them: the instance
service on a manual status change, and the escalation sweep in the worker. A copy
in each is how the two drift apart.
"""

from __future__ import annotations

from enum import Enum


# ── Enums (kept faithful to neubit_v2) ─────────────────────────────────


class InstancePriority(str, Enum):
    CRITICAL = "critical"
    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"


# neubit_v2 uses PENDING/ACTIVE/PAUSED/COMPLETED/CANCELLED. The v3 task spec calls
# for pending|active|paused|resolved|cancelled — RESOLVED replaces COMPLETED.
class InstanceStatus(str, Enum):
    PENDING = "pending"
    ACTIVE = "active"
    PAUSED = "paused"
    RESOLVED = "resolved"
    CANCELLED = "cancelled"


# The terminal / closed statuses (no further mutation allowed).
CLOSED_STATUSES = {InstanceStatus.RESOLVED, InstanceStatus.CANCELLED}


# Legal manual status-machine edges (used by InstanceService.change_status).
# PENDING → ACTIVE/CANCELLED; ACTIVE ↔ PAUSED; ACTIVE/PAUSED → RESOLVED/CANCELLED;
# terminal states (RESOLVED/CANCELLED) can't change. A no-op (X → X) is always
# allowed. transition()/escalate() drive status via their own machine and are not
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

