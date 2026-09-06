"""Backwards-compatible re-export of the /auth routers.

The routes live in `app/auth/routes/`; this shim stays because `app/app.py` and
several tests import `app.auth.router`.
"""

from .routes import admin_router, router

__all__ = ["router", "admin_router"]
