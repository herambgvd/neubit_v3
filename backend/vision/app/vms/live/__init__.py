"""Live-streaming control plane (P2-B) — PlaybackSession issuer + media token.

vision issues a session, calls the Go ``nvr`` to bring the MediaMTX path up, mints
a short-lived signed media token, persists a ``PlaybackSession`` and returns the
browser-facing URLs (with ``?token=`` appended). A stateless verify endpoint
(``/media/verify``) backs the Traefik ForwardAuth that gates MediaMTX (P2-C).

Self-contained domain package (``schemas`` + ``service`` + ``router``) following the
cameras/nvr/groups/health pattern; the router mounts under the ``/vms`` prefix.
"""

from __future__ import annotations

from .router import router  # noqa: F401

__all__ = ["router"]
