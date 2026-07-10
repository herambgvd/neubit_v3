"""Broadcasts — platform-wide announcements the super-admin pushes to tenant consoles.

Extends the single ``announcement`` settings string into scheduled, targeted
messages: each Broadcast has a severity, an optional time window, and a target of
either ALL tenants or a specific subset. The operator console reads the currently
active broadcasts for its tenant via ``GET /broadcasts/active``.
"""

from .router import public_router, router

__all__ = ["public_router", "router"]
