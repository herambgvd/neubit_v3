"""The one way a sites row is mutated from a request body.

Site, Floor, Zone and DevicePlacement all update by dumping the request model and
`setattr`-ing every key onto the loaded row, which leaves the schema deciding what
is mutable. Adding one field to a schema for an unrelated reason would then quietly
become a cross-tenant re-parenting bug, so the immutable set is written down here,
next to the loop. A key in it is refused loudly rather than dropped.

Ownership keys (`tenant_id`) and identity keys (the row's own id) are refused for
every model. Structural parents (`site_id`, `floor_id`) are refused because
re-parenting is a move, and a move needs an endpoint that vets the destination's
tenancy — a blind field write cannot.

`Site.parent_id` is deliberately not here: re-parenting a site is supported and
goes through `_require_assignable_parent` before this helper runs.
"""

from __future__ import annotations

from typing import Any

from ..core.errors import ValidationError

#: Never writable through an update body, on any sites row.
IMMUTABLE: frozenset[str] = frozenset(
    {
        "tenant_id",
        "site_id",
        "floor_id",
        "zone_id",
        "placement_id",
        "created_by",
        "created_at",
    }
)


def apply_update(row: Any, update: dict[str, Any], *, allow: frozenset[str] = frozenset()) -> None:
    """Write `update` onto `row`, refusing anything in IMMUTABLE.

    `allow` re-permits a specific key for a caller that has already validated it
    (SiteService passes `parent_id` after vetting the destination). Everything else
    raises rather than being dropped.
    """
    forbidden = sorted((set(update) & IMMUTABLE) - allow)
    if forbidden:
        raise ValidationError(
            "these fields cannot be changed through an update: " + ", ".join(forbidden)
        )
    for key, value in update.items():
        setattr(row, key, value)
