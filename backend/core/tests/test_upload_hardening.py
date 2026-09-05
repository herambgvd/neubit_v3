"""Uploads and the public file route — the stored-XSS path a pentest walks first.

`GET /files/{key:path}` has no auth dependency at all and is routed publicly by
Traefik (deploy/docker-compose.yml). Two upload routes fed it without checking
anything: `POST /auth/me/avatar` (ANY authenticated user) and `POST /branding/logo`
both took the stored extension straight from `os.path.splitext(file.filename)` and
passed the client's own `content_type` through to storage. Upload `x.html`, read the
URL out of the response, send the link — script running on the platform origin, with
the visitor's session.

These tests are written as the attack, not as the implementation: each one is a
thing an assessor would try.
"""

from __future__ import annotations

import httpx
import pytest
import pytest_asyncio

from app.app import create_base_app
from app.auth.security import create_access_token
from app.db.base import get_db
from conftest import make_role, make_user

pytestmark = pytest.mark.asyncio
PREFIX = "/api/v1"

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
JPEG = b"\xff\xd8\xff" + b"\x00" * 64
SVG = b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
HTML = b"<html><script>alert(document.cookie)</script></html>"


@pytest.fixture(autouse=True)
def writable_storage(tmp_path, monkeypatch):
    """The harness mounts the source tree read-only (run-tests.sh), so the default
    ./data/storage cannot be created. Point LocalStorage at pytest's tmp_path and
    clear the lru_cache that would otherwise hand back a backend built from the
    old setting."""
    from app.core import config, storage

    monkeypatch.setenv("VE_STORAGE_LOCAL_DIR", str(tmp_path / "storage"))
    config.get_settings.cache_clear()
    storage.get_storage.cache_clear()
    yield
    config.get_settings.cache_clear()
    storage.get_storage.cache_clear()


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


def _auth(user) -> dict:
    return {"Authorization": f"Bearer {create_access_token(user, sid='test')}"}


@pytest_asyncio.fixture
async def user(db):
    role = await make_role(db, "Uploader", ["branding.manage"])
    return await make_user(db, "uploader@x.io", role)


async def _post_avatar(c, user, filename, content, content_type):
    return await c.post(
        f"{PREFIX}/auth/me/avatar",
        headers=_auth(user),
        files={"file": (filename, content, content_type)},
    )


# --- the attack itself -------------------------------------------------------


async def test_html_disguised_as_an_image_is_refused(app, user):
    """Declared image/png, bytes are HTML. The declared type is a claim by the
    uploader; the magic number is the file."""
    async with _client(app) as c:
        r = await _post_avatar(c, user, "payload.png", HTML, "image/png")
    assert r.status_code == 415, r.text


async def test_an_html_content_type_is_refused_outright(app, user):
    async with _client(app) as c:
        r = await _post_avatar(c, user, "payload.html", HTML, "text/html")
    assert r.status_code == 415, r.text


async def test_the_stored_key_never_takes_its_extension_from_the_filename(app, user):
    """The filename is attacker-controlled and used to end up in the served URL.
    A real PNG announced as `evil.html` must still be stored as `.png`."""
    async with _client(app) as c:
        r = await _post_avatar(c, user, "evil.html", PNG, "image/png")
    assert r.status_code == 200, r.text
    key = r.json()["avatar_url"]
    assert key.endswith(".png"), key
    assert ".html" not in key


async def test_a_valid_image_still_uploads(app, user):
    """The guard must not be "refuse everything" — that would pass every test above."""
    async with _client(app) as c:
        r = await _post_avatar(c, user, "me.jpg", JPEG, "image/jpeg")
    assert r.status_code == 200, r.text
    assert r.json()["avatar_url"].endswith(".jpg")


async def test_an_oversized_upload_is_refused(app, user):
    async with _client(app) as c:
        r = await _post_avatar(c, user, "big.png", PNG + b"\x00" * (9 * 1024 * 1024), "image/png")
    assert r.status_code == 413, r.text


async def test_empty_upload_is_refused(app, user):
    async with _client(app) as c:
        r = await _post_avatar(c, user, "nothing.png", b"", "image/png")
    assert r.status_code in (400, 415), r.text


# --- the serving side --------------------------------------------------------
#
# Validating uploads is only half. /files also serves report exports and whatever
# earlier versions of these routes already let onto disk, and it used
# mimetypes.guess_type on the key — which answers text/html for a .html key.


def test_serving_never_infers_a_dangerous_content_type():
    from app.core.storage import _serving_headers

    ctype, headers = _serving_headers("avatars/legacy.html")
    assert ctype == "application/octet-stream"
    assert headers["Content-Disposition"].startswith("attachment")

    ctype, headers = _serving_headers("x/y.xhtml")
    assert ctype == "application/octet-stream"
    assert "attachment" in headers["Content-Disposition"]


def test_svg_is_served_as_a_download_not_a_document():
    """SVG is XML that can carry script, and logos are SVG, so it is accepted and
    served with a disposition instead of being banned. `<img src>` still renders
    it; a direct navigation downloads it; script never runs either way."""
    from app.core.storage import _serving_headers

    ctype, headers = _serving_headers("branding/logo_abc.svg")
    assert ctype == "image/svg+xml"
    assert headers["Content-Disposition"].startswith("attachment")


def test_raster_images_are_still_rendered_inline():
    from app.core.storage import _serving_headers

    for key in ("a.png", "b.JPG", "c.webp", "d.gif"):
        ctype, headers = _serving_headers(key)
        assert ctype.startswith("image/"), key
        assert headers == {}, key


def test_a_quote_in_a_key_cannot_break_out_of_the_disposition_header():
    """Header injection through the filename — the other thing an assessor tries."""
    from app.core.storage import _serving_headers

    _, headers = _serving_headers('exports/we"ird.pdf')
    value = headers["Content-Disposition"]
    assert value.count('"') == 2
    assert "\n" not in value and "\r" not in value


async def test_files_responses_are_sandboxed_by_csp(app, user):
    """Defence in depth: whatever does reach a browser from /files runs with no
    script and an opaque origin."""
    async with _client(app) as c:
        r = await c.get("/files/does-not-exist.png")
    assert "sandbox" in r.headers["content-security-policy"]
    assert r.headers["x-content-type-options"] == "nosniff"
