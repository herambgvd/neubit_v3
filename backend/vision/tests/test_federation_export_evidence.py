"""Chain-of-custody over federation: verify, the signing key, and the manifest.

An export's evidence value rests on three things the VMS cannot supply itself. The
clip lives on the RECORDER's disk, the recorder signs the manifest with ITS key, and
the re-hash has to run against those bytes — a hash of a copy relayed through the VMS
would only prove the copy arrived intact, which is not the question anyone is asking.

So all three are proxied, and these tests hold the two properties that makes worth
having: the call reaches the right recorder with the scoped credential, and the
manifest comes back BYTE FOR BYTE. The signature covers the document's canonical
encoding, so parsing it into a dict here and re-encoding it would break offline
verification while looking perfectly fine in a JSON diff.
"""

from __future__ import annotations

import json

import httpx
import pytest

from .conftest import PREFIX, auth, client

# The recorder rig, the registered node and the admin token are this module's too —
# imported rather than rebuilt so a change to the fixture cannot leave one of the two
# federation test modules testing against a stale fabrication. ``app`` comes from
# conftest, so it needs no import here.
from .test_federation_device import (  # noqa: F401 — node/recorder are fixtures
    CAM,
    NODE_ID,
    TENANT_A,
    TENANT_B,
    _admin,
    node,
    recorder,
)

EXPORT_ID = "exp-42"
FED = f"{PREFIX}/vms/federation/nodes/{NODE_ID}"


async def test_verify_reaches_the_recorder_with_the_scoped_credential(app, node, recorder):
    recorder.json({"valid": True, "reason": "", "public_key": "abc123", "signed_by_this_node": True})
    async with client(app) as c:
        r = await c.post(f"{FED}/exports/{EXPORT_ID}/verify", headers=_admin())

    assert r.status_code == 200
    body = r.json()
    assert body["valid"] is True
    # Tagged, like every federated payload, so a merged multi-recorder view can say
    # which box vouched for this clip.
    assert body["node_id"] == NODE_ID
    call = recorder.calls[-1]
    assert call["method"] == "POST"
    assert call["url"] == f"http://recorder-a:8000/api/v1/nvr/estate/exports/{EXPORT_ID}/verify"
    assert call["headers"]["x-node-credential"] == "scoped-key"


async def test_a_failed_verification_is_a_200_with_its_reason(app, node, recorder):
    """"This clip cannot be verified" is an ANSWER. Mapping it to an error status
    would tell an operator the check did not run, when in fact it ran and failed —
    the one outcome they most need to see."""
    recorder.json(
        {
            "valid": False,
            "reason": "tampered",
            "expected_sha256": "aa" * 32,
            "actual_sha256": "bb" * 32,
        }
    )
    async with client(app) as c:
        r = await c.post(f"{FED}/exports/{EXPORT_ID}/verify", headers=_admin())

    assert r.status_code == 200
    assert r.json()["reason"] == "tampered"


async def test_the_manifest_is_relayed_byte_for_byte(app, node, recorder):
    """The signature covers the document's canonical bytes.

    This is asserted on the RAW body, not on a parsed dict: re-encoding through
    Python would reorder nothing today and still be wrong, because the guarantee is
    about the bytes and nothing in the language keeps that stable across versions.
    The fabricated document below is deliberately formatted oddly — extra spacing
    and a trailing newline — so a re-serialisation cannot accidentally match.
    """
    raw = b'{\n  "manifest" : {"schema": "neubit-nvr/export-manifest/1"},\n  "signature": {}\n}\n'

    def respond(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            content=raw,
            headers={
                "content-type": "application/json",
                "content-disposition": 'attachment; filename="gate-cam.manifest.json"',
            },
        )

    recorder.respond(respond)
    async with client(app) as c:
        r = await c.get(f"{FED}/exports/{EXPORT_ID}/manifest", headers=_admin())

    assert r.status_code == 200
    assert r.content == raw, "the manifest must not be re-serialised on its way through"
    assert 'filename="gate-cam.manifest.json"' in r.headers["content-disposition"]
    # Sanity: the fabricated bytes really are not what a re-encode would produce.
    assert json.dumps(json.loads(raw)).encode() != raw


async def test_the_public_key_is_per_recorder(app, node, recorder):
    """Each recorder signs with its own identity, so the key is fetched from the node
    that produced the clip — there is no single VMS key that could stand in for it
    without misstating who vouched for a given export."""
    recorder.json({"algorithm": "ed25519", "key_id": "0123456789abcdef", "public_key": "0" * 64})
    async with client(app) as c:
        r = await c.get(f"{FED}/exports/public-key", headers=_admin())

    assert r.status_code == 200
    assert r.json()["algorithm"] == "ed25519"
    assert r.json()["node_id"] == NODE_ID
    assert recorder.calls[-1]["url"] == "http://recorder-a:8000/api/v1/nvr/estate/exports/public-key"


@pytest.mark.parametrize(
    "method,path",
    [
        ("POST", f"/exports/{EXPORT_ID}/verify"),
        ("GET", f"/exports/{EXPORT_ID}/manifest"),
        ("GET", "/exports/public-key"),
    ],
)
async def test_an_unreachable_recorder_is_a_clean_503(app, node, recorder, method, path):
    recorder.down()
    async with client(app) as c:
        r = await c.request(method, FED + path, headers=_admin())
    assert r.status_code == 503


@pytest.mark.parametrize(
    "method,path",
    [
        ("POST", f"/exports/{EXPORT_ID}/verify"),
        ("GET", f"/exports/{EXPORT_ID}/manifest"),
        ("GET", "/exports/public-key"),
    ],
)
async def test_gated_and_tenant_scoped(app, node, recorder, method, path):
    async with client(app) as c:
        viewer = await c.request(
            method, FED + path,
            headers=auth(tenant_id=TENANT_A, permissions=["vms.camera.read"]),
        )
        stranger = await c.request(method, FED + path, headers=_admin(TENANT_B))
    assert viewer.status_code == 403
    # Another tenant's recorder is NOT FOUND, not forbidden: a 403 would confirm the
    # node id exists.
    assert stranger.status_code == 404
    assert not recorder.calls


# ── the watermark option ─────────────────────────────────────────────────────
#
# A watermark is the operator's choice per export, and it costs something real: the
# recorder must RE-ENCODE, so the clip stops being bit-identical to the recorded
# segments and the job takes materially longer. That makes "was it asked for?" a
# question the wire has to answer unambiguously — a default that leaked through as
# true would silently re-encode every export in the estate.


async def test_watermark_is_off_unless_asked_for(app, node, recorder):
    recorder.json({"id": "exp-1", "status": "pending"})
    async with client(app) as c:
        r = await c.post(f"{FED}/cameras/{CAM}/exports",
                         json={"from": "2026-07-09T10:00:00Z", "to": "2026-07-09T10:01:00Z"},
                         headers=_admin())
    assert r.status_code == 200
    sent = json.loads(recorder.calls[-1]["content"])
    assert sent["watermark"] is False


async def test_watermark_is_forwarded_when_asked_for(app, node, recorder):
    recorder.json({"id": "exp-1", "status": "pending"})
    async with client(app) as c:
        r = await c.post(f"{FED}/cameras/{CAM}/exports",
                         json={"from": "2026-07-09T10:00:00Z", "to": "2026-07-09T10:01:00Z",
                               "watermark": True},
                         headers=_admin())
    assert r.status_code == 200
    sent = json.loads(recorder.calls[-1]["content"])
    assert sent["watermark"] is True
    # The window and camera still travel intact alongside it.
    assert sent["camera_id"] == CAM and sent["from"].startswith("2026-07-09T10:00")
