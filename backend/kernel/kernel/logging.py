"""One log line shape for every service that carries the kernel.

``basicConfig`` emits ``INFO:workflow.correlation:...`` — no timestamp, no
service, no process role — which is unreadable in an interleaved compose stream,
especially for workflow, whose api, worker and beat are three containers from one
image. :func:`configure` replaces that with a line that names its container.

Adopt it with one call before anything else logs::

    from kernel.logging import configure; configure("access", "api")

Deliberately absent from ``kernel/__init__.py``'s re-exports, like
``kernel.secrets``: nothing here runs until a service calls ``configure``.
access, vision, ingest and reading-writer are still on ``basicConfig`` — adopting
changes their line shape, and this repo's ops-agent pattern-matches container
logs, so each wants its own commit and its own look at the parser.

Text is the default in every environment, unlike core's copy, which flips to JSON
off ``env``. This estate ships on-prem with no shipper, so ``docker compose logs``
and a human are the only readers, and the format you debug against should be the
one that is running. Set ``VE_LOG_FORMAT=json`` once a shipper exists; the JSON
shape is core's plus ``service`` and ``role``, so a rule for core's lines parses
these too.

No access-log middleware here: which requests deserve a line is per-service (core
has its own ``RequestLoggingMiddleware``), and keeping this to handlers lets a
Celery worker or NATS consumer use it as readily as an ASGI app. core can't
import this at all — its image doesn't carry the kernel — so the formats are kept
compatible rather than shared.
"""

from __future__ import annotations

import json
import logging
import os
import sys
from contextvars import ContextVar

#: The current request/message correlation id, "-" outside one (startup, sweeps,
#: consumers). Always emitted, because core's JSON lines carry ``request_id`` and
#: one shipper rule has to find the key in both.
request_id_ctx: ContextVar[str] = ContextVar("request_id", default="-")


class _ContextFilter(logging.Filter):
    """Stamps service/role/request_id onto every record, including ones from
    libraries that know nothing about them (uvicorn, celery, asyncpg).

    On the handler rather than in a Formatter, since both formatters need these
    fields and neither should own them.
    """

    def __init__(self, service: str, role: str) -> None:
        super().__init__()
        self.service = service
        self.role = role

    def filter(self, record: logging.LogRecord) -> bool:
        record.service = self.service
        record.role = self.role
        record.request_id = request_id_ctx.get()
        return True


class JsonFormatter(logging.Formatter):
    """One JSON object per line. Keys are core's, plus ``service`` and ``role``."""

    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "ts": self.formatTime(record, "%Y-%m-%dT%H:%M:%S%z"),
            "level": record.levelname,
            "logger": record.name,
            "service": getattr(record, "service", "-"),
            "role": getattr(record, "role", "-"),
            "request_id": getattr(record, "request_id", "-"),
            "msg": record.getMessage(),
        }
        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)
        return json.dumps(payload)


def _text_formatter(service: str, role: str) -> logging.Formatter:
    """``2026-09-05T15:46:04 INFO    [workflow/worker] workflow.jobs: message``

    service/role go into the format string rather than being read off the record,
    so a line from a logger the filter missed still names its container.
    """
    tag = f"{service}/{role}" if role else service
    return logging.Formatter(
        f"%(asctime)s %(levelname)-7s [{tag}] %(name)s: %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%S",
    )


def configure(
    service: str,
    role: str = "",
    *,
    level: str | None = None,
    fmt: str | None = None,
    stream=None,
) -> None:
    """Install a single root handler for this process. Call once, at startup.

    ``level`` defaults to ``VE_LOG_LEVEL`` then INFO; ``fmt`` to ``VE_LOG_FORMAT``
    (``text`` | ``json``) then text. An unrecognised level falls back to INFO
    rather than raising — an env-var typo must not stop a service booting.

    Handlers are replaced, not appended: uvicorn and celery install their own on
    import, and stacking prints every line twice.
    """
    level_name = (level or os.getenv("VE_LOG_LEVEL") or "INFO").upper()
    fmt_name = (fmt or os.getenv("VE_LOG_FORMAT") or "text").lower()

    handler = logging.StreamHandler(stream if stream is not None else sys.stderr)
    handler.addFilter(_ContextFilter(service, role))
    handler.setFormatter(
        JsonFormatter() if fmt_name == "json" else _text_formatter(service, role)
    )

    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(getattr(logging, level_name, logging.INFO))


def bind_request_id(request_id: str):
    """Set the correlation id for the current context; returns the ContextVar token.

    Not a context manager on purpose: callers set it once per task and let the
    context die with the task.
    """
    return request_id_ctx.set(request_id)
