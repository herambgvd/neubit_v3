"""Which console a registered dashboard belongs to.

A registration is a pointer, and until now every pointer landed in one
undifferentiated list: the Building Intelligence dashboards, the surveillance
ones and the access ones were one strip an operator read top to bottom. The
category is what segregates them, so each console shows its own.

CLOSED SET, deliberately. A free-text category would let a typo ("vms " / "VMS"
/ "cctv") create a bucket that no console tab names, and a dashboard filed there
is registered, listed by nothing, and reachable only by its direct link. Every
value here is named by a tab on the viewer, so a category is always somewhere an
operator can get to — the same rule the rest of the console holds settings to.

Adding one means adding it HERE and to the frontend's CATEGORIES (see
`frontend/src/features/dashforge/constants.ts`); the contract test that reads
both files fails if they drift.
"""

from __future__ import annotations

# slug → what an operator sees. Order is the order the tabs render in.
DASHBOARD_CATEGORIES: dict[str, str] = {
    "building": "Building Intelligence",
    "vms": "Surveillance",
    "access": "Access Control",
    "workflow": "Workflow",
    "general": "General",
}

# What a registration gets when nobody chose: visible under "General" rather than
# hidden. A NULL/absent category that fell through every tab would be a dashboard
# nobody can find from the console.
DEFAULT_CATEGORY = "general"


def normalize(value: str | None) -> str:
    """Trim + lowercase a category, or raise ValueError naming the valid set."""
    slug = (value or "").strip().lower() or DEFAULT_CATEGORY
    if slug not in DASHBOARD_CATEGORIES:
        valid = ", ".join(DASHBOARD_CATEGORIES)
        raise ValueError(f"unknown category '{slug}' — one of: {valid}")
    return slug
