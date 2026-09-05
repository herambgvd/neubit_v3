"""A report export must not be a permanent capability URL.

`GET /reports/{id}/download` checks `report.export` and then returns a link to
`/files/reports/<uuid>.<fmt>` — a route with no auth dependency at all, routed
publicly by the gateway. So the permission gated only the FIRST fetch. Anyone who
later obtained the link — a chat message, a browser history, a proxy log, a shared
screenshot — held the tenant's data with no credential, forever, with no way to
revoke it short of deleting the file.

The fix is a prefix rule, not a blanket one: keys under `signed_url_prefixes` carry
`?exp=&sig=` and are refused without a valid unexpired signature, while avatars and
logos stay plain because a browser has to load them from an `<img>` with no token.
So these tests assert BOTH — the report is protected and the avatar still is not.
"""

from __future__ import annotations

import time

import httpx
import pytest

from app.app import create_base_app
from app.core import storage as storage_mod
from app.core.storage import LocalStorage, sign_key, signature_is_valid
from app.db.base import get_db

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


@pytest.fixture
def app(sessionmaker_):
    application = create_base_app(title="test")

    async def _override_db():
        async with sessionmaker_() as session:
            yield session

    application.dependency_overrides[get_db] = _override_db
    return application


def _client(app) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t")


# --- the signature itself ----------------------------------------------------


def test_a_valid_signature_verifies_and_a_tampered_one_does_not():
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


def test_an_expired_signature_is_refused():
    key = "reports/abc.csv"
    exp = int(time.time()) - 1
    assert not signature_is_valid(key, str(exp), sign_key(key, exp))


def test_a_missing_or_malformed_signature_is_refused():
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
    async with _client(app) as c:
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
    async with _client(app) as c:
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
    async with _client(app) as c:
        r = await c.get(stolen)
    assert r.status_code == 404, r.text


async def test_an_avatar_is_still_served_with_no_signature(app):
    """The guard must not become "everything needs a token" — that would break the
    console's images, and every assertion above would still pass."""
    storage = LocalStorage()
    await storage.put("avatars/u.png", b"\x89PNG\r\n\x1a\n" + b"\x00" * 16, "image/png")
    async with _client(app) as c:
        r = await c.get("/files/avatars/u.png")
    assert r.status_code == 200, r.text
