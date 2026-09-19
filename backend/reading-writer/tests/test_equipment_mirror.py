"""What an equipment-registry event is allowed to change in the reporting store.

WHY THIS FILE EXISTS. `equipment_sync` mirrors core's systems, equipment and
point slots, and `chw_delta_t_in_band` v2 reads its band straight off a mirrored
chiller. Every rule in `_apply` is a rule about not inventing a machine:

  * a body with no tenant is ACKED AND COUNTED — never stored under a fabricated
    tenant, never redelivered forever — and the subject's tenant segment is never
    consulted, because for a super-admin action it is the literal `platform`;
  * every non-delete equipment event is an UPSERT of the whole equipment, and the
    slot list is replaced wholesale — the last message is the whole truth;
  * a numeric design fact that is not a finite number is DROPPED and counted,
    never parsed or defaulted, so the metric that needs it refuses by name;
  * a damaged slot list is refused in full and the previous slots kept, because
    half a list silently unbinds a chiller's supply temperature;
  * a delete removes what core removed — including a system's equipment.

None of that raises when it breaks. A mirror that stored a `"4.5"` as 4.5, or
kept a deleted chiller, produces a schematic and a band score that are simply
wrong and cite a registry that says otherwise.

No database and no NATS: `_apply` decides, and the four write methods are the
transactions — so they are replaced with a recorder and the DECISIONS are what
is asserted. The SQL of those four was proven against a real Postgres at 0026
(see the report that shipped this).
"""

from __future__ import annotations

import asyncio
import json
import uuid

import pytest

from app import equipment_sync as eqs
from app import site_facts_sync as sfs

TENANT = "11111111-2222-3333-4444-555555555555"
SITE = "22222222-3333-4444-5555-666666666666"
SYSTEM = "33333333-4444-5555-6666-777777777777"
CH1 = "44444444-5555-6666-7777-888888888888"


def run(coro):
    return asyncio.run(coro)


class Recorder(eqs.EquipmentSync):
    """The sync with its transactions replaced by a note of what each was given."""

    def __init__(self):
        super().__init__(eqs.EquipmentStats())
        self.systems: list[dict] = []
        self.equipment: list[dict] = []
        self.deleted_equipment: list[tuple] = []
        self.deleted_systems: list[tuple] = []
        self.reconciled: list[tuple] = []

    async def _upsert_system(self, values, *, with_description):
        self.systems.append({"values": values, "with_description": with_description})

    async def _write_equipment(self, values, slots, system):
        self.equipment.append({"values": values, "slots": slots, "system": system})

    async def _delete_equipment(self, tenant, equipment_ids):
        self.deleted_equipment.append((tenant, list(equipment_ids)))

    async def _delete_system(self, tenant, system_id, equipment_ids):
        self.deleted_systems.append((tenant, system_id, list(equipment_ids)))

    async def _reconcile_rows(self, tenant, site_id, keep_systems, keep_equipment):
        self.reconciled.append((tenant, site_id, list(keep_systems), list(keep_equipment)))
        return 2, 1  # what it would have removed, so the counters are exercised


def _apply(entity: str, event: str, payload: dict, subject_tenant: str = "platform") -> Recorder:
    r = Recorder()
    run(r._apply(entity, event, payload, f"tenant.{subject_tenant}.sites.{entity}.{event}"))
    return r


def _equipment(**over) -> dict:
    body = {
        "tenant_id": TENANT, "site_id": SITE, "system_id": SYSTEM,
        "system_name": "Plant A", "system_kind": "chw_plant",
        "equipment_id": CH1, "tag": "CH-01", "name": "York 1",
        "equipment_class": "chiller",
        "design": {"tr": 300, "design_dt_min": 4.5, "design_dt_max": 6.0, "make": "York"},
        "design_units": {"tr": "TR", "design_dt_min": "K", "design_dt_max": "K"},
        "slots": [
            {"slot": "chws", "device_tag": "1F York Chiller1", "point_tag": "1FYC1_OWT"},
            {"slot": "trip", "device_tag": None, "point_tag": None},
        ],
        "source": "designer",
    }
    body.update(over)
    return body


def _system(**over) -> dict:
    body = {"tenant_id": TENANT, "site_id": SITE, "system_id": SYSTEM,
            "name": "Plant A", "kind": "chw_plant", "description": "the main loop"}
    body.update(over)
    return body


# ── the subjects ─────────────────────────────────────────────────────────────


def test_one_durable_binds_both_subjects_so_core_order_is_kept():
    """Core deletes a system by publishing each `equipment.deleted` and THEN
    `site_system.deleted`. Two durables could deliver those in any order; one
    durable with two filters delivers them as published."""
    assert set(eqs.SUBJECTS) == {"tenant.*.sites.site_system.>", "tenant.*.sites.equipment.>"}
    assert eqs.DURABLE not in {"reading-writer-site-facts", "reading-writer-placement"}


def test_deleted_means_different_things_on_the_two_subjects():
    """`deleted` is the verb on both subjects; only the entity says which table."""
    assert eqs._entity_event({"event": "equipment.deleted"}) == ("equipment", "deleted")
    assert eqs._entity_event({"event": "site_system.deleted"}) == ("site_system", "deleted")


# ── upserts ──────────────────────────────────────────────────────────────────


# Core's own verbs (`infrastructure/service.py`), written out rather than read
# from `eqs._EQUIPMENT_UPSERTS`: a test parametrized over the set it is testing
# shrinks with it, and passes on a mirror that applies nothing but `created`.
CORE_EQUIPMENT_UPSERTS = ("created", "updated", "design_updated", "slot_set", "slot_removed")
CORE_SYSTEM_UPSERTS = ("created", "updated")


@pytest.mark.parametrize("event", CORE_EQUIPMENT_UPSERTS)
def test_every_non_delete_equipment_event_upserts_the_whole_equipment(event):
    """Core publishes the whole equipment on every one of these, so each is an
    upsert — a mirror that only applied `created` would stay wrong until the
    equipment was recreated."""
    r = _apply("equipment", event, _equipment())
    assert len(r.equipment) == 1
    v = r.equipment[0]["values"]
    assert v["equipment_id"] == uuid.UUID(CH1)
    assert v["tag"] == "CH-01"
    assert v["equipment_class"] == "chiller"
    assert v["design"]["design_dt_min"] == 4.5
    assert v["design_units"] == {"tr": "TR", "design_dt_min": "K", "design_dt_max": "K"}
    assert r.stats.equipment_upserted == 1


def test_the_slot_list_is_stated_whole_with_tags_exactly_as_core_spelt_them():
    """The gateway spells tags `1FYC1_OWT` and `1F York Chiller1`; a normalised
    copy would resolve to no point. An unbound slot is a real statement and is
    mirrored as one."""
    slots = _apply("equipment", "slot_set", _equipment()).equipment[0]["slots"]
    assert slots == [
        {"slot": "chws", "device_tag": "1F York Chiller1", "point_tag": "1FYC1_OWT"},
        {"slot": "trip", "device_tag": None, "point_tag": None},
    ]


def test_an_equipment_event_restates_its_systems_name_and_kind_but_not_its_description():
    """So a lost `site_system.created` cannot leave a chiller hanging off a plant
    the mirror has never heard of — and the description, which the equipment
    event does not carry, is never overwritten with a NULL it did not state."""
    system = _apply("equipment", "updated", _equipment()).equipment[0]["system"]
    assert system["name"] == "Plant A" and system["kind"] == "chw_plant"
    assert "description" not in system


@pytest.mark.parametrize("event", CORE_SYSTEM_UPSERTS)
def test_a_system_event_upserts_the_system_with_its_description(event):
    r = _apply("site_system", event, _system())
    assert r.systems[0]["values"]["description"] == "the main loop"
    assert r.systems[0]["with_description"] is True
    assert r.stats.systems_upserted == 1


def test_a_verb_this_mirror_does_not_know_is_counted_and_writes_nothing():
    r = _apply("equipment", "archived", _equipment())
    assert r.equipment == [] and r.stats.skipped_other_event == 1


# ── deletes ──────────────────────────────────────────────────────────────────


def test_a_deleted_equipment_is_removed_not_kept():
    """Unlike a site, a deleted chiller is gone from core, and a schematic that
    kept drawing it would draw a machine the registry says does not exist."""
    r = _apply("equipment", "deleted",
               {"tenant_id": TENANT, "site_id": SITE, "system_id": SYSTEM,
                "equipment_id": CH1, "tag": "CH-01"})
    assert r.deleted_equipment == [(uuid.UUID(TENANT), [uuid.UUID(CH1)])]
    assert r.equipment == []


def test_a_deleted_system_takes_the_equipment_core_names_with_it():
    r = _apply("site_system", "deleted", _system(equipment_ids=[CH1, "not-a-uuid"]))
    assert r.deleted_systems == [(uuid.UUID(TENANT), uuid.UUID(SYSTEM), [uuid.UUID(CH1)])]


# ── the tenant that is not always a tenant ───────────────────────────────────


def test_the_tenant_comes_from_the_body_even_when_the_subject_says_platform():
    r = _apply("equipment", "created", _equipment(), subject_tenant="platform")
    assert r.equipment[0]["values"]["tenant_id"] == uuid.UUID(TENANT)


@pytest.mark.parametrize("tenant", [None, "", "not-a-uuid"])
def test_a_body_with_no_real_tenant_is_counted_and_never_stored(tenant):
    """Inventing a tenant would put one customer's chiller on another's plant."""
    r = _apply("equipment", "created", _equipment(tenant_id=tenant))
    assert r.equipment == [] and r.systems == []
    assert r.stats.skipped_no_tenant == 1


def test_a_platform_delete_is_not_applied_to_anybody():
    r = _apply("site_system", "deleted", _system(tenant_id=None))
    assert r.deleted_systems == [] and r.stats.skipped_no_tenant == 1


# ── what cannot be applied is acked and counted ──────────────────────────────


@pytest.mark.parametrize("missing", ["equipment_id", "tag", "equipment_class", "site_id", "system_id"])
def test_an_equipment_event_missing_its_identity_is_malformed_not_mirrored(missing):
    r = _apply("equipment", "created", _equipment(**{missing: None}))
    assert r.equipment == []
    assert r.stats.skipped_malformed == 1


def test_a_system_with_no_kind_is_malformed():
    r = _apply("site_system", "created", _system(kind=""))
    assert r.systems == [] and r.stats.skipped_malformed == 1


@pytest.mark.parametrize("given", ["4.5", float("nan"), float("inf"), True, [4.5]])
def test_a_numeric_design_fact_that_is_not_a_finite_number_is_dropped_and_counted(given):
    """Not parsed, not defaulted: the band metric then refuses naming the fact,
    which is the refusal an operator can act on. `True` is a bool, not a band."""
    r = _apply("equipment", "design_updated", _equipment(
        design={"tr": 300, "design_dt_min": given, "design_dt_max": 6.0}))
    design = r.equipment[0]["values"]["design"]
    assert "design_dt_min" not in design
    assert design["design_dt_max"] == 6.0
    assert r.stats.design_facts_dropped == 1


def test_text_facts_and_stated_numbers_pass_through_unchanged():
    design = _apply("equipment", "created", _equipment()).equipment[0]["values"]["design"]
    assert design == {"tr": 300, "design_dt_min": 4.5, "design_dt_max": 6.0, "make": "York"}


@pytest.mark.parametrize("slots", [
    [{"slot": "chws", "device_tag": "CH1", "point_tag": None}],   # half a binding
    [{"slot": "chws", "device_tag": None, "point_tag": "OWT"}],   # the other half
    [{"slot": "chws"}, {"slot": "chws"}],                          # one slot twice
    [{"device_tag": "CH1", "point_tag": "OWT"}],                   # no slot name
    "chws",                                                        # not a list
])
def test_a_damaged_slot_list_is_refused_whole_and_the_previous_slots_kept(slots):
    """`slots=None` tells the writer to leave the stored list alone. The
    equipment row itself is still restated — its design facts are not damaged."""
    r = _apply("equipment", "slot_set", _equipment(slots=slots))
    assert r.equipment[0]["slots"] is None
    assert r.equipment[0]["values"]["tag"] == "CH-01"
    assert r.stats.skipped_malformed == 1


class _Msg:
    def __init__(self, data: bytes):
        self.data = data
        self.subject = "tenant.platform.sites.equipment.created"
        self.acked = False
        self.nakd = False

    async def ack(self):
        self.acked = True

    async def nak(self, delay=None):
        self.nakd = True


def test_an_unparseable_message_is_acked_and_counted_rather_than_redelivered_forever():
    r = Recorder()
    msg = _Msg(b"{not json")
    run(r._handle(msg))
    assert msg.acked and not msg.nakd
    assert r.stats.skipped_malformed == 1


def test_a_store_failure_is_nakd_so_the_event_lands_when_the_store_returns():
    class Broken(Recorder):
        async def _write_equipment(self, values, slots, system):
            raise ConnectionError("store down")

    r = Broken()
    msg = _Msg(json.dumps({"event": "equipment.created", "payload": _equipment()}).encode())
    run(r._handle(msg))
    assert msg.nakd and not msg.acked
    assert r.stats.errors == 1


def test_stats_reach_the_stats_endpoint_under_their_own_prefix():
    snap = eqs.EquipmentStats().snapshot()
    assert {"equipment_sync_skipped_no_tenant", "equipment_sync_skipped_malformed",
            "equipment_sync_design_facts_dropped"} <= set(snap)
    from app import main
    assert "equipment_sync_messages" in run(main.stats())


# ── the neighbour this work found broken ─────────────────────────────────────


def test_site_facts_sync_can_actually_stop():
    """`SiteFactsSync.stop()` called `stop_tasks` and `close_nats` without
    importing either, so shutdown raised NameError — and main.py's lifespan
    stops the site-facts mirror BEFORE the pipeline, so the pipeline's final
    flush never ran on the way down."""
    run(sfs.SiteFactsSync(sfs.SiteFactsStats()).stop())


# ── republish: what retention cannot answer ──────────────────────────────────


@pytest.mark.parametrize("entity,event", [("equipment", "resynced"), ("site_system", "resynced")])
def test_a_restatement_is_an_upsert_like_any_other_event(entity, event):
    """A republish carries the same whole entity every write carries, so nothing
    about `resynced` is special except that no operator edited anything."""
    body = _equipment() if entity == "equipment" else _system()
    r = _apply(entity, event, body)
    if entity == "equipment":
        assert r.equipment[0]["values"]["tag"] == "CH-01"
        assert len(r.equipment[0]["slots"]) == 2
    else:
        assert r.systems[0]["values"]["name"] == "Plant A"
    assert r.stats.skipped_other_event == 0


def _reconcile(**over) -> dict:
    body = {"tenant_id": TENANT, "site_id": SITE,
            "system_ids": [SYSTEM], "equipment_ids": [CH1]}
    body.update(over)
    return body


def test_a_reconcile_keeps_what_core_named_and_removes_the_rest():
    """The one damage a restatement cannot repair: a delete whose event aged out
    leaves nothing to restate, so the mirror keeps a machine core does not have."""
    r = _apply("site_system", "reconciled", _reconcile())

    assert len(r.reconciled) == 1
    tenant, site, systems, equipment = r.reconciled[0]
    assert str(tenant) == TENANT and str(site) == SITE
    assert [str(s) for s in systems] == [SYSTEM]
    assert [str(e) for e in equipment] == [CH1]
    # Whatever it removed is counted where every other removal is counted.
    assert r.stats.equipment_deleted == 2 and r.stats.systems_deleted == 1
    assert r.stats.reconciles == 1
    assert r.systems == [] and r.equipment == [], "a reconcile states nothing new"


def test_a_site_core_says_is_empty_really_is_emptied():
    """An operator who deleted a building's whole plant while the mirror was down
    must not be left with all of it. Empty lists are a real answer."""
    r = _apply("site_system", "reconciled", _reconcile(system_ids=[], equipment_ids=[]))
    assert r.reconciled[0][2] == [] and r.reconciled[0][3] == []


@pytest.mark.parametrize("damage", [
    {"system_ids": None},
    {"equipment_ids": "CH-01"},
    {"site_id": "not-a-uuid"},
])
def test_a_malformed_reconcile_removes_nothing(damage):
    """The reading "this site has no plant" from a damaged body would empty a
    whole building's registry on one bad message."""
    r = _apply("site_system", "reconciled", _reconcile(**damage))
    assert r.reconciled == []
    assert r.stats.skipped_malformed == 1
    assert r.stats.equipment_deleted == 0 and r.stats.systems_deleted == 0


def test_a_reconcile_with_no_tenant_removes_nothing():
    """Same rule as every other event, and the one where it matters most: a
    reconcile stored under a fabricated tenant would delete another tenant's
    plant."""
    r = _apply("site_system", "reconciled", _reconcile(tenant_id=None))
    assert r.reconciled == [] and r.stats.skipped_no_tenant == 1


def test_only_the_system_subject_carries_a_reconcile():
    """It is one message about a whole site, and it is published last. An
    equipment-subject reconcile would be a second one nobody publishes."""
    r = _apply("equipment", "reconciled", _reconcile())
    assert r.reconciled == [] and r.stats.skipped_other_event == 1


# ── what feeds it ────────────────────────────────────────────────────────────


def test_the_feeder_travels_with_the_equipment():
    """The power chain's edges. Core states the parent on every equipment event,
    so the mirror stores it — and the plant draws a single-line from it."""
    parent = "55555555-6666-7777-8888-999999999999"
    r = _apply("equipment", "updated", _equipment(fed_by_id=parent))
    assert str(r.equipment[0]["values"]["fed_by_id"]) == parent


@pytest.mark.parametrize("raw", [None, "", "not-a-uuid"])
def test_a_missing_or_damaged_feeder_is_an_unhooked_board_never_a_guess(raw):
    r = _apply("equipment", "updated", _equipment(fed_by_id=raw))
    assert r.equipment[0]["values"]["fed_by_id"] is None
