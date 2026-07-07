"""Infrastructure control — super-admin view/control of the compose stack.

This module does NOT touch Docker directly. It is a thin, audited proxy in front
of the privileged `ops-agent` sidecar (the only service with the docker socket).
The router mirrors the agent's endpoints under ``{api_prefix}/admin/infra`` and
forwards each call with the shared ``X-Ops-Token`` header.
"""

from __future__ import annotations

from .router import router

__all__ = ["router"]
