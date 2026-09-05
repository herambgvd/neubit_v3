"""One log line shape for every service that carries the kernel.

WHAT WAS WRONG. ``logging.basicConfig(level=logging.INFO)`` — which access, vision
and ingest each spell out for themselves, and which reading-writer half-fixed with
a fourth private format string — emits
``INFO:workflow.correlation:...``: no timestamp, no service, no process role. In a
compose stack that is one interleaved stream in which the only way to tell who
wrote a line is to recognise the logger name, and it is worse than that for
workflow, whose api, worker and beat are THREE containers built from ONE image all
writing the same shape. Every incident here starts with someone re-running
``docker compose logs`` filtered by hand.

WHAT THIS COSTS, SINCE kernel IS IMPORTED BY NINE SERVICES. Nothing. This is a NEW
module that no existing module imports — it is deliberately absent from
``kernel/__init__.py``'s re-exports for that reason, exactly as ``kernel.secrets``
is (see 43ff0f5, which reasoned about the same blast radius). Nothing here runs
until a service calls :func:`configure`, and it adds no dependency: stdlib only.

WHY TEXT IS THE DEFAULT IN EVERY ENVIRONMENT, INCLUDING PRODUCTION

``core``'s copy (``core/app/core/logging.py``) switches to JSON whenever ``env !=
"dev"``, and workflow's local predecessor copied that rule. It is dropped here on
purpose. This estate ships on-prem with no log shipper: ``docker compose logs`` is
the only reader there is, and in production it is a human under time pressure. An
env-conditional default means the format you debug against is never the format
that is running when you actually need to read it, which is the one case that
matters. So JSON is opt-in — set ``VE_LOG_FORMAT=json`` when a shipper exists to
consume it — and until then the common case stays readable.

The JSON shape is core's shape plus ``service`` and ``role``. A shipper that
already has a rule for core's lines parses these with the same rule; the two extra
keys are additive.

WHAT ADOPTING THIS COSTS THE SERVICES THAT HAVE NOT (deliberately: access, vision,
ingest, reading-writer are LEFT on ``basicConfig`` by the commit that added this,
so one commit changes one service's log shape rather than five)

  * One import and one call, before anything else logs:
    ``from kernel.logging import configure; configure("access", "api")``, replacing
    the ``basicConfig`` line. Both are cheap; the cost is not in the code.
  * Their log LINES change shape. Anything downstream that pattern-matches on
    ``INFO:logger:message`` — this repo's ops-agent reads container logs — sees a
    different prefix from that deploy on. That is the whole reason this is not
    done for them here: it wants its own commit and its own look at the parser.
  * ``VE_LOG_LEVEL`` starts working for the three that pin INFO (access, vision,
    ingest), which is the payoff: turning DEBUG up on one container stops needing
    a rebuild. reading-writer already reads that var and would gain only the shape.
  * Nothing else. There is no new dependency, no new env var that must be set, and
    a service that adopts this and sets nothing gets INFO-level text.

WHAT IS DELIBERATELY NOT HERE

  * No access-log middleware. Which HTTP requests are worth a line, and whether the
    line is emitted at all, is a per-service decision; core has its own
    ``RequestLoggingMiddleware`` and it stays core's. This module configures
    handlers and nothing else, so it can be adopted by a Celery worker and a NATS
    consumer as readily as by an ASGI app.
  * ``core`` is not changed to import this. core's image does not carry the kernel
    (core/pyproject.toml), so it cannot — the same constraint kernel.secrets ran
    into. The formats are kept compatible instead of shared.
"""

from __future__ import annotations

import json
import logging
import os
import sys
from contextvars import ContextVar

#: The current request/message correlation id, "-" outside one (startup, sweeps,
#: consumers). Present because core's JSON lines carry ``request_id`` and a
#: shipper rule that works for both must find the key in both. A service that
#: never sets it pays one dict lookup per line.
request_id_ctx: ContextVar[str] = ContextVar("request_id", default="-")


class _ContextFilter(logging.Filter):
    """Stamps service/role/request_id onto every record, including records from
    libraries that know nothing about any of the three (uvicorn, celery, asyncpg).

    A filter on the HANDLER rather than fields baked into a Formatter, because the
    text formatter and the JSON formatter both need them and neither should own
    them.
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

    service/role are interpolated into the format string rather than read off the
    record, so a line written by a logger the filter somehow missed still says
    which container produced it — the one fact ``docker compose logs`` cannot
    supply on its own once two containers share an image.
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
    rather than raising: a typo in an env var must not stop a service booting, and
    the wrong verbosity is a smaller failure than no service.

    Handlers are REPLACED, not appended. uvicorn and celery each install their own
    on import, and stacking prints every line twice — which is its own small
    observability failure, because a duplicated error reads as two errors.
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

    Deliberately not a context manager: the ASGI/consumer callers that want this
    set it once per task and let the context die with the task, and a ``with``
    block would imply a nesting discipline none of them have.
    """
    return request_id_ctx.set(request_id)
