"""An ingest rule cannot publish as another service.

`target_domain` is interpolated into the NATS subject a rule publishes on:
`tenant.<id>.<target_domain>.<event>`. It is written by a holder of
`ingest.manage` for one tenant. So naming `access` there makes this service emit
events on access control's own subject — and workflow's correlation engine, the
reporting projector and everything else consuming `tenant.*.access.>` would
believe them.

The field WAS validated, for SHAPE. `access` is a perfectly well-formed domain
name; the question the pattern cannot ask is whose it is.

THE BROKER CANNOT ASK IT EITHER. ingest's NATS grant is `tenant.*.*.>` precisely
BECAUSE this field is tenant-configured — a fixed list at the broker would break a
legitimate rule the moment somebody added one. That is recorded in
deploy/nats/nats.conf, and this is the other half of it: the constraint lives at
the edge where a rule is saved.

FOUR SCHEMAS, and the rule's value OVERRIDES the category's
(`domain = rule.target_domain or cat_domain`, service.py). Gating the category and
not the rule would have been gating the half that loses.
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.ingest.schemas import (
    RESERVED_DOMAINS,
    CategoryCreate,
    CategoryUpdate,
    EventRuleCreate,
    EventRuleUpdate,
)

# Every schema a caller can put a domain into. The two `*Public` models are
# responses and carry whatever is stored.
INPUT_SCHEMAS = [CategoryCreate, CategoryUpdate, EventRuleCreate, EventRuleUpdate]


def _build(model, domain):
    """The smallest valid body for each, plus the domain under test."""
    if model is CategoryCreate:
        return model(name="Panel", target_domain=domain)
    if model is CategoryUpdate:
        return model(target_domain=domain)
    return model(name="Rule", target_domain=domain)


@pytest.mark.parametrize("model", INPUT_SCHEMAS, ids=lambda m: m.__name__)
@pytest.mark.parametrize("domain", sorted(RESERVED_DOMAINS))
def test_another_services_domain_is_refused(model, domain):
    with pytest.raises(ValidationError) as caught:
        _build(model, domain)
    assert "belongs to another service" in str(caught.value), caught.value


@pytest.mark.parametrize("model", INPUT_SCHEMAS, ids=lambda m: m.__name__)
def test_ingests_own_domain_is_accepted(model):
    assert _build(model, "ingest").target_domain == "ingest"


@pytest.mark.parametrize("model", INPUT_SCHEMAS, ids=lambda m: m.__name__)
def test_a_tenants_own_namespace_is_accepted(model):
    """An unlisted domain impersonates nobody, so refusing it would be a different
    bug: a tenant routing its BMS feed to `bms` is doing nothing wrong."""
    assert _build(model, "bms").target_domain == "bms"


def test_fire_is_deliberately_not_reserved():
    """`tenant.*.fire.>` is SUBSCRIBED to by workflow's correlation engine and
    published by nothing in the estate. An external fire panel arriving on a
    webhook is exactly what it is waiting for, so reserving it would close the
    use case rather than a hole."""
    assert "fire" not in RESERVED_DOMAINS
    assert EventRuleCreate(name="Panel", target_domain="fire").target_domain == "fire"


@pytest.mark.parametrize("model", INPUT_SCHEMAS, ids=lambda m: m.__name__)
@pytest.mark.parametrize("bad", ["Access", "ac cess", "1access", "access.door", "access>", ""])
def test_the_shape_check_still_applies(model, bad):
    """Ownership is the new question, not a replacement for the old one: a `.` or
    a `>` in this field changes the SUBJECT'S SHAPE, not just its namespace."""
    with pytest.raises(ValidationError):
        _build(model, bad)


def test_the_reserved_set_covers_every_domain_another_service_publishes():
    """Derived from the kernel's stream subject list rather than restated, so a
    domain added there without a decision here fails this instead of shipping."""
    from kernel.events import EVENTS_SUBJECTS

    declared = {s.split(".")[2] for s in EVENTS_SUBJECTS}
    # What ingest may legitimately use: its own, and the one nothing publishes.
    ours = {"ingest", "fire"}
    assert declared - ours == set(RESERVED_DOMAINS), (
        f"the EVENTS stream declares {sorted(declared - ours - set(RESERVED_DOMAINS))} "
        f"which nothing here decides about"
    )
