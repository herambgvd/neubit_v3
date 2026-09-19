"""A placement that names a BUILDING and no storey, all the way to BI.

WHY THIS FILE EXISTS. `device_locations.floor_id` has been nullable since the day
it was created: migration 0010 refused to reuse core's `device_placements`
precisely because that table's `floor_id` and `floor_position` are NOT NULL, and
said so in its own docstring. Then the BI-only placement API was deleted in favour
of mirroring `device_placements`, and the restriction came back through the
mirror — `app/api/router.py` recorded it as a known loss: *"a rooftop meter that
belongs to the building and to no storey can no longer be expressed"*. With one
site and almost no floor plans, that was most of the estate.

Core's migration 0031 lifts it at the source of truth, so the floorless event now
ARRIVES here. Nothing in this consumer had to be relaxed to let it through, which
is exactly why it is asserted: "it happens to work" and "it is guaranteed to
work" are not the same thing for a consumer nobody watches.

What is pinned:

  * a placement naming a site and no floor reaches `place_devices` with the site
    and a NULL floor, rather than being skipped as malformed;
  * a placement naming NO SITE is still refused, because a placement that names
    no place is not a placement;
  * `source` — which SURFACE the operator typed it on — is carried onto the row,
    and an unrecognised one falls back instead of being stored;
  * `/bi/summary`'s `unplaced` stays FLOOR-wise, deliberately. A site-only estate
    leaves that number high while `with_site` rises, and that is the honest
    reading of it: those points still cannot answer a floor-wise question.

No database and no NATS. `_apply` decides and `place_devices` is the transaction,
so the transaction is replaced with a recorder and the DECISIONS are what is
asserted — the same shape as `test_site_facts_mirror.py`.
"""

from __future__ import annotations

import asyncio
import uuid

import pytest

from app import placement_sync as ps
from app.api import queries as q

TENANT = "11111111-2222-3333-4444-555555555555"
SITE = "22222222-3333-4444-5555-666666666666"
FLOOR = "33333333-4444-5555-6666-777777777777"
DEVICE = "44444444-5555-6666-7777-888888888888"


def run(coro):
    return asyncio.run(coro)


class _FakeSession:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


class Mirror(ps.PlacementSync):
    """The consumer with its one transaction replaced by a note of what it asked.

    `place_devices` writes `device_locations` and runs the reconcile over
    `points`; asserting it needs Postgres. Everything upstream of it — which
    events apply, what location each one states, and what provenance is put on
    the row — is pure, and it is the half that decides what BI can see.
    """

    def __init__(self):
        super().__init__(ps.PlacementStats())
        self.placed: list[dict] = []
        self.unplaced: list[dict] = []


@pytest.fixture
def mirror(monkeypatch) -> Mirror:
    m = Mirror()

    async def _place(session, tenant, *, device_ids, where, placed_by, source):
        m.placed.append({"tenant": tenant, "device_ids": device_ids, "where": where,
                         "placed_by": placed_by, "source": source})
        return {"devices_placed": len(device_ids), "points_updated": 3,
                "unknown_device_ids": []}

    async def _unplace(session, tenant, *, device_ids):
        m.unplaced.append({"tenant": tenant, "device_ids": device_ids})
        return {"devices_unplaced": len(device_ids), "points_updated": 3}

    monkeypatch.setattr(ps.pl, "place_devices", _place)
    monkeypatch.setattr(ps.pl, "unplace_devices", _unplace)
    monkeypatch.setattr(ps.database, "get_sessionmaker", lambda: _FakeSession)
    return m


def _payload(**over) -> dict:
    body = {
        "tenant_id": TENANT, "device_id": DEVICE, "service": "iot",
        "device_type": "sensor", "site_id": SITE, "site_name": "Aeon Tower",
        "floor_id": None, "floor_name": None, "zone_id": None, "zone_name": None,
        "actor_id": None, "changed": {},
    }
    body.update(over)
    return body


def _apply(mirror: Mirror, payload: dict, event: str = "placed") -> Mirror:
    run(mirror._apply(event, payload, f"tenant.{TENANT}.sites.device_placement.{event}"))
    return mirror


# ── the building, without the storey ─────────────────────────────────────────


def test_a_placement_with_no_floor_is_mirrored_with_a_null_floor(mirror):
    """The whole point. A meter belongs to the building whether or not anyone has
    drawn it, and `device_locations` has always modelled that."""
    _apply(mirror, _payload())
    assert len(mirror.placed) == 1, "a floorless placement was dropped"
    where = mirror.placed[0]["where"]
    assert where.site_id == uuid.UUID(SITE)
    assert where.site_name == "Aeon Tower"
    assert where.floor_id is None
    assert where.floor_name is None
    assert mirror.stats.placed == 1


def test_a_placement_that_names_no_site_is_still_refused(mirror):
    """The site is the placement. A row naming neither would be a device located
    nowhere, recorded as though somebody had said where it is."""
    _apply(mirror, _payload(site_id=None))
    assert mirror.placed == []
    assert mirror.stats.skipped_malformed == 1


def test_a_pin_still_mirrors_its_floor_and_its_zone(mirror):
    """The floor-plan path is untouched; everything else here is additive or it
    is a regression."""
    zone = "55555555-6666-7777-8888-999999999999"
    _apply(mirror, _payload(floor_id=FLOOR, floor_name="Level 4",
                            zone_id=zone, zone_name="Plant room"))
    where = mirror.placed[0]["where"]
    assert where.floor_id == uuid.UUID(FLOOR)
    assert where.floor_name == "Level 4"
    assert where.zone_id == uuid.UUID(zone)
    assert where.zone_name == "Plant room"


def test_a_floorless_placement_of_a_camera_is_still_none_of_this_stores_business(mirror):
    """`service != "iot"` was never about the floor. A camera's id is a VMS id and
    has no meaning in this store."""
    _apply(mirror, _payload(service="vms"))
    assert mirror.placed == []
    assert mirror.stats.skipped_not_iot == 1


def test_a_floorless_placement_can_be_removed_like_any_other(mirror):
    _apply(mirror, _payload(), event="placement_removed")
    assert mirror.unplaced == [{"tenant": uuid.UUID(TENANT),
                                "device_ids": [uuid.UUID(DEVICE)]}]


# ── which surface the operator typed it on ───────────────────────────────────


@pytest.mark.parametrize("surface", sorted(ps._SOURCES))
def test_the_surface_a_placement_was_made_on_reaches_the_row(mirror, surface):
    """`device_locations.source` exists so a device assigned one at a time is
    distinguishable from a named list assigned at once, and both from a pin
    dragged onto a drawing. It is not a confidence score — every one of them is
    an operator."""
    _apply(mirror, _payload(source=surface))
    assert mirror.placed[0]["source"] == surface


@pytest.mark.parametrize("claimed", ["", None, "inferred", "auto"])
def test_an_unrecognised_surface_falls_back_rather_than_being_stored(mirror, claimed):
    """Provenance a consumer copies from whatever it is handed is not provenance,
    it is an assertion of it. The fallback is the surface that existed before the
    field did — and it is a value, never a NULL, because the column is NOT NULL."""
    _apply(mirror, _payload(source=claimed))
    assert mirror.placed[0]["source"] == ps._SOURCE == "floor_plan"


def test_an_event_from_before_the_field_existed_still_mirrors(mirror):
    """A message already on the stream when this shipped carries no `source` at
    all. It is a floor-plan pin, because that was the only surface there was."""
    payload = _payload(floor_id=FLOOR, floor_name="Level 4")
    assert "source" not in payload
    _apply(mirror, payload)
    assert mirror.placed[0]["source"] == "floor_plan"


# ── what a NULL floor means one level up ─────────────────────────────────────


def test_the_estate_placement_counts_are_independent_not_nested():
    """A point can legitimately carry a site and no floor, so `with_site` is not
    an upper bound on anything and `with_floor` is not a subset marker."""
    got = q._placement({"points": 537, "points_with_site": 537,
                        "points_with_floor": 0, "points_with_zone": 0})
    assert got["points"] == 537
    assert got["with_site"] == 537
    assert got["with_floor"] == 0


def test_unplaced_stays_the_floor_wise_number_after_a_site_only_estate():
    """DELIBERATE, and the one number a site-only estate could have made dishonest.

    `unplaced` on `/bi/summary` means "cannot answer a FLOOR-wise question", and
    an estate assigned to buildings but drawn on no plan genuinely cannot. Making
    it site-wise here would report an estate as fully placed for a question it
    still cannot answer. The site-level count gate 3 reads is a different one —
    the sites leaderboard's unplaced pseudo-row (`site_id: null`), which a
    site-only placement does empty.
    """
    got = q._placement({"points": 537, "points_with_site": 537,
                        "points_with_floor": 66, "points_with_zone": 0})
    assert got["unplaced"] == 537 - 66


# ── the list an operator assigns FROM ────────────────────────────────────────
#
# `POST /device-placements/assign` names its devices one by one, so a screen has
# to be able to show which devices have no building. `/bi/devices` already knew
# every device this store has seen; `placement=` is what lets it answer "the ones
# nothing has placed" — a filter over what is already true, never a selection
# something then acts on by itself.


def test_the_unplaced_filter_asks_about_the_device_not_its_points():
    """Placement is a device fact for the same reason `category` is, so it
    filters AFTER the grouping: a device with one placed point and one unplaced
    one is not two devices."""
    having, _search, params = q._device_filters(None, None, None, "unplaced")
    assert having.startswith("HAVING ")
    assert "count(*) FILTER (WHERE p.site_id IS NOT NULL) = 0" in having
    assert params == {}


def test_the_placed_filter_is_the_complement_of_it():
    having, _search, _params = q._device_filters(None, None, None, "placed")
    assert "count(*) FILTER (WHERE p.site_id IS NOT NULL) > 0" in having


def test_no_placement_filter_means_the_whole_estate():
    """Neither answer is a default. A screen asks for one or gets everything."""
    having, _search, _params = q._device_filters(None, None, None, None)
    assert having == ""


def test_an_unknown_placement_filter_is_refused_rather_than_ignored():
    """A typo that silently returned the whole estate would look like "nothing is
    unplaced" on the one screen whose job is to show what is."""
    from kernel.errors import ValidationError

    with pytest.raises(ValidationError):
        q._device_filters(None, None, None, "somewhere")
