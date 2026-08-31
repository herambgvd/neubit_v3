"""Metric registry API — `{api_prefix}/bi/metrics/...`.

The HTTP face of `app/metric_registry`. Mounted into `bi_router` (one line at
the bottom of `router.py`), so it inherits the module gate (`analytics`), the
licence gate, and the same local-JWT auth every other /bi route uses.

The permission split mirrors units exactly:

* `bi.read`    list definitions, list roles (with suggestions), evaluate.
* `bi.manage`  REGISTER a definition and CONFIRM/CLEAR a role — statements
               about the estate, the same key that gates confirming a unit.

Registration is where the type system bites: a definition that does not
type-check (`kWh − °C`, an unknown role, a guard nothing mechanizes) is a 422
naming the reason, and NOTHING is stored. Evaluation never 500s a guard
failure — a refusal is a 200 with `{status, reason}` per device, because "this
metric cannot honestly compute here" is an ANSWER, not an error.
"""

from __future__ import annotations

import datetime as dt
import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Query
from kernel.auth import Principal, Scope, get_principal, get_scope, require_permission
from kernel.errors import ValidationError
from pydantic import BaseModel, Field
from reporting.db import get_db
from sqlalchemy.ext.asyncio import AsyncSession

from ..metric_registry import evaluator, registry
from ..metric_registry import roles as role_store
from ..metric_registry.roles import ROLE_DEFS

# Same keys router.py declares; redefined here because router.py imports THIS
# module (the one mount line), so importing back would be circular.
PERM_READ = "bi.read"
PERM_MANAGE = "bi.manage"

metrics_router = APIRouter(prefix="/metrics", tags=["Building Intelligence — metrics"])

Db = Annotated[AsyncSession, Depends(get_db)]
Caller = Annotated[Scope, Depends(get_scope)]
Who = Annotated[Principal, Depends(get_principal)]


def _tenant(scope: Scope) -> uuid.UUID | None:
    """Same semantics as router.py's `_tenant`: platform sees all, a tenant
    token is pinned to its claim, a tenantless non-platform token fails closed."""
    if scope.is_platform:
        return None
    if scope.tenant_id is None:
        raise ValidationError("token carries no tenant")
    return scope.tenant_id


def _actor(who: Principal) -> str | None:
    return str(getattr(who, "user_id", "") or "") or None


# ── Definitions ──────────────────────────────────────────────────────────────


class MetricDefinitionIn(BaseModel):
    """A metric spec, AS DATA. See `metric_registry.registry.typecheck` for
    what gets it rejected — the check runs before anything is stored."""

    key: str = Field(min_length=1, max_length=64)
    kind: str = "formula"
    applies_to: dict = Field(default_factory=dict)
    inputs: dict = Field(default_factory=dict)
    formula: str | None = None
    components: list[dict] | None = None
    output: dict = Field(default_factory=dict)
    guards: list[str] = Field(default_factory=list)
    display: dict = Field(default_factory=dict)
    effective_from: dt.datetime | None = None


@metrics_router.get("", dependencies=[Depends(require_permission(PERM_READ))])
async def list_metrics(db: Db, scope: Caller) -> dict:
    """Every definition visible to this tenant, every version, newest first."""
    return {"items": await registry.list_definitions(db, _tenant(scope))}


@metrics_router.post("", dependencies=[Depends(require_permission(PERM_MANAGE))])
async def register_metric(db: Db, scope: Caller, who: Who, body: MetricDefinitionIn) -> dict:
    """Register a definition — as the NEXT version of its key.

    There is no PUT and no DELETE: a definition, once effective, has answered
    questions, and editing it in place would silently rewrite what those
    answers meant. A correction is a new version with its own effective_from.
    """
    try:
        row = await registry.register(db, _tenant(scope), body.model_dump(), actor=_actor(who))
    except registry.RegistrationError as exc:
        raise ValidationError(f"definition rejected: {exc}") from exc
    return {"registered": row}


# ── Evaluation ───────────────────────────────────────────────────────────────


@metrics_router.get("/evaluate", dependencies=[Depends(require_permission(PERM_READ))])
async def evaluate_metric(
    db: Db,
    scope: Caller,
    metric: str,
    device_id: uuid.UUID | None = None,
    start: dt.datetime | None = None,
    end: dt.datetime | None = None,
    hours: Annotated[int | None, Query(ge=1, le=24 * 90)] = None,
    resolution: str = "auto",
) -> dict:
    """Evaluate a metric over a window, showing the working.

    Reads the ROLLUPS only and states which; a guard failure comes back as a
    structured `{status, reason}` per device — never a 0, never a null that
    renders as one. The definition VERSION used is the one effective at the
    window's end, so an old window keeps the formula it was measured under.
    """
    now = dt.datetime.now(dt.timezone.utc)
    if start is None and end is None:
        end = now
        start = end - dt.timedelta(hours=hours or 24)
    elif start is not None and end is not None:
        if end <= start:
            raise ValidationError("end must be after start")
    else:
        raise ValidationError("pass start AND end, or hours, or nothing (last 24h)")
    try:
        return await evaluator.evaluate(
            db, _tenant(scope), metric,
            device_id=device_id, start=start, end=end, resolution=resolution,
        )
    except evaluator.EvaluationError as exc:
        raise ValidationError(str(exc)) from exc


# ── Roles ────────────────────────────────────────────────────────────────────


class ConfirmRolesRequest(BaseModel):
    """Record that a HUMAN says these points play this role.

    `point_ids` is EXPLICIT and always a list the operator saw — no `pattern`
    field, same as units/confirm, and for the same reason. `role = null`
    CLEARS: the binding is deleted and the point is unbound again; a role an
    operator cannot take back would silently corrupt every metric through it.
    """

    point_ids: list[uuid.UUID] = Field(min_length=1, max_length=1000)
    role: str | None = Field(default=None, max_length=64)


@metrics_router.get("/roles", dependencies=[Depends(require_permission(PERM_READ))])
async def list_roles(
    db: Db,
    scope: Caller,
    category: str | None = None,
    search: str | None = None,
    confirmed: str = "all",
    limit: Annotated[int, Query(ge=1, le=1000)] = 300,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> dict:
    """Every live point, its confirmed role (if any), and what its tag SUGGESTS.

    The suggestion is computed from the tag at read time, labelled with the
    matched pattern in words, and never stored — a tag is a naming convention,
    never evidence. The closed role vocabulary rides along so the screen can
    offer a picker rather than a free-text field.
    """
    if confirmed not in ("all", "confirmed", "unconfirmed"):
        raise ValidationError("confirmed must be one of: all, confirmed, unconfirmed")
    counts, rows = await role_store.list_roles(
        db, _tenant(scope),
        category=category, search=search, confirmed=confirmed,
        limit=limit, offset=offset,
    )
    return {
        "counts": counts,
        "items": rows,
        "vocabulary": [
            {"role": k, **v} for k, v in ROLE_DEFS.items()
        ],
    }


@metrics_router.post("/roles/confirm", dependencies=[Depends(require_permission(PERM_MANAGE))])
async def confirm_roles(db: Db, scope: Caller, who: Who, body: ConfirmRolesRequest) -> dict:
    """An operator asserts (or retracts) the role for a named set of points."""
    if body.role is not None and body.role not in ROLE_DEFS:
        raise ValidationError(
            f"role `{body.role}` is not in the vocabulary "
            f"({', '.join(sorted(ROLE_DEFS))})"
        )
    actor = _actor(who)
    updated = await role_store.confirm_roles(
        db, _tenant(scope), point_ids=body.point_ids, role=body.role, actor=actor,
    )
    return {
        "updated": len(updated),
        "requested": len(body.point_ids),
        "not_visible": len(body.point_ids) - len(updated),
        "role": body.role,
        "role_source": None if body.role is None else "operator",
        "confirmed_by": None if body.role is None else actor,
    }
