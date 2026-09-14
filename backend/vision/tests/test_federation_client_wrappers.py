"""The federation wrappers that do something — and only those.

``client.py`` is roughly ninety functions and most of them are one line: build a
URL, hand it to ``_node_json``, return the body. Those are NOT tested here, on
purpose. ``_node_json`` and ``_send`` — the 204, the non-JSON body, the 4xx/5xx
split, the credential header — are already pinned in test_federation_client_errors.py,
and a test per wrapper asserting "this one built that URL" restates the wrapper's
source in a second place and fails only when someone fixes a path.

What is left after subtracting those is small and load-bearing. Each function
below carries logic that no other test reaches, and each one has a failure mode
that looks like a working screen:

  * ``snapshot_node`` DECODES a data URI. The node answers JSON with a base64
    image; the browser needs bytes and a content type. Every branch of that decode
    ends in either an image or a NodeUnavailable — never a plausible empty frame.
  * ``ptz_node`` allow-lists the action. It is interpolated into the node's URL, so
    the guard is what stops a caller choosing a path segment on the recorder.
  * ``download_export_node`` parses the node's Content-Disposition. Get it wrong
    and an operator's evidence clip saves as a file the case file cannot use.
  * ``get_upstream_nvr_storage`` answers None on a 404 — that endpoint does not
    exist on every recorder yet, and a raise there takes a whole storage page down.
  * ``talk_uplink_node`` is the only call in the module that bypasses
    ``_node_json``: it STREAMS the microphone and must not inherit the 8-second
    control-call timeout, which would cut a talk off mid-sentence.
  * ``motion_search_node`` decodes footage and gets its own 120 s budget for the
    same reason, in the other direction.
  * the credential-management calls authenticate with the SHARED service JWT and
    not the scoped node credential, which the recorder deliberately does not let
    near ``settings.manage``.

The recorder rig is imported rather than rebuilt, so there is one fabricated
recorder in this suite and not two.
"""

from __future__ import annotations

import base64

import httpx
import pytest

from app.vms.federation import client as fed

from .test_federation_client_errors import API, CRED, recorder  # noqa: F401 — fixture

JPEG = b"\xff\xd8\xff\xe0 not really a jpeg, but bytes are bytes"


# ── snapshot: JSON data URI in, image bytes out ──────────────────────────────


async def test_a_snapshot_comes_back_as_bytes_and_the_type_the_node_declared(recorder):
    # The node answers JSON. If this returned the data URI instead of decoding it,
    # the grid would render a broken image for every federated camera.
    uri = "data:image/png;base64," + base64.b64encode(JPEG).decode()
    recorder.answers(200, json={"image": uri, "captured_at": "now"})

    raw, content_type = await fed.snapshot_node(API, "cam-9", credential=CRED)
    assert raw == JPEG
    # Declared as PNG by the node, so it must not be relabelled image/jpeg — the
    # browser is handed this verbatim.
    assert content_type == "image/png"


async def test_a_snapshot_without_a_type_falls_back_to_jpeg_rather_than_empty(recorder):
    recorder.answers(200, json={"image": "data:;base64," + base64.b64encode(JPEG).decode()})
    raw, content_type = await fed.snapshot_node(API, "cam-9", credential=CRED)
    assert raw == JPEG
    # An empty content type is served as a download prompt, not a picture.
    assert content_type == "image/jpeg"


async def test_a_node_that_answers_without_an_image_is_an_error_not_a_blank_frame(recorder):
    # The camera is offline and the recorder says so in JSON. Returning b"" here
    # would cache an empty frame and show the operator a black tile that looks
    # like a working stream with nothing in front of it.
    recorder.answers(200, json={"captured_at": "now", "error": "camera unreachable"})
    with pytest.raises(fed.NodeUnavailable) as e:
        await fed.snapshot_node(API, "cam-9", credential=CRED)
    assert "no snapshot image" in str(e.value)


async def test_an_undecodable_snapshot_says_so_instead_of_raising_a_binascii_error(recorder):
    # A truncated data URI is a 500 on the VMS if it escapes as binascii.Error;
    # as NodeUnavailable it is the 502 the router already knows how to render.
    recorder.answers(200, json={"image": "data:image/jpeg;base64,!!!not-base64!!!"})
    with pytest.raises(fed.NodeUnavailable) as e:
        await fed.snapshot_node(API, "cam-9", credential=CRED)
    assert "could not decode" in str(e.value)


async def test_a_refresh_asks_the_recorder_for_a_new_frame_and_a_plain_call_does_not(recorder):
    # refresh=1 makes the recorder talk to the camera. Sending it on every call
    # would mean sixteen device round-trips each time a grid repaints.
    recorder.answers(200, json={"image": "data:image/jpeg;base64," + base64.b64encode(JPEG).decode()})
    await fed.snapshot_node(API, "cam-9", credential=CRED)
    assert "refresh" not in recorder.calls[-1].url.params
    await fed.snapshot_node(API, "cam-9", refresh=True, credential=CRED)
    assert recorder.calls[-1].url.params["refresh"] == "1"


# ── ptz: the action is a path segment on someone else's box ──────────────────


@pytest.mark.parametrize("action", ["zoom", "focus", "../../../shutdown", "", "reboot"])
async def test_an_action_the_node_does_not_mount_never_leaves_this_process(recorder, action):
    # The action is interpolated into the recorder's URL. The allow-list is the
    # only thing between a caller-supplied string and a path segment on a machine
    # that trusts this console — and "zoom"/"focus" are the honest mistakes it also
    # catches, since neither is a route (zoom is a field in the move body).
    before = len(recorder.calls)
    with pytest.raises(fed.NodeUnavailable) as e:
        await fed.ptz_node(API, "cam-9", action, {"pan": 1}, credential=CRED)
    assert "unsupported ptz action" in str(e.value)
    assert len(recorder.calls) == before, "a refused action must not reach the recorder"


async def test_the_two_actions_the_node_does_mount_are_passed_through(recorder):
    # The control for the allow-list above: without it, "the guard rejects
    # everything" would also pass.
    for action in ("move", "stop"):
        await fed.ptz_node(API, "cam-9", action.upper(), {"pan": 1}, credential=CRED)
        # Case-folded, because an operator's payload is not a protocol.
        assert recorder.calls[-1].url.path.endswith(f"/cameras/cam-9/ptz/{action}")


# ── export download: the filename an operator's evidence is saved under ──────


async def test_an_export_keeps_the_filename_the_recorder_gave_it(recorder):
    recorder.answers(
        200,
        content=b"mp4-bytes",
        headers={
            "content-type": "video/mp4; charset=binary",
            "content-disposition": 'attachment; filename="cam-9_2026-09-14.mp4"',
        },
    )
    body, media_type, filename = await fed.download_export_node(API, "exp-42", credential=CRED)
    assert body == b"mp4-bytes"
    # The parameters after the semicolon are not part of a media type.
    assert media_type == "video/mp4"
    assert filename == "cam-9_2026-09-14.mp4", "the quotes are syntax, not part of the name"


async def test_an_export_with_no_disposition_still_saves_under_a_usable_name(recorder):
    # Some recorders send the body and nothing else. A blank filename reaches the
    # browser as a download called after the route, or none at all.
    recorder.answers(200, content=b"mp4-bytes", headers={"content-type": "video/mp4"})
    _body, media_type, filename = await fed.download_export_node(API, "exp-42", credential=CRED)
    assert filename == "export-exp-42.mp4"
    assert media_type == "video/mp4"


async def test_an_empty_filename_parameter_does_not_produce_a_nameless_download(recorder):
    recorder.answers(
        200, content=b"mp4-bytes",
        headers={"content-disposition": 'attachment; filename=""'},
    )
    _body, _media, filename = await fed.download_export_node(API, "exp-42", credential=CRED)
    assert filename == "export-exp-42.mp4"


# ── a recorder that has not grown the endpoint yet ───────────────────────────


async def test_an_upstream_nvrs_storage_is_absent_rather_than_broken_on_a_404(recorder):
    # This route is still being built node-side, so a recorder answering 404 is the
    # NORMAL case. Raising would fail the whole storage page for a section that was
    # always optional.
    recorder.answers(404, json={"error": {"message": "not found"}})
    assert await fed.get_upstream_nvr_storage(API, "nvr-1", credential=CRED) is None


async def test_an_upstream_nvr_that_errors_is_still_reported(recorder):
    # The counterpart: swallowing every failure into None would hide a recorder
    # whose disks it cannot read behind the same blank section.
    recorder.answers(500, text="raid controller reset")
    with pytest.raises(fed.NodeUnavailable):
        await fed.get_upstream_nvr_storage(API, "nvr-1", credential=CRED)


# ── talk uplink: the one streamed call ───────────────────────────────────────


async def _mic():
    yield b"\x01\x02"
    yield b"\x03\x04"


async def test_a_talk_uplink_is_streamed_to_the_recorder_and_not_buffered_first(recorder):
    # A press is open-ended. Buffering it would cap how long an operator may hold
    # the button and delay every frame until they let go — audible as a late,
    # truncated talk rather than as an error.
    recorder.answers(200, json={"talked": True, "frames_sent": 2})
    out = await fed.talk_uplink_node(API, "cam-9", _mic(), credential=CRED)

    assert out == {"talked": True, "frames_sent": 2}
    sent = recorder.calls[-1]
    assert sent.content == b"\x01\x02\x03\x04"
    assert sent.headers["content-type"] == "application/octet-stream"
    # A buffered body carries a Content-Length; a streamed one is chunked.
    assert sent.headers.get("transfer-encoding") == "chunked"
    assert "content-length" not in sent.headers
    # Still the scoped credential — streaming is not a reason to fall back to the
    # shared superadmin secret.
    assert sent.headers["x-node-credential"] == CRED


async def test_a_talk_press_is_not_cut_off_by_the_control_call_timeout(recorder):
    # _TIMEOUT is 8 s and right for a control call. Inheriting it here ends a talk
    # mid-sentence with a ReadTimeout the operator reads as "the recorder died".
    recorder.answers(200, json={"talked": True})
    await fed.talk_uplink_node(API, "cam-9", _mic(), credential=CRED)
    assert recorder.client_kwargs[-1]["timeout"] is None

    # And an explicit budget is honoured, so a caller that wants a bound gets one.
    await fed.talk_uplink_node(API, "cam-9", _mic(), credential=CRED, timeout=30.0)
    assert recorder.client_kwargs[-1]["timeout"] == 30.0


async def test_a_talk_uplink_that_answers_html_says_so_rather_than_reporting_silence(recorder):
    # This call does not go through _node_json, so it needs its own non-JSON guard;
    # without it a proxy's error page returns {} and the console shows a successful
    # talk that nobody heard.
    recorder.answers(200, text="<html>502</html>")
    mic = _mic()
    with pytest.raises(fed.NodeUnavailable) as e:
        await fed.talk_uplink_node(API, "cam-9", mic, credential=CRED)
    assert "non-JSON" in str(e.value)


async def test_a_refused_talk_reads_out_the_recorders_own_sentence(recorder):
    # A node with no talk transport configured answers an honest 501. The operator
    # needs to read "the path is not built", not a status code.
    recorder.answers(501, json={"error": {"message": "no talk transport configured"}})
    mic = _mic()
    with pytest.raises(fed.NodeUnavailable) as e:
        await fed.talk_uplink_node(API, "cam-9", mic, credential=CRED)
    assert str(e.value) == "501: no talk transport configured"


async def test_a_motion_search_gets_a_search_budget_and_not_a_control_one(recorder):
    # The node decodes recorded footage to answer this. At 8 s every search over a
    # real window times out, and a timeout here reads as an unavailable recorder.
    recorder.answers(200, json={"hits": [], "complete": True, "method": "pixel-difference"})
    await fed.motion_search_node(API, "cam-9", {"from": "a", "to": "b"}, credential=CRED)
    assert recorder.client_kwargs[-1]["timeout"] == 120.0
    assert recorder.client_kwargs[-1]["timeout"] != fed._TIMEOUT


# ── which key each surface presents ──────────────────────────────────────────


async def test_credential_management_speaks_with_the_shared_secret_not_the_scoped_key(
    recorder,
):
    # These routes are gated node-side on settings.manage, which a federation
    # credential deliberately does NOT carry. "Consistency" — routing them through
    # _headers like every neighbouring call — turns credential administration into
    # a permanent 403 on every recorder that has issued one.
    recorder.answers(200, json={"items": [{"id": "c1", "label": "Neubit VMS"}]})
    creds = await fed.list_node_credentials(API)
    assert creds == [{"id": "c1", "label": "Neubit VMS"}]

    recorder.answers(204)
    await fed.revoke_node_credential(API, "c1")
    recorder.answers(200, json={"id": "c1", "label": "renamed"})
    await fed.rename_node_credential(API, "c1", "renamed")

    for call in recorder.calls[-3:]:
        assert call.headers["authorization"].startswith("Bearer ")
        assert "x-node-credential" not in call.headers


async def test_a_rename_sends_only_the_label(recorder):
    # The recorder refuses anything else on this route, so a wrapper that grew a
    # second field would fail every rename — and the point of the route is that it
    # can never widen a credential.
    recorder.answers(200, json={"id": "c1"})
    await fed.rename_node_credential(API, "c1", "Front desk VMS")
    import json as _json

    assert _json.loads(recorder.calls[-1].content) == {"label": "Front desk VMS"}


async def test_an_enrolment_that_returns_no_credential_is_not_stored_as_success(recorder):
    # The credential is surfaced exactly once. A 201 without one would otherwise be
    # written to the node row as None and fail on every later call instead — at
    # which point the enrolment that caused it is long past.
    recorder.answers(201, json={"id": "cred-1", "label": "Neubit VMS", "grants": []})
    with pytest.raises(fed.NodeUnavailable) as e:
        await fed.enroll_node_full(API)
    assert "no credential" in str(e.value)


async def test_an_estate_that_answers_without_an_items_key_is_empty_not_a_crash(recorder):
    # The aggregator walks every recorder in the estate. A node answering {} —
    # older build, or a genuinely empty estate — must cost that node's cameras and
    # not the whole list.
    recorder.answers(200, json={})
    assert await fed.list_estate_cameras(API, CRED) == []
