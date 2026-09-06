"""Uniform error handling, copied from core so every service returns the same
JSON envelope and the same stable machine-readable codes:

    { "error": { "code": "NOT_FOUND", "message": "...", "details": {...}? } }

Usage in a route/service — just raise:

    raise NotFoundError("job not found")

``register_error_handlers(app)`` turns any AppError (plus FastAPI validation and
Starlette HTTPExceptions) into the envelope above; anything unexpected becomes a
safe 500 ``INTERNAL_ERROR`` with internals hidden.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import FastAPI, Request, status
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

log = logging.getLogger("kernel.error")


class AppError(Exception):
    """Base class for all application errors. Subclass, or raise directly."""

    code: str = "ERROR"
    status_code: int = status.HTTP_400_BAD_REQUEST

    def __init__(
        self,
        message: str,
        *,
        code: str | None = None,
        status_code: int | None = None,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        if code is not None:
            self.code = code
        if status_code is not None:
            self.status_code = status_code
        self.details = details


class NotFoundError(AppError):
    code = "NOT_FOUND"
    status_code = status.HTTP_404_NOT_FOUND


class ValidationError(AppError):
    code = "VALIDATION_ERROR"
    status_code = 422  # Unprocessable (literal — constant name varies across Starlette)


class ConflictError(AppError):
    code = "CONFLICT"
    status_code = status.HTTP_409_CONFLICT


class UnauthorizedError(AppError):
    code = "UNAUTHORIZED"
    status_code = status.HTTP_401_UNAUTHORIZED


class ForbiddenError(AppError):
    code = "FORBIDDEN"
    status_code = status.HTTP_403_FORBIDDEN


# Map raw HTTP status codes (from Starlette/FastAPI HTTPException) to our codes.
_HTTP_CODE_MAP = {
    400: "BAD_REQUEST",
    401: "UNAUTHORIZED",
    403: "FORBIDDEN",
    404: "NOT_FOUND",
    409: "CONFLICT",
    422: "VALIDATION_ERROR",
    429: "RATE_LIMITED",
    # Upstream failures. Without these a controller that is unreachable, or a
    # gateway timeout, came back as the generic HTTP_ERROR — indistinguishable in
    # a client from any other unmapped status, when it is the one class of error a
    # caller can act on by retrying.
    502: "UPSTREAM_ERROR",
    503: "UNAVAILABLE",
    504: "UPSTREAM_TIMEOUT",
}


# Pydantic's wording for the constraints we use most, rewritten for a person
# reading a toast. Anything not listed falls back to pydantic's `msg`.
_VALIDATION_WORDING = {
    "missing": "is required",
    "string_too_short": "is too short",
    "string_too_long": "is too long",
    "value_error.email": "is not a valid email address",
}


def _field_label(loc: tuple) -> str:
    """"Full name" from ``("body", "full_name")`` — the last named part of the path.
    A ``*_id`` foreign key is labelled by what it points at ("Role", not "Role id"),
    which is what the form calls it."""
    parts = [p for p in loc if isinstance(p, str) and p not in ("body", "query", "path")]
    name = parts[-1] if parts else "request"
    if name.endswith("_id") and len(name) > 3:
        name = name[:-3]
    return name.replace("_", " ").capitalize()


def _validation_message(errors: list[dict]) -> str:
    """Turn pydantic's error list into one readable sentence.

    The UI shows this verbatim in a toast, so name the offending fields — at most
    three, with ``details`` carrying the full list. Kept in step with core's
    app/core/errors.py.
    """
    parts: list[str] = []
    for err in errors[:3]:
        etype = str(err.get("type", ""))
        msg = _VALIDATION_WORDING.get(etype)
        if msg is None and etype == "value_error" and "email" in str(err.get("msg", "")).lower():
            msg = _VALIDATION_WORDING["value_error.email"]
        if msg is None:
            msg = str(err.get("msg", "is invalid")).removeprefix("Value error, ")
        parts.append(f"{_field_label(tuple(err.get('loc') or ()))} {msg[0].lower() + msg[1:]}")
    if not parts:
        return "Request validation failed"
    extra = len(errors) - len(parts)
    return ". ".join(parts) + (f" (+{extra} more)" if extra > 0 else "") + "."


def _envelope(code: str, message: str, details: Any | None = None) -> dict:
    body: dict = {"error": {"code": code, "message": message}}
    if details is not None:
        body["error"]["details"] = details
    return body


def register_error_handlers(app: FastAPI) -> None:
    """Attach the four handlers that produce the uniform error envelope."""

    @app.exception_handler(AppError)
    async def _handle_app_error(request: Request, exc: AppError) -> JSONResponse:
        # Log the refusals. Nothing recorded a 401 or a 403 in any of the seven
        # services on this kernel, so brute-force attempts, permission probing and
        # the NOT_FOUND that assert_owned returns for a cross-tenant id were all
        # invisible. WARNING for a refusal, INFO for the ordinary 4xx (a 404 or a
        # validation failure is traffic, not a signal).
        if exc.status_code in (401, 403, 404, 409):
            level = logging.WARNING if exc.status_code in (401, 403) else logging.INFO
            log.log(
                level, "%s %s -> %s %s",
                request.method, request.url.path, exc.status_code, exc.code,
            )
        return JSONResponse(
            status_code=exc.status_code,
            content=_envelope(exc.code, exc.message, exc.details),
        )

    @app.exception_handler(RequestValidationError)
    async def _handle_validation(_request: Request, exc: RequestValidationError) -> JSONResponse:
        errors = jsonable_encoder(exc.errors())
        return JSONResponse(
            status_code=422,
            content=_envelope("VALIDATION_ERROR", _validation_message(errors), {"errors": errors}),
        )

    @app.exception_handler(StarletteHTTPException)
    async def _handle_http(request: Request, exc: StarletteHTTPException) -> JSONResponse:
        code = _HTTP_CODE_MAP.get(exc.status_code, "HTTP_ERROR")
        if exc.status_code in (401, 403):
            log.warning(
                "%s %s -> %s %s", request.method, request.url.path, exc.status_code, code
            )
        return JSONResponse(
            status_code=exc.status_code,
            content=_envelope(code, str(exc.detail)),
        )

    @app.exception_handler(Exception)
    async def _handle_unexpected(request: Request, exc: Exception) -> JSONResponse:
        log.exception("unhandled error on %s %s", request.method, request.url.path)
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content=_envelope("INTERNAL_ERROR", "An unexpected error occurred"),
        )
