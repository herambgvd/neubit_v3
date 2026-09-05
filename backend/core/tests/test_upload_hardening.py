"""Uploads and the public file route — the stored-XSS path a pentest walks first.

`GET /files/{key:path}` has no auth dependency at all and is routed publicly by
Traefik (deploy/docker-compose.yml). Two upload routes fed it without checking
anything: `POST /auth/me/avatar` (ANY authenticated user) and `POST /branding/logo`
both took the stored extension straight from `os.path.splitext(file.filename)` and
passed the client's own `content_type` through to storage. Upload `x.html`, read the
URL out of the response, send the link — script running on the platform origin, with
the visitor's session.

The size cap had the same shape of hole: it was measured after `await file.read()`
had already turned the whole request body into one bytes object, so it named a limit
without imposing one. Upload as much as you like; core allocates all of it and then
tells you it was too big.

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


# --- the cap has to STOP the read, not report on it --------------------------
#
# The 413 above passed against the broken implementation too, which is the point:
# every route did `data = await file.read()` and let validate_image measure the
# result, so the whole body was already one bytes object before the cap was ever
# consulted. Any authenticated user could pick core's next allocation size. A
# status-code assertion cannot tell the two implementations apart — these can,
# because they count what the helper actually asked the file for.


class _CountingFile:
    """Stands in for Starlette's UploadFile and records what was pulled off it.

    `read(-1)` returns everything, exactly as the real one does, so a helper that
    does not pass a size gets the whole body and this fixture notices.
    """

    def __init__(self, size: int) -> None:
        self._remaining = size
        self.bytes_read = 0
        self.read_sizes: list[int] = []

    async def read(self, size: int = -1) -> bytes:
        self.read_sizes.append(size)
        take = self._remaining if size is None or size < 0 else min(size, self._remaining)
        self._remaining -= take
        self.bytes_read += take
        return b"\x00" * take


async def test_read_capped_abandons_an_oversized_upload_instead_of_buffering_it():
    from app.core.errors import ValidationError
    from app.core.uploads import MAX_IMAGE_BYTES, READ_CHUNK_BYTES, read_capped

    oversized = _CountingFile(64 * 1024 * 1024)  # 8x the cap
    with pytest.raises(ValidationError) as exc:
        await read_capped(oversized, field="Profile photo")

    assert exc.value.status_code == 413
    # The property under test: it stopped. One chunk of overshoot is the allowance —
    # the cap can only trip on a chunk that has already been read.
    assert oversized.bytes_read <= MAX_IMAGE_BYTES + READ_CHUNK_BYTES
    assert oversized.bytes_read < 64 * 1024 * 1024


async def test_read_capped_never_asks_for_the_whole_file_at_once():
    """`read(-1)` is the bug in one character. Every read must be bounded, or the
    cap is decided after the allocation it was supposed to prevent."""
    from app.core.errors import ValidationError
    from app.core.uploads import READ_CHUNK_BYTES, read_capped

    oversized = _CountingFile(64 * 1024 * 1024)
    with pytest.raises(ValidationError):
        await read_capped(oversized)

    assert oversized.read_sizes, "nothing was read at all"
    assert all(0 < n <= READ_CHUNK_BYTES for n in oversized.read_sizes), oversized.read_sizes[:5]


async def test_read_capped_returns_a_body_that_fits_byte_for_byte():
    """Chunking is only safe if it reassembles. A body spanning several chunks must
    come back identical, or the fix trades a DoS for silent corruption."""
    from app.core.uploads import READ_CHUNK_BYTES, read_capped

    body = bytes(range(256)) * ((READ_CHUNK_BYTES * 3) // 256 + 7)  # not a chunk multiple

    class _Body(_CountingFile):
        async def read(self, size: int = -1) -> bytes:
            start = self.bytes_read
            chunk = await super().read(size)
            return body[start : start + len(chunk)]

    src = _Body(len(body))
    assert await read_capped(src) == body
    assert src.bytes_read == len(body)


async def test_a_multi_chunk_image_still_round_trips_through_the_route(app, user):
    """End to end, on the route any authenticated user can reach: an image larger
    than one read chunk goes in and comes back out of /files unchanged."""
    from app.core.uploads import READ_CHUNK_BYTES

    png = PNG + bytes(range(256)) * (READ_CHUNK_BYTES * 3 // 256)
    async with _client(app) as c:
        r = await _post_avatar(c, user, "big-but-legal.png", png, "image/png")
        assert r.status_code == 200, r.text
        url = r.json()["avatar_url"]
        assert url.endswith(".png"), url
        served = await c.get(url)

    assert served.status_code == 200, served.text
    assert served.content == png


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


# --- every upload path, not just the three that were audited -----------------
#
# The avatar/logo/site-image routes were fixed first because that is where the
# stored-XSS work had already been done. `read_capped` then made it cheap to check
# the rest, and there were three more: floor plans (a cap, consulted after the
# read), the user-import CSV (no cap at all, and it decoded the whole body on top
# of holding it), and the SQL restore (unbounded, on the one endpoint you least
# want to fall over mid-operation).
#
# Asserted by reading the source rather than by posting a large body to each: the
# property is "no route calls the unbounded form", and a per-route DoS test would
# be slow, would only cover the routes someone remembered, and would pass on a
# route that simply moved its unbounded read somewhere else in the same handler.


def test_no_route_reads_an_upload_without_a_cap():
    import pathlib
    import re

    app_dir = pathlib.Path(__file__).resolve().parents[1] / "app"
    offenders = []
    for path in app_dir.rglob("*.py"):
        if path.name == "uploads.py":
            continue  # defines read_capped and quotes the old call in its docstring
        for lineno, line in enumerate(path.read_text().splitlines(), 1):
            # Comments are skipped because the fixes QUOTE the old call to explain
            # what was wrong with it, and a guard that flags its own explanation
            # teaches people to delete the explanation.
            if line.lstrip().startswith("#"):
                continue
            if re.search(r"await\s+file\.read\(\s*\)", line):
                offenders.append(f"{path.relative_to(app_dir)}:{lineno}")
    assert not offenders, (
        "these read an uploaded file with no size cap — use core.uploads.read_capped:\n"
        + "\n".join(f"  {o}" for o in offenders)
    )


def test_the_scan_can_actually_find_something():
    """Guards the guard: a regex that matches nothing would make the test above
    pass forever, which is the failure mode it exists to prevent elsewhere."""
    import re

    assert re.search(r"await\s+file\.read\(\s*\)", "    content = await file.read()")
    assert not re.search(r"await\s+file\.read\(\s*\)", "await read_capped(file, LIMIT)")
