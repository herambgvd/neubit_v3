"""Log configuration for this service's two entry points.

``logging.basicConfig(level=logging.INFO)`` gives ``INFO:workflow.correlation:...``
— no timestamp, no process role, and three containers built from ONE image all
writing that same shape into one ``docker compose logs`` stream. Working out
whether a line came from the API, the worker or beat meant guessing from the
logger name, which is why every incident here starts with `docker compose logs
workflow-worker` filtered by hand.

So: a timestamp, the level, the ROLE, and the logger, from a level that is
configurable without a rebuild (``VE_LOG_LEVEL``). ``VE_LOG_FORMAT=json`` emits
one JSON object per line for a log shipper; text stays the default because a human
reads these far more often than Loki does on this deployment.

WHERE THIS HONESTLY BELONGS, and why it is not there. ``backend/core`` already has
this (``app/core/logging.py``: a ``_JsonFormatter``, a request-id contextvar and an
access-log middleware), and access/, vision/ and ingest/ each carry the same bare
``basicConfig(level=INFO)`` this replaces. The right fix is one
``kernel.logging`` that all six import — kernel is the shared package and this is
exactly the kind of thing it exists for. That change alters the log SHAPE of six
services at once, which is a change that wants its own commit, its own rollout and
its own eyes on the ops-agent's log parsing; folding it into an observability
commit for one service would make both unreviewable. This module is deliberately
small and deliberately local so that lifting it into kernel later is a move, not a
rewrite.
"""

from __future__ import annotations

import json
import logging
import os

from kernel.config import get_settings


class _JsonFormatter(logging.Formatter):
    """One JSON object per line. Shape matches backend/core's, so a shipper that
    already parses core's lines parses these without a second rule."""

    def __init__(self, role: str) -> None:
        super().__init__()
        self.role = role

    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "ts": self.formatTime(record, "%Y-%m-%dT%H:%M:%S%z"),
            "level": record.levelname,
            "logger": record.name,
            "service": "workflow",
            "role": self.role,
            "msg": record.getMessage(),
        }
        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)
        return json.dumps(payload)


def configure(role: str) -> None:
    """Install a single root handler. ``role`` is api | worker | beat.

    Replaces the root handlers rather than adding to them: uvicorn and celery both
    install their own on import, and stacking would print every line twice — which
    is its own small observability failure, since a duplicated error looks like two
    errors.
    """
    level = os.getenv("VE_LOG_LEVEL", "INFO").upper()
    fmt = os.getenv("VE_LOG_FORMAT", "").lower() or (
        "json" if get_settings().env not in ("dev", "local", "test") else "text"
    )
    handler = logging.StreamHandler()
    if fmt == "json":
        handler.setFormatter(_JsonFormatter(role))
    else:
        handler.setFormatter(logging.Formatter(
            f"%(asctime)s %(levelname)-7s [workflow/{role}] %(name)s: %(message)s",
            datefmt="%Y-%m-%dT%H:%M:%S",
        ))
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(getattr(logging, level, logging.INFO))
