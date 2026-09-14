"""The estate reads walk every recorder AT ONCE, and still say which one is sick.

``GET /vms/federation/cameras`` and ``GET /vms/federation/nvrs`` are the two reads
that must touch every enrolled recorder to answer at all. Walked one at a time,
their wall clock is the SUM of the estate's latencies: the per-node budget is 8 s
and the documented estate is 8-16 recorders, so an estate that has gone quiet
takes a minute or two to say so — on an interactive page, and on exactly the page
an operator opens BECAUSE something is wrong. ``pulse/router.py`` already made
this argument and already fanned out; these two were the last node-walking reads
that had not.

Speed is only half of it, and the cheaper half to get right. The list an operator
actually acts on is ``unreachable``: which recorder, and why. Concurrency is where
that pairing is easiest to lose — ``gather(..., return_exceptions=True)`` hands
back bare exceptions with nothing on them saying which task raised, and a
mis-zipped result turns "north-recorder refused us, its credential is missing
vms.camera.read" into "something failed". So the timing assertions here sit next
to attribution assertions, and neither is allowed to pass alone.

No recorder runs. The federation client's two list calls are replaced with ones
that sleep a measurable time per node, so "concurrent" is observable as a number
rather than inferred from the code.
"""

from __future__ import annotations

import asyncio
import time
import uuid

import pytest
import pytest_asyncio

from app.vms.federation import client as fed
from app.vms.models import MediaNode

from .conftest import PREFIX, auth, client

pytestmark = pytest.mark.asyncio

TENANT = uuid.uuid4()

CAMERAS_URL = f"{PREFIX}/vms/federation/cameras"
NVRS_URL = f"{PREFIX}/vms/federation/nvrs"

# Four recorders, each answering in this long. Sequentially that is 4 × 0.25 s =
# 1.0 s before the first byte of the page; concurrently it is one 0.25 s wait.
DELAY = 0.25
NODE_COUNT = 4
# The bound the sequential version cannot meet and the concurrent one clears with
# room to spare. Not tight: the suite runs in a container on shared CPU, and a
# timing test that fails on a busy machine gets deleted rather than fixed.
CEILING = DELAY * 2


def _headers() -> dict:
    return auth(tenant_id=TENANT, permissions=["vms.camera.read"])


@pytest_asyncio.fixture
async def estate(http_sessionmaker):
    """Four online recorders, named so a result can be traced back to one."""
    names = [f"recorder-{i}" for i in range(NODE_COUNT)]
    async with http_sessionmaker() as s:
        for i, name in enumerate(names):
            s.add(
                MediaNode(
                    id=str(uuid.uuid4()),
                    tenant_id=TENANT,
                    name=name,
                    host=f"{name}.local",
                    api_url=f"http://{name}:8000",
                    credential=f"scoped-key-{i}",
                    status="online",
                )
            )
        await s.commit()
    return names


def _node_of(api_url: str) -> str:
    return api_url.removeprefix("http://").removesuffix(":8000")


@pytest.fixture
def recorders(monkeypatch):
    """Fabricated recorders with per-node behaviour, keyed by node name.

    ``answers(name, delay=..., cameras=..., raises=...)`` describes one; anything
    not described answers instantly with a single camera. Both estate list calls
    are patched from the same table so the two endpoints are tested against
    identical recorder behaviour.
    """
    behaviour: dict[str, dict] = {}
    # When each node's call STARTED and FINISHED, relative to the request. This is
    # what proves a slow node did not hold the others: not the total, but that the
    # quick ones were done while it was still running.
    spans: dict[str, tuple[float, float]] = {}
    origin = time.perf_counter()

    async def _call(api_url: str):
        name = _node_of(api_url)
        spec = behaviour.get(name, {})
        started = time.perf_counter() - origin
        await asyncio.sleep(spec.get("delay", 0.0))
        spans[name] = (started, time.perf_counter() - origin)
        if spec.get("raises") is not None:
            raise spec["raises"]
        return spec.get("payload", [{"id": f"cam-{name}", "name": f"{name} lobby"}])

    async def _cameras(api_url, credential=None, **kw):
        return await _call(api_url)

    async def _nvrs(api_url, credential=None, **kw):
        return {"items": await _call(api_url)}

    monkeypatch.setattr(fed, "list_estate_cameras", _cameras)
    monkeypatch.setattr(fed, "list_nvrs_node", _nvrs)

    class Rig:
        # Bound below: a class body cannot see the fixture's local.
        spans: dict = {}

        def answers(self, name: str, **spec):
            behaviour[name] = spec

        def reset_clock(self):
            nonlocal origin
            origin = time.perf_counter()
            spans.clear()

    rig = Rig()
    rig.spans = spans
    return rig


# ── wall time: the sum of the estate, or the slowest recorder in it ──────────


@pytest.mark.parametrize("url", [CAMERAS_URL, NVRS_URL])
async def test_the_estate_read_costs_one_recorder_not_all_of_them(
    app, estate, recorders, url
):
    for name in estate:
        recorders.answers(name, delay=DELAY)
    recorders.reset_clock()

    started = time.perf_counter()
    async with client(app) as c:
        r = await c.get(url, headers=_headers())
    elapsed = time.perf_counter() - started

    assert r.status_code == 200, r.text
    assert len(r.json()["items"]) == NODE_COUNT
    assert elapsed < CEILING, (
        f"{url} took {elapsed:.2f}s for {NODE_COUNT} recorders at {DELAY}s each — "
        f"that is the SUM, so the walk is still sequential. At the real 8s per-node "
        f"budget a sixteen-recorder estate would make an operator wait two minutes."
    )


@pytest.mark.parametrize("url", [CAMERAS_URL, NVRS_URL])
async def test_one_slow_recorder_does_not_hold_up_the_healthy_ones(
    app, estate, recorders, url
):
    """The failure mode that made this worth fixing: not "everything is slow", but
    "the one sick recorder made the twelve healthy ones look sick too"."""
    slow, *quick = estate
    recorders.answers(slow, delay=DELAY * 4)
    for name in quick:
        recorders.answers(name, delay=0.0)
    recorders.reset_clock()

    async with client(app) as c:
        r = await c.get(url, headers=_headers())

    assert r.status_code == 200, r.text
    slow_end = recorders.spans[slow][1]
    for name in quick:
        _, ended = recorders.spans[name]
        assert ended < slow_end, (
            f"{name} only finished at {ended:.2f}s, after the slow recorder's "
            f"{slow_end:.2f}s — it was queued behind it, not running alongside it"
        )


# ── attribution: WHICH recorder, and WHY ─────────────────────────────────────


@pytest.mark.parametrize("url", [CAMERAS_URL, NVRS_URL])
async def test_a_refusal_and_an_outage_are_reported_separately_against_the_right_node(
    app, estate, recorders, url
):
    """Two failures with different fixes, and each has to reach the operator whole.

    A refusal means the credential was minted without this reach: re-enrol, and
    retrying refuses forever. An outage is worth retrying. Reporting either one
    against the wrong recorder sends somebody to the wrong rack.
    """
    refuser, dead, *healthy = estate
    recorders.answers(
        refuser,
        delay=DELAY,  # the refusal also arrives LAST, so a zip by finish order mis-pairs
        raises=fed.NodeRefused(
            "recorder refused: missing permission vms.camera.read — re-enroll this node",
            status_code=403,
            missing_permission="vms.camera.read",
        ),
    )
    recorders.answers(dead, raises=fed.NodeUnavailable("[Errno 111] Connection refused"))
    recorders.reset_clock()

    async with client(app) as c:
        r = await c.get(url, headers=_headers())

    assert r.status_code == 200, r.text
    body = r.json()
    # A failing recorder is skipped, never fatal: the healthy ones still answer.
    assert {c["node_name"] for c in body["items"]} == set(healthy)
    assert body["nodes"] == NODE_COUNT

    by_name = {u["name"]: u for u in body["unreachable"]}
    assert set(by_name) == {refuser, dead}, "both failures must be named, separately"

    # The refusal keeps the node's own sentence — the missing grant and the fix —
    # and must never be dressed up as a transport failure.
    assert "vms.camera.read" in by_name[refuser]["error"]
    assert "re-enroll" in by_name[refuser]["error"]
    assert "Errno 111" not in by_name[refuser]["error"]
    # And the outage keeps the line that says which half of the network broke.
    assert by_name[dead]["error"] == "[Errno 111] Connection refused"

    # node_id travels with the name, or the console cannot link the row back to a
    # recorder — and it must be the id of THAT recorder, not of whichever one
    # happened to fail at the same moment.
    async with client(app) as c:
        rows = (await c.get(f"{PREFIX}/vms/federation/nodes", headers=_headers())).json()["items"]
    real_id = {row["name"]: row["id"] for row in rows}
    assert by_name[refuser]["node_id"] == real_id[refuser]
    assert by_name[dead]["node_id"] == real_id[dead]


@pytest.mark.parametrize("url", [CAMERAS_URL, NVRS_URL])
async def test_the_merged_list_still_runs_in_node_order_whatever_the_latencies(
    app, estate, recorders, url
):
    """Answering out of order must not REPORT out of order.

    Nothing downstream sorts this list — the console groups it by node and renders
    it as given — so the first recorder's cameras staying first is the difference
    between a stable camera rail and one that reshuffles itself on every 30 s
    refetch depending on which recorder happened to answer fastest.
    """
    for i, name in enumerate(estate):
        # Deliberately inverted: the FIRST node is the slowest to answer.
        recorders.answers(name, delay=DELAY - (i * DELAY / NODE_COUNT))
    recorders.reset_clock()

    async with client(app) as c:
        r = await c.get(url, headers=_headers())
        # The order the node walk itself sees, asked of the service rather than
        # assumed of the database.
        rows = (await c.get(f"{PREFIX}/vms/federation/nodes", headers=_headers())).json()["items"]

    assert r.status_code == 200, r.text
    assert [c["node_name"] for c in r.json()["items"]] == [row["name"] for row in rows]
