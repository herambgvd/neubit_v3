"""A report export must not be a permanent capability URL.

`GET /reports/{id}/download` checks `report.export` and returns a link to
`/files/reports/<uuid>.<fmt>`, a route with no auth dependency, so without a
signature the permission gates only the first fetch and anyone who later obtains
the link holds the tenant's data forever.

The rule is per-prefix, not blanket: keys under `signed_url_prefixes` need an
unexpired `?exp=&sig=`, while avatars and logos stay plain because a browser loads
them from an `<img>` with no token. Both directions are asserted here.
"""


import time

import pytest

from app.auth.models import User
from app.core import storage as storage_mod
from app.core.storage import LocalStorage, sign_key, signature_is_valid
from conftest import api_client

pytestmark = pytest.mark.asyncio


@pytest.fixture(autouse=True)
def writable_storage(tmp_path, monkeypatch):
    from app.core import config

    monkeypatch.setenv("VE_STORAGE_LOCAL_DIR", str(tmp_path / "storage"))
    config.get_settings.cache_clear()
    storage_mod.get_storage.cache_clear()
    yield
    config.get_settings.cache_clear()
    storage_mod.get_storage.cache_clear()


# --- the signature itself ----------------------------------------------------


async def test_a_valid_signature_verifies_and_a_tampered_one_does_not():
    key = "reports/abc.csv"
    exp = int(time.time()) + 60
    sig = sign_key(key, exp)
    assert signature_is_valid(key, str(exp), sig)
    # Same signature, different file — the key is inside the signed payload.
    assert not signature_is_valid("reports/other.csv", str(exp), sig)
    # Same signature, later expiry — the expiry is inside it too, so a client
    # cannot extend its own link by editing the query string.
    assert not signature_is_valid(key, str(exp + 3600), sig)
    assert not signature_is_valid(key, str(exp), sig[:-1] + ("0" if sig[-1] != "0" else "1"))


async def test_an_expired_signature_is_refused():
    key = "reports/abc.csv"
    exp = int(time.time()) - 1
    assert not signature_is_valid(key, str(exp), sign_key(key, exp))


async def test_a_missing_or_malformed_signature_is_refused():
    key = "reports/abc.csv"
    exp = int(time.time()) + 60
    assert not signature_is_valid(key, None, None)
    assert not signature_is_valid(key, str(exp), None)
    assert not signature_is_valid(key, "not-a-number", sign_key(key, exp))
    assert not signature_is_valid(key, "", "")


# --- the URL a caller is handed ----------------------------------------------


async def test_a_report_url_is_signed_and_an_avatar_url_is_not():
    storage = LocalStorage()
    report_url = await storage.url("reports/abc.csv")
    avatar_url = await storage.url("avatars/xyz.png")
    assert "sig=" in report_url and "exp=" in report_url
    # Signing avatars would break every <img> the console renders with no token.
    assert "sig=" not in avatar_url


# --- what /files actually serves ---------------------------------------------


async def test_serving_a_report_without_a_signature_is_404(app):
    storage = LocalStorage()
    await storage.put("reports/secret.csv", b"tenant,data\n1,2\n", "text/csv")
    async with api_client(app) as c:
        bare = await c.get("/files/reports/secret.csv")
        signed_url = await storage.url("reports/secret.csv")
        good = await c.get(signed_url)
    # 404 and not 403: a 403 confirms this report exists, which is most of what
    # someone holding a stale link wants to learn.
    assert bare.status_code == 404, bare.text
    assert good.status_code == 200, good.text
    assert b"tenant,data" in good.content


async def test_serving_a_report_with_an_expired_signature_is_404(app):
    storage = LocalStorage()
    await storage.put("reports/old.csv", b"x", "text/csv")
    expired = int(time.time()) - 5
    url = f"/files/reports/old.csv?exp={expired}&sig={sign_key('reports/old.csv', expired)}"
    async with api_client(app) as c:
        r = await c.get(url)
    assert r.status_code == 404, r.text


async def test_serving_a_report_with_another_files_signature_is_404(app):
    """The key is inside the signed payload, so a link legitimately obtained for
    one report cannot be re-pointed at another."""
    storage = LocalStorage()
    await storage.put("reports/mine.csv", b"mine", "text/csv")
    await storage.put("reports/theirs.csv", b"theirs", "text/csv")
    exp = int(time.time()) + 60
    stolen = f"/files/reports/theirs.csv?exp={exp}&sig={sign_key('reports/mine.csv', exp)}"
    async with api_client(app) as c:
        r = await c.get(stolen)
    assert r.status_code == 404, r.text


async def test_an_avatar_is_still_served_with_no_signature(app):
    """The guard must not become "everything needs a token": that breaks the
    console's images while every assertion above still passes."""
    storage = LocalStorage()
    await storage.put("avatars/u.png", b"\x89PNG\r\n\x1a\n" + b"\x00" * 16, "image/png")
    async with api_client(app) as c:
        r = await c.get("/files/avatars/u.png")
    assert r.status_code == 200, r.text


# --- the other backend -------------------------------------------------------
#
# S3 links are not signed by `sign_key`; S3 presigns them and they expire on their
# own. So the property is not "there is a sig=", it is that an expiry is passed at
# all and that for a report it is `signed_url_ttl_seconds`, not the interface's
# generic hour. `aioboto3` is an optional extra, so the client is substituted
# rather than built.


class _RecordingS3:
    """Stands in for the aioboto3 client, recording the presign call."""

    def __init__(self) -> None:
        self.calls: list[dict] = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def generate_presigned_url(self, operation, Params, ExpiresIn):  # noqa: N803
        self.calls.append({"operation": operation, "params": Params, "expires_in": ExpiresIn})
        return f"https://s3.test/{Params['Key']}?X-Amz-Expires={ExpiresIn}"


@pytest.fixture
def s3(monkeypatch):
    """An S3Storage whose client is a recorder. Returns (storage, recorder)."""
    from app.core import config
    from app.core.storage import S3Storage

    monkeypatch.setenv("VE_S3_BUCKET", "neubit-test")
    config.get_settings.cache_clear()
    storage = S3Storage()
    recorder = _RecordingS3()
    monkeypatch.setattr(storage, "_client", lambda: recorder)
    return storage, recorder


async def test_an_s3_url_is_a_presigned_get_with_an_expiry(s3):
    storage, recorder = s3
    url = await storage.url("reports/abc.csv", expires=120)
    call = recorder.calls[0]
    assert call["operation"] == "get_object"
    assert call["params"] == {"Bucket": "neubit-test", "Key": "reports/abc.csv"}
    assert call["expires_in"] == 120
    assert url.startswith("https://s3.test/")


async def test_an_s3_report_link_expires_after_the_configured_ttl_not_a_generic_hour(
    s3, db, monkeypatch
):
    """The router, not S3Storage, chooses the window — so drive the route.

    A presign that took the interface's default would hand out an hour-long link to
    a tenant's export.
    """
    import uuid

    from importlib import import_module

    from app.auth.security import hash_password
    from app.core.config import get_settings
    from app.reports.models import ReportJob
    from app.tenancy.models import Tenant
    from conftest import make_role

    # import_module, not `from app.reports import router`: that name is the
    # APIRouter the package re-exports, not the module the route lives in.
    reports_router = import_module("app.reports.router")
    storage, recorder = s3
    ttl = get_settings().signed_url_ttl_seconds
    assert ttl != 3600, "this test cannot tell the two apart if the TTL is an hour"

    tenant = Tenant(id=uuid.uuid4(), name="Acme", slug="acme")
    db.add(tenant)
    await db.flush()
    role = await make_role(db, "Reporter", ["report.export"])
    user = User(
        email="r@acme.io", full_name="R", role_id=role.id, tenant_id=tenant.id,
        password_hash=hash_password("Passw0rd!"),
    )
    db.add(user)
    job = ReportJob(
        tenant_id=tenant.id, name="q3", format="csv", status="done",
        result_key="reports/q3.csv",
    )
    db.add(job)
    await db.commit()
    await db.refresh(user, attribute_names=["role"])

    monkeypatch.setattr(reports_router, "get_storage", lambda: storage)
    out = await reports_router.download_report(job.id, db=db, user=user)

    assert recorder.calls[0]["expires_in"] == ttl
    assert out["expires_in"] == ttl
