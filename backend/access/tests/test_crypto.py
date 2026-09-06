"""Controller credentials at rest.

The old cipher was an unauthenticated HMAC keystream keyed from VE_JWT_SECRET, and
a failed decrypt returned "". So rotating the token secret — routine — silently
re-keyed every credential, and every connector then authenticated with an empty
password while the log said "401 from controller".

These pin the replacement: per-tenant Fernet, legacy rows still readable, and a
rotation that fails loudly instead of quietly.
"""

from __future__ import annotations

import hashlib
import hmac
import os
import uuid

import pytest

from app.access.crypto import decrypt_secret, encrypt_secret


TENANT_A = uuid.uuid4()
TENANT_B = uuid.uuid4()


def test_a_secret_round_trips():
    stored = encrypt_secret(TENANT_A, "hunter2")
    assert stored != "hunter2"
    assert decrypt_secret(TENANT_A, stored) == "hunter2"


def test_the_stored_form_is_marked_and_versioned():
    """The marker is what lets decrypt tell ciphertext from a legacy plaintext row
    instead of guessing."""
    assert encrypt_secret(TENANT_A, "hunter2").startswith("enc:v1:")


def test_one_tenants_key_does_not_open_anothers():
    """The per-tenant requirement, asserted as a raise rather than as
    "the output differs" — the old implementation satisfied that by returning the
    ciphertext unchanged."""
    from kernel.secrets import SecretDecryptError

    stored = encrypt_secret(TENANT_A, "hunter2")
    with pytest.raises(SecretDecryptError):
        decrypt_secret(TENANT_B, stored)


def test_a_rotated_key_raises_instead_of_returning_an_empty_password():
    """The failure that used to be invisible. An empty password reaches the
    controller and comes back 401 with nothing naming the cause."""
    from kernel.secrets import SecretDecryptError

    stored = encrypt_secret(TENANT_A, "hunter2")
    tampered = stored[:-4] + ("AAAA" if not stored.endswith("AAAA") else "BBBB")
    with pytest.raises(SecretDecryptError):
        decrypt_secret(TENANT_A, tampered)


def test_nothing_stored_is_the_empty_string():
    assert decrypt_secret(TENANT_A, None) == ""
    assert decrypt_secret(TENANT_A, "") == ""


def test_a_never_encrypted_value_passes_through():
    """A row written before encryption existed. Returned as-is, because a deploy
    that cannot read what it wrote yesterday is an outage."""
    assert decrypt_secret(TENANT_A, "plaintext-password") == "plaintext-password"


def _legacy_encrypt(plain: str) -> str:
    """The old cipher, reproduced here so the compatibility path is tested against
    a real old value rather than against an assumption about its shape."""
    from kernel.config import get_settings

    key = hashlib.sha256(get_settings().jwt_secret.encode()).digest()
    nonce = os.urandom(16)
    out = bytearray()
    counter = 0
    while len(out) < len(plain.encode()):
        out.extend(hmac.new(key, nonce + counter.to_bytes(4, "big"), hashlib.sha256).digest())
        counter += 1
    ct = bytes(a ^ b for a, b in zip(plain.encode(), bytes(out)))
    return f"enc:{nonce.hex()}:{ct.hex()}"


def test_a_legacy_row_still_decrypts():
    """Existing deployments hold these. Breaking them would take every controller
    offline at once."""
    assert decrypt_secret(TENANT_A, _legacy_encrypt("old-password")) == "old-password"


def test_a_legacy_row_is_not_mistaken_for_the_new_format():
    legacy = _legacy_encrypt("old-password")
    assert legacy.startswith("enc:") and not legacy.startswith("enc:v1:")
    assert decrypt_secret(TENANT_A, legacy) == "old-password"


def test_a_corrupt_legacy_row_is_empty_not_an_exception():
    """Lenient only on this path: it sees rows that predate the change and there is
    nothing an operator can do about a corrupt one."""
    assert decrypt_secret(TENANT_A, "enc:nothex:alsonothex") == ""
    assert decrypt_secret(TENANT_A, "enc:deadbeef") == ""


def test_a_platform_row_has_its_own_key():
    """tenant_id NULL is the platform, and must not collide with a tenant."""
    stored = encrypt_secret(None, "platform-password")
    assert decrypt_secret(None, stored) == "platform-password"
    from kernel.secrets import SecretDecryptError

    with pytest.raises(SecretDecryptError):
        decrypt_secret(TENANT_A, stored)


def test_every_call_site_passes_a_tenant():
    """The signature changed from one argument to two. A missed call site is a
    TypeError at runtime on a path no test reaches — which is how this shipped
    broken once already."""
    import pathlib
    import re

    app_dir = pathlib.Path(__file__).resolve().parents[1] / "app"
    bad = []
    for f in app_dir.rglob("*.py"):
        if f.name == "crypto.py":
            continue
        for i, line in enumerate(f.read_text().splitlines(), 1):
            if re.search(r"\b(en|de)crypt_secret\(", line) and "tenant_id" not in line:
                bad.append(f"{f.relative_to(app_dir)}:{i}")
    assert not bad, "call sites not passing a tenant:\n" + "\n".join(bad)


# --- the access-group api_key ------------------------------------------------
#
# AccessGroup.api_key is a credential. It was stored in plaintext, returned in
# AccessGroupPublic, and rendered into a table column by the operator UI.


async def test_a_group_api_key_is_encrypted_at_rest(session):
    import uuid as _uuid

    from app.access.catalog import AccessGroupCatalog
    from app.access.models import AccessGroup, Instance
    from kernel.auth import Scope

    tenant = _uuid.uuid4()
    inst = Instance(
        tenant_id=tenant, brand="dds", name="c1", base_url="https://c.example",
        auth_type="basic", username="u", verify_tls=True, is_active=True, status="unknown",
    )
    session.add(inst)
    await session.commit()
    await session.refresh(inst)

    cat = AccessGroupCatalog(session, Scope(tenant_id=tenant, is_superadmin=False))
    row = await cat.create(inst.id, {"name": "G", "api_key": "s3cret", "door_ids": []})

    stored = (await session.get(AccessGroup, row.id)).api_key
    assert stored != "s3cret"
    assert stored.startswith("enc:v1:")
    assert decrypt_secret(tenant, stored) == "s3cret"


async def test_the_group_response_never_carries_the_key(session):
    """It was rendered into a table column in the operator UI."""
    from app.access.schemas import AccessGroupPublic

    class _Row:
        id = "g1"
        name = "G"
        description = None
        access_group_type = "Door"
        api_key = "enc:v1:whatever"
        door_ids: list[str] = []
        schedule_id = None
        created_at = updated_at = __import__("datetime").datetime.now()

    out = AccessGroupPublic.from_row(_Row()).model_dump()
    assert "api_key" not in out
    assert out["has_api_key"] is True

    _Row.api_key = None
    assert AccessGroupPublic.from_row(_Row()).model_dump()["has_api_key"] is False


async def test_an_edit_that_omits_the_key_keeps_it(session):
    """The response carries has_api_key, so an ordinary edit round-trips nothing
    to overwrite the credential with — and must not blank it either."""
    import uuid as _uuid

    from app.access.catalog import AccessGroupCatalog
    from app.access.models import AccessGroup, Instance
    from kernel.auth import Scope

    tenant = _uuid.uuid4()
    inst = Instance(
        tenant_id=tenant, brand="dds", name="c2", base_url="https://c.example",
        auth_type="basic", username="u", verify_tls=True, is_active=True, status="unknown",
    )
    session.add(inst)
    await session.commit()
    await session.refresh(inst)

    cat = AccessGroupCatalog(session, Scope(tenant_id=tenant, is_superadmin=False))
    row = await cat.create(inst.id, {"name": "G", "api_key": "s3cret", "door_ids": []})

    await cat.update(inst.id, row.id, {"name": "Renamed"})
    fresh = await session.get(AccessGroup, row.id)
    assert fresh.name == "Renamed"
    assert decrypt_secret(tenant, fresh.api_key) == "s3cret"

    # …and a real rotation still lands.
    await cat.update(inst.id, row.id, {"api_key": "rotated"})
    fresh = await session.get(AccessGroup, row.id)
    assert decrypt_secret(tenant, fresh.api_key) == "rotated"
