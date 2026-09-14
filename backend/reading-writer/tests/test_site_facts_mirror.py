"""What a site event is allowed to change about the BI denominator.

WHY THIS FILE EXISTS. `site_facts_sync` mirrors facts an operator typed in
Configurations → Sites, and `/bi/rating` divides a measured kWh by one of them.
Every rule in `_apply` is a rule about not inventing a building:

  * a body with no tenant is ACKED AND COUNTED, never stored under a fabricated
    tenant and never redelivered forever;
  * an absent fact is NULL — "not recorded" — which the rating renders as
    "cannot rate". It is never a default, an estimate or a national average;
  * a tariff or emission-factor list with ANY malformed row is refused IN FULL
    and the previous mirror kept, because half a tariff prices some hours with
    another hour's rate;
  * a soft-deleted site keeps its row with `is_active` false. The readings
    measured there did not stop having been measured.

None of that raises when it breaks. A mirror that accepted a partial tariff, or
that quietly clobbered a recorded area with a missing one, produces a rating
that is simply wrong and cites itself confidently.

No database and no NATS: `_apply` decides, and `_write_mirror` is the one
transaction — so the transaction is replaced with a recorder and the DECISIONS
are what is asserted.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import json

import pytest

from app import site_facts_sync as sfs

UTC = dt.timezone.utc
TENANT = "11111111-2222-3333-4444-555555555555"
SITE = "22222222-3333-4444-5555-666666666666"


def run(coro):
    return asyncio.run(coro)


class Recorder(sfs.SiteFactsSync):
    """The sync with its one transaction replaced by a note of what it was given.

    `_write_mirror` is `INSERT … ON CONFLICT` plus two delete+insert list
    replacements; asserting it needs Postgres. Everything upstream of it —
    which events apply, what each one states, and which lists are refused — is
    pure, and it is the half that decides what the rating divides by.
    """

    def __init__(self):
        super().__init__(sfs.SiteFactsStats())
        self.writes: list[dict] = []

    async def _write_mirror(self, values, tenant, site_id, slabs, factors):
        self.writes.append(
            {"values": values, "tenant": tenant, "site_id": site_id,
             "slabs": slabs, "factors": factors}
        )


def _apply(payload: dict, event: str = "building_facts_updated") -> Recorder:
    r = Recorder()
    run(r._apply(event, payload, "tenant.x.sites.site." + event))
    return r


def _facts(**over) -> dict:
    body = {"tenant_id": TENANT, "site_id": SITE, "name": "HQ"}
    body.update(over)
    return body


# ── which events reach the mirror at all ─────────────────────────────────────


@pytest.mark.parametrize("event", sorted(sfs._EVENTS))
def test_every_site_event_restates_the_facts_and_is_therefore_applied(event):
    """Core publishes the whole fact set on EVERY site event, so a mirror that
    listened only to `building_facts_updated` would stay wrong until somebody
    re-typed an area. Applying all of them is what makes the next edit of any
    kind a repair."""
    r = _apply(_facts(gross_floor_area_sqm=1200), event=event)
    assert len(r.writes) == 1
    assert r.stats.applied == 1


def test_an_event_this_consumer_does_not_mirror_is_counted_and_writes_nothing():
    """The subject filter is `sites.site.>`, so a future verb arrives here.
    Counting it says so; writing on it would mirror whatever that verb meant."""
    r = _apply(_facts(), event="archived")
    assert r.writes == []
    assert r.stats.skipped_other_event == 1
    assert r.stats.applied == 0


def test_a_deleted_site_keeps_its_row_and_is_marked_inactive():
    """The readings measured at a deleted site did not stop having been
    measured. Deleting the mirror row would orphan them and silently change
    every historical portfolio figure."""
    r = _apply(_facts(is_active=True), event="deleted")
    assert r.writes[0]["values"]["is_active"] is False


def test_a_restored_site_comes_back_active():
    r = _apply(_facts(is_active=True), event="restored")
    assert r.writes[0]["values"]["is_active"] is True


# ── the tenant that is not always a tenant ───────────────────────────────────


def test_a_platform_scoped_event_is_counted_and_never_stored_under_an_invented_tenant():
    """A super-admin action publishes under the reserved literal `platform`, and
    `site_facts.tenant_id` is a real uuid. Inventing one would be a fabricated
    fact about a real building, attributed to the wrong customer."""
    r = _apply({"site_id": SITE, "name": "HQ"})
    assert r.writes == []
    assert r.stats.skipped_no_tenant == 1


def test_an_event_with_no_site_id_is_malformed_rather_than_mirrored_somewhere():
    r = _apply({"tenant_id": TENANT, "name": "HQ"})
    assert r.writes == []
    assert r.stats.skipped_malformed == 1


def test_an_unparseable_tenant_is_treated_as_absent_not_as_a_string_key():
    r = _apply({"tenant_id": "not-a-uuid", "site_id": SITE})
    assert r.writes == []
    assert r.stats.skipped_no_tenant == 1


# ── the facts themselves: stated, or NOT RECORDED ────────────────────────────


@pytest.mark.parametrize("given", [None, "", "n/a", float("nan"), float("inf")])
def test_an_area_that_is_not_a_number_is_mirrored_as_not_recorded(given):
    """NULL is what `/bi/rating` reads as "cannot rate". A 0 here would be an
    infinite energy performance index; a carried-over previous value would be a
    rating computed against another building's floor plate."""
    r = _apply(_facts(gross_floor_area_sqm=given))
    assert r.writes[0]["values"]["gross_floor_area_sqm"] is None


def test_a_stated_area_is_mirrored_as_the_number_it_is():
    r = _apply(_facts(gross_floor_area_sqm="1200.5"))
    assert r.writes[0]["values"]["gross_floor_area_sqm"] == 1200.5


def test_a_stated_zero_is_a_value_and_not_an_absence():
    """Zero is something an operator typed. Collapsing it into NULL would hide a
    data-entry error behind the same "not recorded" the screen shows for a site
    nobody has filled in."""
    r = _apply(_facts(energy_tariff_per_kwh=0))
    assert r.writes[0]["values"]["energy_tariff_per_kwh"] == 0.0


def test_every_fact_is_restated_from_this_message_and_nothing_is_carried_over():
    """Core states the whole set on every site event, so the last message is the
    whole truth. A COALESCE-style merge here would make a cleared field
    un-clearable — the operator deletes the area and the old one stays."""
    r = _apply(_facts())
    v = r.writes[0]["values"]
    assert v["gross_floor_area_sqm"] is None
    assert v["energy_tariff_per_kwh"] is None
    assert v["occupancy"] is None
    assert v["facts_updated_at"] is None


def test_an_occupancy_that_is_not_a_number_is_not_recorded():
    r = _apply(_facts(occupancy="about two hundred"))
    assert r.writes[0]["values"]["occupancy"] is None


def test_a_facts_timestamp_is_parsed_and_an_unparseable_one_is_not_invented():
    assert _apply(_facts(building_facts_updated_at="2026-03-01T10:00:00Z")).writes[0][
        "values"
    ]["facts_updated_at"] == dt.datetime(2026, 3, 1, 10, tzinfo=UTC)
    assert _apply(_facts(building_facts_updated_at="last tuesday")).writes[0]["values"][
        "facts_updated_at"
    ] is None


def test_a_city_nobody_stated_is_left_out_of_the_write_entirely():
    """Presence of the KEY is the test, not truthiness. A pre-0019 message says
    nothing about the city, and writing NULL for it would clobber a value a
    later message already mirrored — the upsert's `set_` is built from these
    keys, so omitting the key is what preserves it."""
    assert "city" not in _apply(_facts()).writes[0]["values"]


def test_a_city_stated_as_null_does_clear_it():
    """That is core saying the address has no city, and the portfolio renders
    "—". Only a message that never mentioned the key is silence."""
    assert _apply(_facts(city=None)).writes[0]["values"]["city"] is None


def test_a_stated_city_is_mirrored_and_bounded():
    r = _apply(_facts(city="Bengaluru"))
    assert r.writes[0]["values"]["city"] == "Bengaluru"
    assert len(_apply(_facts(city="x" * 400)).writes[0]["values"]["city"]) == 255


# ── the input lists: all of it, or none of it ────────────────────────────────


_SLAB = {"name": "Peak", "start_minute": 540, "end_minute": 1080,
         "rate_per_kwh": 9.5, "currency": "INR", "effective_from": "2026-01-01"}
_FACTOR = {"kg_co2_per_kwh": 0.71, "source": "CEA CO2 Baseline Database v19",
           "effective_from": "2026-01-01"}


def test_a_stated_tariff_list_is_parsed_positionally_and_passed_to_the_write():
    r = _apply(_facts(tariff_slabs=[_SLAB, {**_SLAB, "name": "Off-peak", "start_minute": 0,
                                            "end_minute": 540, "rate_per_kwh": 4.0}]))
    slabs = r.writes[0]["slabs"]
    assert [s["position"] for s in slabs] == [0, 1]
    assert [s["name"] for s in slabs] == ["Peak", "Off-peak"]


@pytest.mark.parametrize(
    "broken, why",
    [
        ({"name": ""}, "a nameless slab cannot be shown or reasoned about"),
        ({"rate_per_kwh": "free"}, "a rate that is not a number is not a rate"),
        ({"currency": ""}, "a rate without a currency is not a price"),
        ({"effective_from": "someday"}, "a slab with no start date applies when?"),
        ({"start_minute": -1}, "a minute outside the day"),
        ({"end_minute": 2000}, "a minute outside the day"),
        ({"start_minute": "morning"}, "a minute that is not a number"),
        ("not-a-dict", "a list entry that is not a slab at all"),
    ],
)
def test_one_bad_slab_refuses_the_whole_tariff_and_keeps_the_previous_mirror(broken, why):
    """Half a tariff prices some hours with another hour's rate, and the bill it
    produces looks entirely plausible. The site row still writes — only the
    LIST is withheld — because the next site edit restates the list in full."""
    item = broken if isinstance(broken, str) else {**_SLAB, **broken}
    r = _apply(_facts(tariff_slabs=[_SLAB, item]))
    assert r.writes[0]["slabs"] is None, why
    assert r.stats.skipped_malformed == 1
    assert r.stats.applied == 1


def test_an_empty_tariff_list_is_the_statement_that_there_are_no_slabs():
    """`[]` is not absence: it is core saying the operator removed them all, and
    it must reach the write so the wholesale replacement clears the mirror."""
    r = _apply(_facts(tariff_slabs=[]))
    assert r.writes[0]["slabs"] == []
    assert r.stats.skipped_malformed == 0


def test_a_tariff_list_that_is_not_a_list_is_refused_rather_than_iterated():
    r = _apply(_facts(tariff_slabs={"Peak": 9.5}))
    assert r.writes[0]["slabs"] is None
    assert r.stats.skipped_malformed == 1


def test_a_message_that_says_nothing_about_tariffs_leaves_the_mirrored_list_alone():
    """None means "not stated", which the write turns into "do not touch". If
    absence replaced the list, every non-tariff site edit would delete the
    tariff an operator entered."""
    r = _apply(_facts())
    assert r.writes[0]["slabs"] is None and r.writes[0]["factors"] is None
    assert r.stats.skipped_malformed == 0


def test_an_emission_factor_without_a_source_is_malformed_by_definition():
    """An uncited number must never enter this store, not even by transit
    damage: the whole point of `/bi/rating` citing its factor is that somebody
    can check it."""
    r = _apply(_facts(emission_factors=[{**_FACTOR, "source": "  "}]))
    assert r.writes[0]["factors"] is None
    assert r.stats.skipped_malformed == 1


@pytest.mark.parametrize(
    "broken",
    [{"kg_co2_per_kwh": None}, {"kg_co2_per_kwh": "lots"}, {"effective_from": None}],
)
def test_one_bad_emission_factor_refuses_the_whole_list(broken):
    r = _apply(_facts(emission_factors=[_FACTOR, {**_FACTOR, **broken}]))
    assert r.writes[0]["factors"] is None


def test_a_good_emission_factor_list_reaches_the_write_with_its_citation():
    r = _apply(_facts(emission_factors=[_FACTOR]))
    assert r.writes[0]["factors"] == [
        {"position": 0, "kg_co2_per_kwh": 0.71,
         "source": "CEA CO2 Baseline Database v19",
         "effective_from": dt.date(2026, 1, 1)}
    ]


def test_a_malformed_list_does_not_stop_the_site_row_being_mirrored():
    """The facts in the same message are still true. Refusing the whole event
    over one bad slab would mean a typo in a tariff froze the building's area."""
    r = _apply(_facts(gross_floor_area_sqm=900, tariff_slabs=["nonsense"]))
    assert r.writes[0]["values"]["gross_floor_area_sqm"] == 900.0


# ── one message, end to end: ack, nak, and what is counted ───────────────────


class FakeMsg:
    def __init__(self, payload, *, event="site.building_facts_updated", raw=None):
        self.data = raw if raw is not None else json.dumps(
            {"event": event, "payload": payload}
        ).encode()
        self.subject = "tenant.x.sites.site.building_facts_updated"
        self.acked = False
        self.naked = False

    async def ack(self):
        self.acked = True

    async def nak(self, delay=None):
        self.naked = True


def test_an_applied_message_is_acked():
    r, msg = Recorder(), FakeMsg(_facts(gross_floor_area_sqm=100))
    run(r._handle(msg))
    assert msg.acked and not msg.naked
    assert r.stats.messages == 1 and r.stats.applied == 1


def test_an_unparseable_message_is_acked_and_counted_rather_than_redelivered_forever():
    """An un-ackable poison message is redelivered forever and blocks every
    site edit behind it. The count is the only trace it left, so it has to be
    kept."""
    r, msg = Recorder(), FakeMsg(None, raw=b"{not json")
    run(r._handle(msg))
    assert msg.acked
    assert r.stats.skipped_malformed == 1


def test_a_store_failure_is_naked_for_redelivery_and_never_acked_away():
    """This is the one case where the data is fine and the mirror is not. Acking
    would drop an operator's edit silently; NAK gets it re-delivered when the
    store comes back."""

    class Broken(Recorder):
        async def _write_mirror(self, *a, **kw):
            raise RuntimeError("the store is down")

    r, msg = Broken(), FakeMsg(_facts(gross_floor_area_sqm=100))
    run(r._handle(msg))
    assert msg.naked and not msg.acked
    assert r.stats.errors == 1
    assert "the store is down" in r.stats.last_error


def test_a_cancellation_is_not_swallowed_as_a_failed_message():
    """Shutdown must stop this consumer, not be counted as a broken site event
    and NAKed back onto the stream."""

    class Cancelling(Recorder):
        async def _write_mirror(self, *a, **kw):
            raise asyncio.CancelledError()

    r = Cancelling()
    with pytest.raises(asyncio.CancelledError):
        run(r._handle(FakeMsg(_facts())))


def test_the_snapshot_names_every_counter_the_metrics_endpoint_publishes():
    """These names are a dashboard's contract. Renaming one silently zeroes a
    panel that was watching a real failure mode."""
    snap = sfs.SiteFactsStats().snapshot()
    assert set(snap) == {
        "site_facts_sync_connected",
        "site_facts_sync_messages",
        "site_facts_sync_applied",
        "site_facts_sync_skipped_no_tenant",
        "site_facts_sync_skipped_malformed",
        "site_facts_sync_skipped_other_event",
        "site_facts_sync_slab_lists_replaced",
        "site_facts_sync_factor_lists_replaced",
        "site_facts_sync_errors",
        "site_facts_sync_last_error",
    }
