"""Federation client — the two functions every federated call now fails through.

Thirty-three copies of a try/except around an httpx call became ``_send``, and
thirty-one copies of a status-code decision became ``_raise_for_node``. That is a
good trade only while those two are right: before, a mistake in one copy was one
broken screen; now a mistake is every federated call in the product.

No node runs here. The client's ``httpx`` is replaced with one that answers from a
fixture, the same way test_federation_schedules.py does it — the real client, its
real error mapping, against a fabricated recorder.

What is pinned, and why each one is here rather than for the count:

  * a ReadTimeout NAMES ITSELF. ``str(httpx.ReadTimeout(""))`` is the empty string
    and a timeout is the commonest federated failure there is, so the commonest
    message the operator ever saw was "recorder unavailable: " — a sentence that
    stops at the colon;
  * a transport failure that DOES carry words keeps its own, so the fix above can
    never be turned into "always print the class name";
  * 401/403 is a REFUSAL and everything else is unavailable. The split is what the
    operator is told to do: a refusal means the credential was never granted this
    reach, so re-enrolling fixes it and retrying refuses forever;
  * on the estate surface (``_node_json``) EVERY 4xx is a refusal, not only
    401/403. That asymmetry is deliberate: a malformed schedule document reported
    as "recorder unavailable" sends somebody to look at the network for a
    validation error;
  * a 204 with no body is a SUCCESS answering ``{}``. The node returns 204 for a
    preset/tour/OSD/mask delete, and reading that as a missing payload turns every
    successful delete into an error.

Without these, each of the above can be reintroduced by a one-line edit in a file
that thirty-three call sites depend on and that no screen test would notice until
a recorder misbehaved in production.
"""

from __future__ import annotations

from types import SimpleNamespace

import httpx
import pytest

from app.vms.federation import client as fed

API = "http://recorder-a:8000"
CRED = "scoped-key"


@pytest.fixture
def recorder(monkeypatch):
    """A fabricated recorder behind the federation client's own httpx.

    The MODULE attribute is patched, not httpx itself: the ASGI test client used
    elsewhere in this suite is an httpx.AsyncClient too, and patching httpx
    globally would answer the fabricated recorder for requests meant for the
    service under test.
    """
    state = {"handler": lambda request: httpx.Response(200, json={"ok": True})}
    calls: list[httpx.Request] = []

    def dispatch(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return state["handler"](request)

    def factory(*args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(dispatch)
        return httpx.AsyncClient(*args, **kwargs)

    monkeypatch.setattr(
        fed,
        "httpx",
        SimpleNamespace(AsyncClient=factory, HTTPError=httpx.HTTPError, Response=httpx.Response),
    )

    class Rig:
        # Bound below: a class body cannot see the fixture's local.
        calls: list = []

        def answers(self, status: int, *, json=None, text: str | None = None):
            kw = {"json": json} if json is not None else {"text": text or ""}
            state["handler"] = lambda r: httpx.Response(status, **kw)

        def raises(self, exc: httpx.HTTPError):
            def boom(request):
                exc.request = request
                raise exc

            state["handler"] = boom

    rig = Rig()
    rig.calls = calls
    return rig


# ── which credential a call carries ──────────────────────────────────────────


async def test_a_node_with_its_own_credential_is_never_called_with_the_shared_secret(
    recorder,
):
    # The scoped per-node credential is what makes a recorder's refusals mean
    # anything: the ambient service JWT is the shared deployment secret and carries
    # superadmin, so falling back to it where a scoped key exists would quietly
    # widen every federated call past the grants the node issued.
    await fed.list_estate_cameras(API, CRED)
    headers = recorder.calls[-1].headers
    assert headers["x-node-credential"] == CRED
    assert "authorization" not in headers


async def test_a_node_that_has_not_issued_one_yet_is_still_reachable(recorder):
    # Enrolment has to happen somehow, and before it does the shared secret is the
    # only thing the node will accept.
    await fed.list_estate_cameras(API, None)
    headers = recorder.calls[-1].headers
    assert headers["authorization"].startswith("Bearer ")
    assert "x-node-credential" not in headers


# ── _transport_failure: the recorder never answered ──────────────────────────


async def test_a_timeout_names_itself_rather_than_stopping_at_the_colon(recorder):
    # httpx raises ReadTimeout carrying whatever httpcore said, and httpcore's own
    # timeout says nothing — so this really is what an operator hits, not a
    # contrived empty string.
    recorder.raises(httpx.ReadTimeout(""))
    with pytest.raises(fed.NodeUnavailable) as e:
        await fed.list_estate_cameras(API, CRED)
    assert str(e.value) == "ReadTimeout", (
        "a timeout with no message must fall back to the class name; without it the "
        "commonest federated failure reports an empty sentence"
    )


async def test_a_transport_failure_with_something_to_say_keeps_its_own_words(recorder):
    # The guard for the fix above: substituting the class name UNCONDITIONALLY would
    # pass the timeout test and throw away "connection refused", "[Errno -2] Name or
    # service not known" and every other line that says which half of the network is
    # broken.
    recorder.raises(httpx.ConnectError("[Errno 111] Connection refused"))
    with pytest.raises(fed.NodeUnavailable) as e:
        await fed.list_estate_cameras(API, CRED)
    assert str(e.value) == "[Errno 111] Connection refused"
    assert "ConnectError" != str(e.value)


# ── _raise_for_node: the recorder answered, and said no ──────────────────────


async def test_a_401_tells_the_operator_to_re_enrol_and_never_says_unavailable(recorder):
    recorder.answers(401, json={"error": {"code": "UNAUTHORIZED", "message": "bad token"}})
    with pytest.raises(fed.NodeRefused) as e:
        await fed.list_estate_cameras(API, CRED)
    assert e.value.status_code == 401
    message = str(e.value)
    assert "enroll" in message, "the operator must be told the fix, not the number"
    # The recorder ANSWERED. Calling that unavailable is what cost two rounds of live
    # debugging, twice, because it sends you to look at the network.
    assert "unavailable" not in message.lower()


async def test_a_refused_permission_is_named_so_the_re_enrolment_is_actionable(recorder):
    recorder.answers(
        403,
        json={"error": {"code": "FORBIDDEN", "message": "missing permission: vms.storage.read"}},
    )
    with pytest.raises(fed.NodeRefused) as e:
        await fed.list_estate_cameras(API, CRED)
    assert e.value.status_code == 403
    # The grant list is frozen at mint time, so "re-enrol" alone is not enough — the
    # operator has to know WHICH grant the recorder's set is missing before widening
    # it and re-enrolling is anything but guesswork.
    assert e.value.missing_permission == "vms.storage.read"
    assert "vms.storage.read" in str(e.value)
    assert "unavailable" not in str(e.value).lower()


async def test_a_refusal_is_still_caught_by_every_existing_except_node_unavailable(recorder):
    # Thirty-three call sites and the aggregator catch NodeUnavailable and skip the
    # node. If NodeRefused ever becomes a sibling instead of a subclass, a refused
    # recorder stops being a skipped node and becomes a 500 on a screen that lists
    # every other recorder fine.
    recorder.answers(403, text="nope")
    with pytest.raises(fed.NodeUnavailable):
        await fed.list_estate_cameras(API, CRED)


async def test_a_recorder_that_broke_is_unavailable_and_not_a_refusal(recorder):
    recorder.answers(500, text="boom")
    with pytest.raises(fed.NodeUnavailable) as e:
        await fed.list_estate_cameras(API, CRED)
    # Worth retrying, unlike a refusal, and the two must not be told apart by
    # reading the sentence.
    assert not isinstance(e.value, fed.NodeRefused)
    assert "500" in str(e.value)


async def test_a_detailed_call_repeats_the_nodes_sentence_not_its_json(recorder):
    recorder.answers(
        503,
        json={"error": {"code": "BUSY", "message": "the decoder is already running a search"}},
    )
    with pytest.raises(fed.NodeUnavailable) as e:
        await fed.motion_search_node(API, "cam-9", {"from": "a", "to": "b"}, credential=CRED)
    # detailed=True exists so these calls read out the one sentence the node wrote.
    # Without it the operator gets a truncated JSON document to parse by eye.
    assert str(e.value) == "503: the decoder is already running a search"


async def test_an_undetailed_call_does_not_invent_a_sentence(recorder):
    # The counterpart: most calls relay the raw body, and a node whose error shape we
    # do not know must not have one guessed for it.
    recorder.answers(502, text="upstream gateway died")
    with pytest.raises(fed.NodeUnavailable) as e:
        await fed.list_estate_cameras(API, CRED)
    assert str(e.value) == "502: upstream gateway died"


# ── _node_json: the estate surface, where the rule is stricter ───────────────


async def test_every_4xx_on_the_estate_surface_is_a_refusal(recorder):
    # A schedule the node cannot parse. 422 is not 401/403, so the generic rule would
    # call it unavailable — and the operator would go and check the network for a
    # validation error while the recorder sat there, healthy, explaining itself.
    recorder.answers(
        422,
        json={"error": {"code": "VALIDATION_ERROR", "message": "monday is not a list of spans"}},
    )
    with pytest.raises(fed.NodeRefused) as e:
        await fed.create_schedule_template(API, {"name": "x"}, credential=CRED)
    assert e.value.status_code == 422
    assert "monday is not a list of spans" in str(e.value)
    assert "unavailable" not in str(e.value).lower()


async def test_a_missing_template_is_a_refusal_too_and_not_a_dead_recorder(recorder):
    recorder.answers(404, json={"error": {"code": "NOT_FOUND", "message": "no such template"}})
    with pytest.raises(fed.NodeRefused) as e:
        await fed.delete_schedule_template(API, "gone", credential=CRED)
    assert e.value.status_code == 404


async def test_the_estate_surface_still_calls_a_5xx_unavailable(recorder):
    # The other side of the asymmetry. Only a 5xx or a transport failure means the
    # next try could differ, which is what the router's 503 claims and its 502 does
    # not — so widening "every 4xx" into "every non-2xx" would promise a retry that
    # can never succeed.
    recorder.answers(500, json={"error": {"message": "disk controller reset"}})
    with pytest.raises(fed.NodeUnavailable) as e:
        await fed.list_schedule_templates(API, credential=CRED)
    assert not isinstance(e.value, fed.NodeRefused)
    assert "disk controller reset" in str(e.value)


async def test_a_204_delete_is_a_success_that_answers_an_empty_dict(recorder):
    # The node returns 204 for a preset/tour/OSD/mask delete. Treating no body as a
    # missing payload would fail every successful delete on the PTZ tab.
    recorder.answers(204)
    assert await fed.delete_ptz_preset_node(API, "cam-9", "p1", credential=CRED) == {}


async def test_a_2xx_with_an_empty_body_is_a_success_as_well(recorder):
    # Same fact without the status code to lean on: some nodes answer 200 and close.
    recorder.answers(200, text="")
    assert await fed.delete_ptz_tour_node(API, "cam-9", "t1", credential=CRED) == {}


async def test_a_2xx_that_is_not_json_says_so_instead_of_answering_nothing(recorder):
    # A proxy's HTML error page arriving as 200 is the realistic case. Swallowing it
    # into {} would show an operator an empty, plausible-looking PTZ tab.
    recorder.answers(200, text="<html>502 Bad Gateway</html>")
    with pytest.raises(fed.NodeUnavailable) as e:
        await fed.list_ptz_presets_node(API, "cam-9", credential=CRED)
    assert "non-JSON" in str(e.value)


# ── pairing: reached-and-refused is not unreachable ──────────────────────────


async def test_a_refused_pairing_code_is_the_operators_to_fix_not_the_networks(recorder):
    # Onboarding rides out an unreachable recorder and must NOT ride out a wrong
    # code: retrying a spent code forever registers nothing and explains nothing.
    recorder.answers(400, json={"error": {"code": "BAD_CODE", "message": "this code was used"}})
    with pytest.raises(fed.NodePairingRejected) as e:
        await fed.pair_node(API, "123456")
    assert "this code was used" in str(e.value)
    assert not isinstance(e.value, fed.NodeUnavailable)


async def test_a_pairing_that_returns_no_credential_is_not_reported_as_success(recorder):
    # The credential is surfaced exactly once. A 201 without one would otherwise
    # store a node row with an empty key that fails on every later call instead.
    recorder.answers(201, json={"id": "cred-1", "label": "Neubit VMS"})
    with pytest.raises(fed.NodePairingRejected):
        await fed.pair_node(API, "123456")
