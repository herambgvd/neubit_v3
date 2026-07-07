"""kernel — the shared kernel for neubit_v3 satellite services.

Provides a config/auth/events/db/errors subset that is byte-compatible with the
platform core, so tokens verify, events interoperate, and tenant scoping matches
across services. Import what you need:

    from kernel import (
        get_settings,
        Principal, verify_token, get_principal, require_permission,
        Scope, get_scope, scope_of, scoped, owns, assert_owned,
        EventBus, subject, envelope,
        Database, make_base,
        register_error_handlers,
        NotFoundError, ValidationError, ConflictError,
        ForbiddenError, UnauthorizedError, AppError,
    )
"""

from __future__ import annotations

from .auth import (
    Principal,
    Scope,
    WILDCARD,
    assert_owned,
    get_principal,
    get_scope,
    owns,
    require_permission,
    scope_of,
    scoped,
    verify_token,
)
from .config import Settings, get_settings
from .db import Database, make_base
from .errors import (
    AppError,
    ConflictError,
    ForbiddenError,
    NotFoundError,
    UnauthorizedError,
    ValidationError,
    register_error_handlers,
)
from .events import EventBus, envelope, subject

__all__ = [
    # config
    "Settings",
    "get_settings",
    # auth / scope
    "Principal",
    "Scope",
    "WILDCARD",
    "verify_token",
    "get_principal",
    "require_permission",
    "get_scope",
    "scope_of",
    "scoped",
    "owns",
    "assert_owned",
    # events
    "EventBus",
    "subject",
    "envelope",
    # db
    "Database",
    "make_base",
    # errors
    "register_error_handlers",
    "AppError",
    "NotFoundError",
    "ValidationError",
    "ConflictError",
    "ForbiddenError",
    "UnauthorizedError",
]
