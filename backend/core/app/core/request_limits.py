"""Reject an oversized request body before anything reads it.

`core/uploads.read_capped` bounds what a HANDLER holds in memory, but by the time
a handler runs, Starlette's multipart parser has already consumed the request and
spooled every part over 1 MiB to a temp file. So the heap was protected and the
DISK was not: a large enough POST still cost disk before anything measured it.

This is a pure ASGI middleware, not a BaseHTTPMiddleware, because that class
buffers the body itself — using it here would recreate the problem it is meant to
solve.

Two paths:
  * Content-Length present and over the limit — refuse without calling the app.
    Covers every ordinary client.
  * Chunked, no Content-Length — count bytes as they arrive and abort past the
    limit.

Limits are per path prefix because one number cannot serve both an avatar and a
512 MiB database restore.
"""

from __future__ import annotations

import logging

from starlette.responses import JSONResponse

log = logging.getLogger("edge.request_limits")

#: Comfortably above the largest handler cap that is not a database restore
#: (16 MiB user-import CSV), and far below anything that threatens the disk.
DEFAULT_MAX_BYTES = 32 * 1024 * 1024

#: Paths that legitimately carry more. Longest prefix wins.
PATH_LIMITS: dict[str, int] = {
    # Matches infra.MAX_DUMP_BYTES; a control-plane dump is genuinely this big.
    "/api/v1/admin/infra/db/import": 512 * 1024 * 1024,
}


class RequestSizeLimitMiddleware:
    def __init__(self, app, *, default_max_bytes: int = DEFAULT_MAX_BYTES,
                 path_limits: dict[str, int] | None = None) -> None:
        self.app = app
        self.default_max_bytes = default_max_bytes
        self.path_limits = dict(PATH_LIMITS if path_limits is None else path_limits)

    def limit_for(self, path: str) -> int:
        best = self.default_max_bytes
        best_len = -1
        for prefix, limit in self.path_limits.items():
            if path.startswith(prefix) and len(prefix) > best_len:
                best, best_len = limit, len(prefix)
        return best

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] != "http":
            return await self.app(scope, receive, send)

        limit = self.limit_for(scope.get("path", ""))
        headers = {k.decode("latin-1").lower(): v.decode("latin-1")
                   for k, v in scope.get("headers", [])}
        declared = headers.get("content-length")
        if declared and declared.isdigit() and int(declared) > limit:
            return await self._refuse(scope, send, limit, int(declared))

        received = 0
        answered = False

        async def _send(message):
            # Once we have answered, the app's own response is discarded — it is
            # unwinding from a truncated body and whatever it produces is noise.
            if answered:
                return
            await send(message)

        async def _receive():
            nonlocal received, answered
            message = await receive()
            if message["type"] != "http.request":
                return message
            received += len(message.get("body", b""))
            if received <= limit:
                return message
            # Answer from here rather than raising. A raise unwinds through the
            # inner middleware stack, which answers first with its own 400 — so the
            # client would see a parse error instead of a size limit.
            if not answered:
                await self._refuse(scope, send, limit, None)
                answered = True
            return {"type": "http.disconnect"}

        await self.app(scope, _receive, _send)

    async def _refuse(self, scope, send, limit: int, declared: int | None) -> None:
        log.warning(
            "request body over the %d byte limit on %s (declared=%s)",
            limit, scope.get("path", ""), declared,
        )
        response = JSONResponse(
            status_code=413,
            content={"error": {
                "code": "REQUEST_TOO_LARGE",
                "message": f"request body exceeds the {limit // (1024 * 1024)} MiB limit",
            }},
        )

        async def _empty_receive():
            return {"type": "http.request", "body": b"", "more_body": False}

        await response(scope, _empty_receive, send)
