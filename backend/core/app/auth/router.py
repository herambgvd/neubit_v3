"""Backwards-compatible re-export of the /auth routers.

The routes moved to `app/auth/routes/` (one module per job). This module stays
because `app/app.py` and several tests import `app.auth.router`, and a rename
that breaks every import site is a worse change than a two-line shim.
"""

from .routes import admin_router, router

__all__ = ["router", "admin_router"]
