"""Counters for the things that have no row to look at.

Rejections on the public receiver used to be recorded as database rows, which is
how an unauthenticated endpoint became an unbounded write. A counter costs nothing
an attacker can grow, and answers the operator's question — "is someone hammering
a slug that does not exist?" — just as well.

Stdlib only. Prometheus is not a dependency of this service and one counter is not
a reason to make it one; the exposition format is simple enough to emit by hand.
"""

from __future__ import annotations

import threading


class Counter:
    """A monotonic counter, safe to increment from any thread."""

    def __init__(self, name: str, help_text: str) -> None:
        self.name = name
        self.help_text = help_text
        self._value = 0
        self._lock = threading.Lock()

    def inc(self, by: int = 1) -> None:
        with self._lock:
            self._value += by

    @property
    def value(self) -> int:
        return self._value


#: Every counter that /metrics should expose.
REGISTRY: list[Counter] = []


def counter(name: str, help_text: str) -> Counter:
    c = Counter(name, help_text)
    REGISTRY.append(c)
    return c


unknown_slug_attempts = counter(
    "ingest_unknown_slug_attempts_total",
    "Requests to a webhook slug that does not exist. Anonymous and unbounded, so "
    "counted rather than stored.",
)
auth_failures = counter(
    "ingest_auth_failures_total",
    "Requests to a real webhook that failed its configured authentication.",
)
replays_rejected = counter(
    "ingest_replays_rejected_total",
    "HMAC requests refused because the timestamp was outside the window or the "
    "signature had already been seen.",
)
bodies_too_large = counter(
    "ingest_bodies_too_large_total",
    "Requests refused before being read because the body exceeded the cap.",
)
publish_failures = counter(
    "ingest_publish_failures_total",
    "Events accepted and logged, but not delivered to the event bus.",
)


def render() -> str:
    """The Prometheus text exposition format, by hand."""
    lines: list[str] = []
    for c in REGISTRY:
        lines.append(f"# HELP {c.name} {c.help_text}")
        lines.append(f"# TYPE {c.name} counter")
        lines.append(f"{c.name} {c.value}")
    return "\n".join(lines) + "\n"
