"""WHO acted, in words, on the rows people read.

The threat-posture card printed "by 3cd1c8ca-c927-41af-9101-c345241c7492". This
service has no users table, so it cannot turn that into a name after the fact —
and an operator cannot either, from the screen it appears on. So the name is
STAMPED at write time from the access token, the way an audit row snapshots its
actor.

The same field on an SOP step (`executed_by_name`) existed as an unfilled
parameter: every caller omitted it, so every step of every incident stamped null
and the timeline printed a uuid too.

What is pinned here: the name is stamped when the token carries one, the id is
still stamped beside it, and a principal with NO name (a system write, a service
token, a token minted before the claim) leaves the field null rather than
inventing something.
"""

from __future__ import annotations

import uuid

import pytest

from kernel.auth import Scope

from app.workflow.core.actor import actor_id, actor_name
from app.workflow.threat_levels.models import ThreatLevel
from app.workflow.threat_levels.service import ThreatLevelService
from app.workflow.threat_levels import schemas as TS

from conftest import make_sqlite_session, run_async as _run

TENANT = uuid.uuid4()
SCOPE = Scope(tenant_id=TENANT, is_superadmin=False)


class _Named:
    user_id = "3cd1c8ca-c927-41af-9101-c345241c7492"
    name = "Priya Nair"


class _Nameless:
    """A system write, a service principal, or a token predating the claim."""

    user_id = "3cd1c8ca-c927-41af-9101-c345241c7492"


def test_actor_name_reads_the_principal_or_gives_up():
    assert actor_name(_Named()) == "Priya Nair"
    # Not "", not the id — a caller that falls back needs to SEE the absence.
    assert actor_name(_Nameless()) is None
    assert actor_name(None) is None

    class _Blank:
        name = "   "

    assert actor_name(_Blank()) is None
    # The id is unchanged by any of this; both are stamped.
    assert actor_id(_Named()) == _Named.user_id


def _set_level(actor, level="elevated", site_id=None):
    async def go():
        engine, sm = await make_sqlite_session(ThreatLevel.__table__)
        try:
            async with sm() as session:
                svc = ThreatLevelService(session, SCOPE)
                body = TS.SetThreatLevelRequest(site_id=site_id, level=level, reason="drill")
                return await svc.set_level(body, actor=actor)
        finally:
            await engine.dispose()

    return _run(go())


def test_a_posture_change_records_the_name_beside_the_id():
    row = _set_level(_Named())
    assert row.set_by_name == "Priya Nair"
    # The id stays: a name is not an identity, and two people share names.
    assert row.set_by == _Named.user_id


def test_a_nameless_principal_leaves_the_name_null():
    # The screen falls back to the id, which is the truthful thing to show when
    # nobody recorded a name.
    row = _set_level(_Nameless())
    assert row.set_by_name is None
    assert row.set_by == _Nameless.user_id


def test_the_change_history_carries_the_name_too():
    """The card shows the latest; the history is what an investigation reads."""

    async def go():
        engine, sm = await make_sqlite_session(ThreatLevel.__table__)
        try:
            async with sm() as session:
                svc = ThreatLevelService(session, SCOPE)
                await svc.set_level(
                    TS.SetThreatLevelRequest(level="elevated", reason="a"), actor=_Named()
                )
                return await svc.set_level(
                    TS.SetThreatLevelRequest(level="high", reason="b"), actor=_Named()
                )
        finally:
            await engine.dispose()

    row = _run(go())
    assert row.history and row.history[-1]["set_by_name"] == "Priya Nair"
    assert row.history[-1]["from_level"] == "elevated"


def test_the_public_shape_serves_both_fields():
    row = _set_level(_Named())
    out = TS.ThreatLevelPublic.from_row(row)
    assert out.set_by_name == "Priya Nair"
    assert out.set_by == _Named.user_id
