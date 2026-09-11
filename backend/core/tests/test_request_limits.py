"""An oversized request body is refused before anything reads it.

`uploads.read_capped` bounds what a handler holds, but Starlette's multipart parser
has already spooled parts over 1 MiB to a temp file by then — the heap was capped,
the disk was not.
"""


import httpx
import pytest

from app.core.request_limits import DEFAULT_MAX_BYTES, RequestSizeLimitMiddleware
from conftest import api_client

pytestmark = pytest.mark.asyncio


async def test_a_declared_oversized_body_is_413(app):
    async with api_client(app) as c:
        r = await c.post("/api/v1/auth/login", content=b"x" * (DEFAULT_MAX_BYTES + 1))
    assert r.status_code == 413, r.text
    assert r.json()["error"]["code"] == "REQUEST_TOO_LARGE"


async def test_the_body_is_never_handed_to_the_app(app):
    """The point of doing this in middleware. If the request reached routing, the
    parser would already have spooled it."""
    seen = []
    inner = app.router

    class _Spy:
        def __init__(self, wrapped):
            self.wrapped = wrapped

        async def __call__(self, scope, receive, send):
            seen.append(scope.get("path"))
            return await self.wrapped(scope, receive, send)

    guarded = RequestSizeLimitMiddleware(_Spy(inner))
    transport = httpx.ASGITransport(app=guarded)
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
        r = await c.post("/api/v1/auth/login", content=b"x" * (DEFAULT_MAX_BYTES + 1))
    assert r.status_code == 413
    assert seen == [], "the app was called with an oversized body"


async def test_an_ordinary_request_is_untouched(app):
    """Otherwise the guard is an outage, not a limit."""
    async with api_client(app) as c:
        r = await c.get("/health")
    assert r.status_code == 200


async def test_a_body_under_the_limit_reaches_the_app(app):
    async with api_client(app) as c:
        r = await c.post("/api/v1/auth/login", json={"email": "a@b.c", "password": "x"})
    # 401/422 — anything but 413 means the body got through.
    assert r.status_code != 413, r.text


async def test_the_database_restore_gets_its_own_larger_limit():
    """One number cannot serve both an avatar and a 512 MiB control-plane dump."""
    from app.infra.router import MAX_DUMP_BYTES

    mw = RequestSizeLimitMiddleware(None)
    assert mw.limit_for("/api/v1/admin/infra/db/import") == MAX_DUMP_BYTES
    assert mw.limit_for("/api/v1/auth/me/avatar") == DEFAULT_MAX_BYTES


async def test_the_default_is_above_every_handler_cap_that_is_not_the_restore():
    """A middleware limit below a handler's own cap would make that cap
    unreachable, and the handler's error message unreachable with it."""
    from app.auth.routes.users import MAX_IMPORT_BYTES
    from app.core.uploads import MAX_IMAGE_BYTES

    assert DEFAULT_MAX_BYTES > MAX_IMPORT_BYTES
    assert DEFAULT_MAX_BYTES > MAX_IMAGE_BYTES


async def test_the_longest_matching_prefix_wins():
    mw = RequestSizeLimitMiddleware(None, default_max_bytes=100,
                                    path_limits={"/a": 200, "/a/b": 300})
    assert mw.limit_for("/a/x") == 200
    assert mw.limit_for("/a/b/x") == 300
    assert mw.limit_for("/z") == 100


async def test_a_streamed_body_with_no_content_length_is_still_capped(app):
    """A client that omits Content-Length must not get an unbounded body. This is
    the path the declared-length check cannot see."""
    async def _chunks():
        for _ in range((DEFAULT_MAX_BYTES // (64 * 1024)) + 2):
            yield b"x" * (64 * 1024)

    async with api_client(app) as c:
        r = await c.post("/api/v1/auth/login", content=_chunks())
    assert r.status_code == 413, r.text
