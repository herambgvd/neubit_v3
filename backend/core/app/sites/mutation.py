"""The one way a sites row is mutated from a request body.

Site, Floor, Zone and DevicePlacement all update the same way: dump the request
model and `setattr` every key onto the loaded row. That loop writes whatever the
schema happens to carry, which makes the schema — not the service — the thing
deciding what is mutable. Today `UpdateFloorRequest` omits `site_id` and
`UpdateZoneRequest` omits `site_id`/`floor_id`, so the loop is safe; it is safe by
accident, and adding one field to a schema for an unrelated reason would silently
turn it into a cross-tenant re-parenting bug. That is exactly how `SiteService.update`
came to accept a `parent_id` it never checked while `create` checked it (36a7798).

So the immutable set is written down HERE, next to the loop, rather than being
implied by the absence of a field somewhere else. A key in it never reaches the row:
it is refused loudly, because a request asking to move a floor to another site is a
request the API does not serve and silently dropping it would report success for
something that did not happen.

Ownership keys (`tenant_id`) and identity keys (the row's own id) are refused for
every model. Structural parents (`site_id`, `floor_id`) are refused because
re-parenting is a move, and a move needs its own validated endpoint — it has to vet
the destination's tenancy, which a blind field write cannot.

`SiteService.parent_id` is deliberately NOT here: re-parenting a site IS supported,
and it goes through `_require_assignable_parent` before this helper runs.
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
