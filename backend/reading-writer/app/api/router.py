"""Building Intelligence read API — `{api_prefix}/bi/...`.

Why it lives in the reading-writer rather than in a new service: contract §7 gives
the readings schema ONE owner, and the platform bans cross-service reads. A
separate "analytics API" container would have to open `neubit_reporting` and
SELECT tables it does not own, which is the second place a schema drifts. So the
owner serves the reads, importing the same `reporting.models`, and everything
here is SELECT-only.

Authorization is the pattern every other satellite uses (`ingest`'s router is the
worked example): the core-minted JWT is verified LOCALLY with the shared secret,
`bi.read` is the permission key, and the tenant comes from the token claim. It is
not a query parameter a caller can set — see `_tenant()`.

Gating, applied where the router is mounted (see `app.main`):
    require_feature("analytics")   the Dashboards & Reports module
    require_active_license()       suspended tenant / expired licence
    require_permission("bi.read")  per-route, like ingest gates ingest.read
"""

from __future__ import annotations

import datetime as dt
import uuid
from typing import Annotated, Literal, get_args

from fastapi import APIRouter, Depends, Query
from kernel.auth import Principal, Scope, get_principal, get_scope, require_permission
from kernel.errors import ForbiddenError, ValidationError
from pydantic import BaseModel, Field as PField
from reporting.db import get_db
from sqlalchemy import text as sa_text
from sqlalchemy.ext.asyncio import AsyncSession

from . import builder
from . import context
from . import correlations as cx
from . import execute as ex
from . import findings as fx
from . import intake as intake_store
from . import permsync
from . import building_facts as building_facts_view
from . import nameplate as nameplate_view
from . import role_asks as role_asks_view
from . import plant as plant_view
from . import suggest_equipment
from . import queries as q
from . import rating as rt
from . import units as un
from . import registry
from . import spec as widget_spec
from . import succession as sx
from .metrics import metrics_router as _metrics_router
from .schemas import (
    ActivityBucket,
    AlertListResponse,
    ConfirmUnitsRequest,
    CorrelationRegistryResponse,
    CorrelationResponse,
    DeviceListResponse,
    PointListResponse,
    RatingResponse,
    SeriesResponse,
    SiteFactsListResponse,
    SummaryResponse,
    UnitListResponse,
    UnitPatternsResponse,
)
from .spec import TableResult as QueryResult

#: Where an operator records a building's facts. Printed in every refusal that
#: sends someone to go and record one, so the sentence and the screen cannot
#: drift apart: BI configuration lives in BI, never in Configurations → Sites.
FACTS_AT = "Building Intelligence → Setup → Building facts"

# The permission key this API gates on. Registered in core's catalog
# (`app/auth/permissions.py`, group "Building Intelligence") so a tenant admin can
# actually grant it in the role editor — a key no catalog knows about can only
# ever be held by a wildcard admin.
PERM_READ = "bi.read"
# The WRITE key. It gates retiring/unretiring a point — an operator's statement
# about what is part of the estate, rather than a reading of it, and one that
# never touches a measurement. It used to gate PLACING a device too; placement
# now happens on the Sites floor plan and is gated by core's own sites
# permissions there. Registered in core's catalog beside bi.read.
PERM_MANAGE = "bi.manage"

bi_router = APIRouter(prefix="/bi", tags=["Building Intelligence"])

Db = Annotated[AsyncSession, Depends(get_db)]
Caller = Annotated[Scope, Depends(get_scope)]
Who = Annotated[Principal, Depends(get_principal)]


def _tenant(scope: Scope) -> uuid.UUID | None:
    """The tenant every query is filtered by. NEVER from the request.

    A tenant-scoped caller gets their own uuid from the JWT claim, so a request
    cannot widen its own scope. A platform super-admin has no tenant claim and
    gets NULL, which the queries read as "no tenant filter" — identical semantics
    to `kernel.auth.scoped()` everywhere else on the platform.
    """
    if scope.is_platform:
        return None
    if scope.tenant_id is None:
        # A non-superadmin token with no tenant claim cannot be scoped to
        # anything. Fail closed rather than falling through to "see everything".
        raise ValidationError("token carries no tenant")
    return scope.tenant_id


def _window(
    start: dt.datetime | None, end: dt.datetime | None, default_hours: int
) -> tuple[dt.datetime, dt.datetime]:
    now = dt.datetime.now(dt.timezone.utc)
    end = end or now
    start = start or (end - dt.timedelta(hours=default_hours))
    if end.tzinfo is None:
        end = end.replace(tzinfo=dt.timezone.utc)
    if start.tzinfo is None:
        start = start.replace(tzinfo=dt.timezone.utc)
    if start >= end:
        raise ValidationError("start must be before end")
    return start, end


# ── Portfolio ────────────────────────────────────────────────────────────────


@bi_router.get(
    "/summary",
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def summary(db: Db, scope: Caller) -> SummaryResponse:
    """What is reporting, by category — the Portfolio screen's whole payload.

    Read from the `points` dimension (cheap, one row per series) plus one
    real-time `readings_1h` aggregate for the current hour's volume. The raw
    hypertable is not touched.
    """
    return SummaryResponse(**await q.summary(db, _tenant(scope)))


@bi_router.get(
    "/activity",
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def activity(
    db: Db,
    scope: Caller,
    hours: Annotated[int, Query(ge=1, le=24 * 90)] = 24,
) -> list[ActivityBucket]:
    """Hourly sample volume per category, from the `readings_1h` rollup.

    This counts SAMPLES — a number the pipeline genuinely knows. It is not a
    physical quantity, because nothing on the wire says what a point measures.
    """
    return [ActivityBucket(**r) for r in await q.activity(db, _tenant(scope), hours)]


# ── Faults & alerts ─────────────────────────────────────────────────────────


@bi_router.get(
    "/alerts",
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def alerts(
    db: Db,
    scope: Caller,
    hours: Annotated[int, Query(ge=1, le=q.ALERTS_MAX_HOURS)] = 24,
    severity: str | None = None,
    category: str | None = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
) -> AlertListResponse:
    """The fault queue — every alert the gateway raised in a bounded window.

    Reads `iot_alerts`, which this MODULE does not write and this PROCESS now
    does: `app.projections` fills it from `tenant.*.iot.alert.*` (builder contract
    §9). That distinction is the whole of the ownership rule since the projector
    was folded in — the readings half still declares nothing about this relation
    and still issues no write against it. Reading it here is the rule, not an
    exception: the reading-writer is the one read path over the whole reporting
    store, and a second one is exactly the drift that rule exists to prevent.

    Bounded to `ALERTS_MAX_HOURS` because this reads RAW, for the same reason
    `/bi/points` does: the queue needs each alert's own message, and the hourly
    rollup deliberately does not carry it. A wider question is a chart, and the
    `iot_alerts` DATASET answers it from the rollup through `/bi/query`.

    `severity` is a plain equality filter over the gateway's own vocabulary
    (`critical` / `warning` / `info`); an unknown value returns nothing rather
    than everything. `category` filters the ITEM list the same way over the
    device's classification (`energy` / `hvac` / `water` / …); the two breakdowns
    are always over the whole window, so a narrowed list still shows what it is a
    slice of.

    Both breakdowns keep their unattributed bucket. An alert whose device carries
    no category is a real fault and is counted as `category: null`, never folded
    into a neighbouring one.
    """
    body = await q.alerts(
        db, _tenant(scope), hours=hours, severity=severity,
        category=category, limit=limit,
    )
    # Gate 6: each alert is a finding an operator may raise work on, and says so
    # with its own source key and the work body — see `findings.py`.
    body["items"] = [{**row, **fx.alert_finding(row)} for row in body["items"]]
    return AlertListResponse(**body)


# ── Devices ──────────────────────────────────────────────────────────────────


@bi_router.get(
    "/devices",
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def devices(
    db: Db,
    scope: Caller,
    category: str | None = None,
    device_type: str | None = None,
    search: str | None = None,
    site_id: uuid.UUID | None = None,
    placement: Literal["placed", "unplaced"] | None = None,
    include_retired: bool = False,
    limit: Annotated[int, Query(ge=1, le=500)] = 100,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> DeviceListResponse:
    """Devices that have REPORTED, grouped from `points`.

    `category=` (empty string) selects the devices nothing has classified — a
    real question, and the honest way to show the unclassified points instead of
    quietly dropping them.

    `placement=unplaced` is the same kind of question about space: the devices no
    site owns, which is the list an operator works from when assigning devices to
    a building through core's `POST /device-placements/assign`. It is a filter
    over what is already true and it selects nothing on anybody's behalf — the
    assignment names its devices one by one.
    """
    total, rows = await q.devices(
        db,
        _tenant(scope),
        category=category,
        device_type=device_type,
        search=search,
        limit=limit,
        offset=offset,
        include_retired=include_retired,
        # Portfolio drill-down: scope to the points placed at one site. There is
        # no "unplaced" sentinel here — the unplaced row links to the floor
        # plan, because its fix is placement, not a filtered console.
        site_id=site_id,
        placement=placement,
    )
    return DeviceListResponse(total=total, items=rows)


# ── Points ───────────────────────────────────────────────────────────────────


@bi_router.get(
    "/points",
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def points(
    db: Db,
    scope: Caller,
    device_id: uuid.UUID | None = None,
    device_tag: str | None = None,
    category: str | None = None,
    type: str | None = None,
    search: str | None = None,
    site_id: uuid.UUID | None = None,
    with_latest: bool = True,
    include_retired: bool = False,
    limit: Annotated[int, Query(ge=1, le=500)] = 200,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> PointListResponse:
    """A device's points, each with its latest value.

    `latest` reads RAW over a bounded lookback, not `readings_1m`: that rollup is
    materialized-only with a ~2 minute freshness floor, and a current-value tile
    that is two minutes behind the building is a different product. The window is
    bounded (`LATEST_LOOKBACK_MINUTES`) so the cost does not grow with history —
    it is an index scan down the `(point_id, ts)` primary key per point.

    A point with nothing inside the window returns `latest: null`. It does NOT
    return an older value: presenting an hours-old reading as the current one is
    the same class of lie as inventing a unit.
    """
    total, rows = await q.points(
        db,
        _tenant(scope),
        device_id=device_id,
        device_tag=device_tag,
        category=category,
        point_type=type,
        search=search,
        limit=limit,
        offset=offset,
        with_latest=with_latest,
        include_retired=include_retired,
        site_id=site_id,
    )
    return PointListResponse(
        total=total,
        items=rows,
        latest_lookback_minutes=q.LATEST_LOOKBACK_MINUTES,
    )


@bi_router.post(
    "/points/{point_id}/retire",
    dependencies=[Depends(require_permission(PERM_MANAGE))],
)
async def retire_point(db: Db, scope: Caller, point_id: uuid.UUID) -> dict:
    """Retire a point: stop counting it, delete nothing.

    A point that stops reporting used to count toward every Building
    Intelligence figure forever, and the only way out was to DELETE the
    dimension row — which orphans its readings, because `readings` has no
    foreign key to `points`. This sets `retired_at` instead: the point drops out
    of the summary, the device rollups and the activity chart, and every reading
    it ever produced stays exactly where it is and is still queryable by id.

    It is not permanent. The writer clears `retired_at` on the next reading,
    because a point that is reporting is not retired whatever anyone said about
    it last month. Retiring a LIVE point therefore hides it only until it speaks
    again — which is the honest behaviour, not a bug.

    Tenant-scoped: a caller can only retire a point in their own tenant.
    """
    return await q.set_retired(db, _tenant(scope), point_id, retired=True)


@bi_router.post(
    "/points/{point_id}/unretire",
    dependencies=[Depends(require_permission(PERM_MANAGE))],
)
async def unretire_point(db: Db, scope: Caller, point_id: uuid.UUID) -> dict:
    """Undo an explicit retire, restoring the point to the counts.

    Clears `retired_at` only. It cannot bring back a point that is retired by the
    `last_seen_at` HORIZON — nothing but a new reading can do that, and that is
    the point of the horizon.
    """
    return await q.set_retired(db, _tenant(scope), point_id, retired=False)


# ── Ghost points ─────────────────────────────────────────────────────────────


class GhostChoice(BaseModel):
    """One group, and WHICH member the operator says is the real one.

    The pair identifies the group and `survivor_point_id` must be one of its
    members — a survivor that is not is refused with a 400 and nothing is
    collapsed, because "keep this point" naming a point that was never part of
    the group is a claim about identity that was never true.
    """

    device_tag: str = PField(max_length=255)
    point_tag: str = PField(max_length=255)
    survivor_point_id: uuid.UUID


class CollapseGhostsRequest(BaseModel):
    """Either "collapse everything that is unambiguous", or an explicit list.

    `mode = "auto"` collapses every group the classifier called AUTO — exactly
    one member reporting inside the freshness window — and can never reach a
    MANUAL one. There is no `mode = "manual"`: a manual group is a question, and
    a bulk answer to a question nobody read is the thing this whole feature is
    trying not to do.

    `groups` is the answer to those questions, one at a time, and it is always a
    list the operator saw. Same rule as `ConfirmUnitsRequest`: no server-side
    pattern expansion, because a pattern evaluated here is a guess wearing a
    human's authority.
    """

    mode: str | None = None
    groups: list[GhostChoice] | None = PField(default=None, max_length=1000)


class RestoreGhostsRequest(BaseModel):
    """Undo a collapse for these points. Ids only — see the route's docstring
    for what it will and will not touch."""

    point_ids: list[uuid.UUID] = PField(min_length=1, max_length=1000)


@bi_router.get(
    "/points/ghosts",
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def ghost_points(
    db: Db,
    scope: Caller,
    category: str | None = None,
    mode: str | None = None,
    site_id: uuid.UUID | None = None,
) -> dict:
    """The duplicated `(device_tag, point_tag)` pairs, and what can be settled.

    A conflux connection that is deleted and re-created mints a NEW `point_id`
    for every point behind it, so one physical register accumulates a generation
    per rebuild — all of them unretired, all of them counted in every estate
    figure. This is the worklist for that: one entry per duplicated pair, its
    members with their last-seen times, and a verdict.

    `mode` is the verdict, and it is a proposal rather than a decision:

      auto    exactly ONE member reported inside the freshness window, so the
              others are provably superseded. `survivor_point_id` names it.
      manual  zero fresh members (which generation is real is a question about
              the building, not about the data) or more than one (two
              generations are both delivering — collapsing either would destroy
              a live series). `survivor_point_id` is null and stays null;
              nothing is ever auto-applied to one of these.

    The grouping deliberately ignores the retirement HORIZON and looks only at
    `retired_at IS NULL`. A ghost has not reported in weeks by definition, so
    applying the horizon would hide every member this endpoint exists to find.

    `resurrected` is the other half, and it is here because the writer will not
    hide it: a point the collapse superseded that has started reporting again
    comes back live while still carrying `superseded_by`. That disagreement means
    two generations of one register are both talking, and an operator needs to
    see it rather than have it papered over.
    """
    tenant = _tenant(scope)
    if mode is not None and mode not in ("auto", "manual"):
        raise ValidationError("mode must be 'auto' or 'manual'")
    # `site_id` scopes to one building: a group is kept when ANY of its
    # generations is placed there — see `ghost_groups` for why the placement
    # cannot filter members before they are grouped.
    groups = await q.ghost_groups(db, tenant, category=category, mode=mode, site_id=site_id)
    return {
        "groups": groups,
        "total": len(groups),
        "auto": sum(1 for g in groups if g["mode"] == "auto"),
        "manual": sum(1 for g in groups if g["mode"] == "manual"),
        "fresh_minutes": q.FRESH_MINUTES,
        "resurrected": await q.resurrected_points(
            db, tenant, category=category, site_id=site_id
        ),
    }


@bi_router.post(
    "/points/ghosts/collapse",
    dependencies=[Depends(require_permission(PERM_MANAGE))],
)
async def collapse_ghost_points(
    db: Db, scope: Caller, body: CollapseGhostsRequest
) -> dict:
    """Retire a group's superseded generations onto its survivor.

    For each group: every non-survivor member gets `retired_at = now()`,
    `retire_reason = 'ghost'` and `superseded_by = <survivor>`, and any role a
    ghost carried MOVES to the survivor. Nothing is deleted and no reading is
    touched — `readings` is a compressed hypertable keyed `(point_id, ts)`, and
    the ghost keeps every row it ever produced under its own id. History is
    joined by walking `superseded_by`, not by rewriting a primary key across
    compressed chunks.

    ONE GROUP IS ONE TRANSACTION. A half-collapsed group — roles moved but the
    ghosts still live — is worse than an uncollapsed one, because nothing
    downstream could tell it had happened.

    Role migration is idempotent and the SURVIVOR WINS: `point_roles` is keyed by
    point alone, so if the survivor already carries a role the ghost's is
    discarded rather than overwriting it, and the count says so. Re-running a
    collapse that already happened finds no duplicated pair and skips it.

    Gated by `bi.manage`, the same key as retiring a point: this is a statement
    about what the estate IS, not a reading of it.

    Tenant-scoped, and the scoping is in the grouping rather than only in the
    write: the duplicate set is computed INSIDE the caller's tenant, so a caller
    cannot name another tenant's point as a survivor or reach one as a ghost.

    It is reversible — see `/points/ghosts/restore`.
    """
    if body.mode is not None and body.groups is not None:
        raise ValidationError("send either mode or groups, not both")
    if body.mode is None and body.groups is None:
        raise ValidationError("send either mode='auto' or an explicit groups list")
    if body.mode is not None and body.mode != "auto":
        # "manual" is refused BY NAME rather than ignored. A caller who sends it
        # is asking for a bulk answer to the questions this feature exists to
        # ask, and silently collapsing nothing would look like success.
        raise ValidationError(
            "the only bulk mode is 'auto'; a manual group is collapsed by naming "
            "its survivor in `groups`"
        )
    return await q.collapse_ghosts(
        db,
        _tenant(scope),
        mode=body.mode,
        choices=(
            None
            if body.groups is None
            else [g.model_dump() for g in body.groups]
        ),
    )


@bi_router.post(
    "/points/ghosts/restore",
    dependencies=[Depends(require_permission(PERM_MANAGE))],
)
async def restore_ghost_points(
    db: Db, scope: Caller, body: RestoreGhostsRequest
) -> dict:
    """Undo a collapse for the named points — and ONLY for the ones it retired.

    Clears `retired_at`, `retire_reason` and `superseded_by`: exactly the three
    columns the collapse wrote, so a restored point is back where it started.

    THE NARROWNESS IS THE POINT. This reaches a row only when
    `retire_reason = 'ghost'`. A point an operator retired by hand through
    `/points/{id}/retire` has a NULL reason and is untouched however loudly it is
    named, which is what stops "undo that collapse" from also being "undo every
    decommissioning decision anyone ever made". A named point that is not reached
    comes back in `refused` rather than being counted as a success.

    Roles are NOT put back. The collapse moved a ghost's role onto the survivor
    because the survivor is the point that means something now; handing it back
    would re-create the ambiguity a metric definition cannot resolve.
    """
    return await q.restore_ghosts(db, _tenant(scope), point_ids=body.point_ids)


# ── Role succession ──────────────────────────────────────────────────────────
#
# The half of the rebuild problem the ghost collapse above cannot see. A collapse
# groups on `(device_tag, point_tag)`, so it settles a connection rebuilt under
# the SAME tags. When the rebuild RENAMES the tag as well, the generations are
# not duplicates of anything and the operator's role binding is simply stranded
# on a point that has stopped reporting — which is the state all 19 of this
# deployment's `point_roles` rows that still HAVE a point are in. The table holds
# 20: the twentieth names a point id with no dimension row at all, which no join
# to `points` can see and which `/points/roles/forget` is the only answer to. See
# `app/api/succession.py` for the measurement and for what "still reporting"
# means here.


class RoleMove(BaseModel):
    """One role, the point it is stranded on, and the point that replaced it.

    All three are required and none of them is inferred. `role` is checked
    against what the predecessor CURRENTLY carries rather than trusted, so a
    worklist that went stale between the GET and the POST is refused instead of
    rebinding something the operator never saw.
    """

    role: str = PField(max_length=64)
    from_point_id: uuid.UUID
    to_point_id: uuid.UUID


class RepointRolesRequest(BaseModel):
    """An explicit list of moves the operator chose, and nothing else.

    Same rule as `ConfirmUnitsRequest` and `CollapseGhostsRequest`: no mode, no
    pattern, no "apply everything above a score". The proposal is computed on
    `GET /points/roles/orphans` and read by a human, and what comes back here is
    the ids they picked.
    """

    moves: list[RoleMove] = PField(min_length=1, max_length=500)


class UndoRepointRequest(BaseModel):
    """The moves to put back, named exactly as the repoint reported them.

    Same shape as `RepointRolesRequest` on purpose: `from_point_id` is the
    predecessor the role came off and `to_point_id` the successor it went to, so
    an undo is posted with the record of the move rather than with an inference
    about which of two points was which.
    """

    moves: list[RoleMove] = PField(min_length=1, max_length=500)


class ForgetRolesRequest(BaseModel):
    """The point ids whose role rows the operator chose to delete. Nothing else.

    Same shape as `RestoreGhostsRequest`, and for a stronger reason: this DELETES
    an operator's assertion and no self-heal puts it back. There is deliberately
    no `mode`, so "forget every orphan whose point is missing" is not a request
    this API can express — the worklist is read by a human and what comes back is
    the ids they picked, one at a time.
    """

    point_ids: list[uuid.UUID] = PField(min_length=1, max_length=500)


@bi_router.get(
    "/points/roles/asks",
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def role_asks(
    db: Db,
    scope: Caller,
    site_id: uuid.UUID | None = None,
    hours: int = Query(role_asks_view.DEFAULT_LOOKBACK_HOURS, ge=1, le=8760),
) -> dict:
    """Device by device: which of its readings something computed needs a role
    for, what the tag suggests, and what the reading says right now.

    The estate stores hundreds of readings that nothing computes with, and a
    screen that lists all of them cannot be used. So only a point whose
    confirmed role, or whose tag's suggested role, is read by an EFFECTIVE
    metric definition appears here — with the metric keys that read it
    (`needed_by`), and its latest value inside the window, because a role
    asserted on a reading nobody looked at is the mistake the confirm guard
    exists for. `reporting: false` says that guard will challenge the press.

    Writes nothing. The write is `POST /bi/metrics/roles/confirm`.
    """
    return await role_asks_view.role_asks(db, _tenant(scope), site_id=site_id, hours=hours)


@bi_router.get(
    "/points/roles/orphans",
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def orphan_roles(
    db: Db, scope: Caller, role: str | None = None, site_id: uuid.UUID | None = None
) -> dict:
    """Roles bound to points that have stopped reporting, and who could succeed them.

    A gateway rebuild that renames a tag mints a new `point_id` under the new
    spelling and leaves the old row behind. The operator's role binding stays on
    the old row, which is still `retired_at IS NULL` and still looks like a point,
    so every metric that selects the role reads a series that stopped weeks ago
    and refuses with `no_data` — for a chiller that is running.

    For each stranded role this returns the candidates on the SAME device, ordered
    by score, WITH THE EVIDENCE THAT PRODUCED THE SCORE. The evidence is the
    output, not a debugging aid: a number an operator cannot check is a number
    they should not act on, so every signal comes back as a sentence naming what
    matched — the unchanged tag, the shared measurement token and its position,
    this estate's own role convention, the unit, the dimension.

    ORPHANED IS MEASURED AGAINST THE DEVICE, NOT THE CLOCK. A role is orphaned
    when its point is behind its device's newest reading, not when it is outside
    the 15-minute freshness window. On this deployment the whole estate is
    routinely outside that window between ingest runs, and a worklist that empties
    and fills depending on ingest timing is not usable. `fresh` is still reported
    per point so the operator can see the estate is between runs.

    NOTHING HERE IS APPLIED. There is no threshold above which a score becomes a
    decision. Where no candidate is credible the list is empty and
    `candidates_considered` says how many points were looked at, because "no
    successor found" is a correct answer and has to be distinguishable from a
    screen that did not run.

    THREE WAYS TO BE ORPHANED, reported apart in `orphan_reason` because they are
    different facts about the building and have different answers:

      * `superseded` — the point is behind its device's leading edge. The device
        is still delivering, through another tag. This is what a repoint settles;
      * `retired` — the point is retired, so it is not part of the estate and a
        role on it cannot be selecting anything;
      * `point_missing` — there is no `points` row for that id AT ALL. Not
        retired: gone. `point_roles` has no foreign key to `points`, so a role
        outlives the dimension row it names, and this worklist used to INNER JOIN
        `points` and therefore hide the single most orphaned assertion on the
        estate. Such a row comes back with every point-shaped field null, zero
        candidates and `candidates_considered = 0` — with no device tag there is
        no candidate set, because the same-device rule is the whole of the safety
        and here it has nothing to stand on. The only honest action on it is
        `POST /points/roles/forget`.

    `total` counts every row returned and `with_candidates + without_candidates`
    equals it; a `point_missing` row is always in `without_candidates`.

    `role` narrows the result to one role name. It cannot change any candidate
    set — candidates are a property of the device.
    """
    return await sx.orphan_roles(db, _tenant(scope), role=role, site_id=site_id)


@bi_router.post(
    "/points/roles/repoint",
    dependencies=[Depends(require_permission(PERM_MANAGE))],
)
async def repoint_roles(db: Db, scope: Caller, body: RepointRolesRequest) -> dict:
    """Move each named role onto the successor the operator named. One transaction per move.

    Per move: `points.superseded_by` on the predecessor names the successor — the
    same continuity chain a ghost collapse writes, so a rename joins history the
    same way a re-key does — and the role is carried across that chain by
    `reporting.role_succession`, the same statement the writer runs when a
    superseded point's successor starts reporting. One reconcile, two callers, so
    an operator's move and a self-heal cannot drift apart.

    It writes NO retirement. The old generation stops being counted by the
    `last_seen_at` horizon on its own; retiring it here would be a second decision
    this route was not asked to make, and marking it `retire_reason = 'ghost'`
    would hand it to an undo built for a different operation.

    REFUSALS, all of them before anything is written, all of them reported rather
    than raised so one stale row cannot discard the rest of a worklist:

      * a successor on a DIFFERENT DEVICE. Cross-device succession is a separate
        and riskier feature — `IWT` is on every chiller in the building — and the
        rule is enforced here and not only in the proposal, because ids are what
        the operator posts back, not the worklist;
      * a predecessor that no longer carries the named role;
      * a successor that already carries a DIFFERENT role. `point_roles` is keyed
        by point alone, so one of the two assertions would have to go, and both
        are an operator's. This diverges from the collapse, which reports
        `roles_discarded` and lets the survivor win: there the caller asked to
        settle a group, here they named this successor for this role, so
        discarding either side would discard what they explicitly asked for. The
        conflicting role is named so it can be settled on the roles screen;
      * a successor that is retired, or that is the predecessor.

    Gated by `bi.manage`, like retiring a point and like collapsing a group: this
    is a statement about what the estate MEANS, not a reading of it.
    """
    return await sx.repoint_roles(
        db, _tenant(scope), moves=[m.model_dump() for m in body.moves]
    )


@bi_router.post(
    "/points/roles/repoint/undo",
    dependencies=[Depends(require_permission(PERM_MANAGE))],
)
async def undo_repoints(db: Db, scope: Caller, body: UndoRepointRequest) -> dict:
    """Put each named role back on the point it was moved off. One transaction per move.

    A repoint is a human deciding that one tag is the same measurement another
    used to be, and a human can be wrong — the tag can belong to the chiller next
    door. Collapsing a ghost group has had an undo since it shipped
    (`/points/ghosts/restore`); this is the repoint's.

    Per move: the predecessor's `superseded_by` is cleared — only where it still
    names this successor, so an undo cannot erase a history it did not write —
    and the role row moves back carrying its own `role_source`, `confirmed_by`
    and `confirmed_at`. The assertion belongs to whoever made it, whenever they
    made it; an undo restores it rather than restating it as today's.

    REFUSALS, all before anything is written, all reported rather than raised:

      * the move is NOT THE ONE ON RECORD — the predecessor is superseded by
        something else now, or by nothing. The estate moved on and a stale
        worklist must not bind a role nobody asked for;
      * the successor no longer carries the named role;
      * the predecessor already carries a role — both are an operator's
        assertion and this route chooses between neither;
      * the predecessor is retired, which forward is what a retired successor is:
        a role on it would be a measurement the estate says is not there.

    Gated by `bi.manage`, like the repoint it reverses.
    """
    return await sx.undo_repoints(
        db, _tenant(scope), moves=[m.model_dump() for m in body.moves]
    )


@bi_router.post(
    "/points/roles/forget",
    dependencies=[Depends(require_permission(PERM_MANAGE))],
)
async def forget_roles(db: Db, scope: Caller, body: ForgetRolesRequest) -> dict:
    """Delete the role rows whose point no longer exists. Named ids, one transaction each.

    The only action available on an orphan whose `orphan_reason` is
    `point_missing`. A repoint cannot reach it — a successor must be on the same
    device and there is no device tag to read, because the row that carried it is
    gone — so without this the assertion is unfixable AND undeletable from any
    screen, which is the state that made it invisible in the first place.

    IT REACHES A ROW ONLY WHEN THAT ROW'S POINT IS MISSING, and the condition is
    in the DELETE and not only in the check before it. A role whose point exists
    is refused by name: moving it is a repoint and clearing it is an unbind, and
    they are different decisions about a measurement that is still there. The
    restatement is not belt and braces — the writer mints a `points` row for any
    id a reading arrives under, so a point CAN come back between the check and the
    write, and the guard has to be where the row is.

    NOTHING IS SWEPT. There is no mode and no "forget every missing one": this
    erases a human's statement about what a number meant and nothing puts it back,
    so it takes the ids a human named, the same rule `/points/ghosts/restore`
    follows for a far more reversible operation. Each deleted assertion is echoed
    back in `results` — after the delete, that response is the last place it
    exists.

    Gated by `bi.manage`, like the repoint and the collapse.

    Tenant-scoped on `point_roles.tenant_id`, which is the only tenant column
    left once the point is gone. Another tenant's row is not in the rows at all,
    so "there is no such role" and "it is not yours" are the same refusal.
    """
    return await sx.forget_roles(db, _tenant(scope), point_ids=body.point_ids)


# ── Placement ────────────────────────────────────────────────────────────────
#
# THERE IS NO PLACEMENT API HERE ANY MORE, AND THAT IS THE POINT.
#
# Placing a device already had a home before this store existed: Configurations →
# Sites → floor plan, backed by `neubit_control.device_placements`, which carries
# `site_id` / `floor_id` / `zone_id` beside the pin's `{x, y, rotation}`. A second
# BI-only placement screen writing `device_locations` directly was the same fact
# stated twice, with nothing to stop the two disagreeing.
#
# So `device_placements` is the source of truth and `device_locations` is this
# store's local READ-MODEL of it, fed by `app/placement_sync.py` — a durable
# consumer of core's `tenant.*.sites.device_placement.>` events. The rules that
# used to live on these routes did not go away; they moved:
#
# 1. **Names come from core, never from the client.** Core now publishes the
#    site / floor / zone NAME beside the id on the event, read from its own rows.
#    That is stronger than the HTTP round-trip this module used to make: the
#    authority states the label rather than being asked to confirm one.
# 2. **Unplaced is a state, not a gap.** Nothing infers a floor from a tag, and a
#    device with no pin has no `device_locations` row and no placed points.
# 3. **A placement is never overwritten by a reading.** Unchanged — the points
#    upsert never names these columns and `reconcile_placement` reads only
#    `device_locations`.
#
# WHAT IS GONE WITH THEM, STATED RATHER THAN HIDDEN:
#
# * ~~**Site-without-floor placement.**~~ RESTORED, at the source of truth rather
#   than by a second writer here. Core's migration 0031 made
#   `device_placements.floor_id` and `floor_position` nullable TOGETHER (a floor
#   with no coordinates is a pin at no coordinates, and that is refused by a CHECK
#   constraint), and added `POST /device-placements/assign` — the device-first
#   surface that names a site for an explicit list of devices. A rooftop meter
#   that belongs to the building and to no storey is expressible again, it travels
#   the same event path, and `device_locations` has always modelled it.
# * **The point-level override.** `/placement/points` was the only way to say
#   "this sub-meter is not where its panel is". `reconcile_placement` still
#   refuses to touch a row marked `placement_source = 'point'`, and
#   `placement.place_points` / `reset_points` still exist — but no route reaches
#   them, so today the capability is unreachable outside SQL.



# ── Series ───────────────────────────────────────────────────────────────────


@bi_router.get(
    "/series",
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def series(
    db: Db,
    scope: Caller,
    point_id: Annotated[list[uuid.UUID], Query(min_length=1)],
    start: dt.datetime | None = None,
    end: dt.datetime | None = None,
    resolution: str = "auto",
    hours: Annotated[int, Query(ge=1, le=24 * 90)] = 6,
) -> SeriesResponse:
    """One or more point series over a window, read from a CONTINUOUS AGGREGATE.

    `resolution=auto` (the default, and what every screen uses) picks `1m` for a
    window up to 3 hours and `1h` beyond it — see `queries.choose_resolution` for
    what each one costs in freshness. `raw` is available for drill-down but only
    inside `RAW_MAX_MINUTES`; a wider raw request is a 400 naming the rollup to
    ask for instead, because silently downgrading it would make the chart claim a
    precision it does not have.
    """
    tenant = _tenant(scope)
    if len(point_id) > q.MAX_SERIES_POINTS:
        raise ValidationError(f"at most {q.MAX_SERIES_POINTS} points per request")

    start_at, end_at = _window(start, end, hours)

    if resolution == "auto":
        resolution, reason = q.choose_resolution(start_at, end_at)
    elif resolution == "raw":
        span_min = (end_at - start_at).total_seconds() / 60.0
        if span_min > q.RAW_MAX_MINUTES:
            raise ValidationError(
                f"raw readings are limited to {q.RAW_MAX_MINUTES} minutes "
                f"(asked for {int(span_min)}); use resolution=1m or 1h"
            )
        reason = "raw readings (bounded window) — every sample, no aggregation"
    elif resolution in ("1m", "1h"):
        reason = (
            "1-minute rollup (readings_1m); materialized-only, so the newest "
            "~2 minutes may not be included yet"
            if resolution == "1m"
            else "1-hour rollup (readings_1h); real-time aggregate, current hour included"
        )
    else:
        raise ValidationError("resolution must be one of: auto, 1m, 1h, raw")

    # Resolve the labels FIRST. This doubles as the tenant check: a point that
    # does not come back here is not the caller's, and is dropped before a single
    # reading is read.
    meta = await q.point_meta(db, tenant, point_id)
    allowed = [p for p in point_id if p in meta]
    if not allowed:
        return SeriesResponse(
            resolution=resolution,
            resolution_reason=reason,
            start=start_at,
            end=end_at,
            series=[],
        )

    buckets = await q.series(
        db,
        tenant,
        point_ids=allowed,
        start=start_at,
        end=end_at,
        resolution=resolution,
    )
    return SeriesResponse(
        resolution=resolution,
        resolution_reason=reason,
        start=start_at,
        end=end_at,
        series=[
            {
                "point_id": pid,
                "point_tag": meta[pid]["point_tag"],
                "device_tag": meta[pid]["device_tag"],
                "unit": meta[pid]["unit"],
                "buckets": buckets.get(pid, []),
            }
            for pid in allowed
        ],
    )


# ── Correlation ──────────────────────────────────────────────────────────────


def _correlation_points(point_id: list[uuid.UUID]) -> list[uuid.UUID]:
    """The distinct points asked for, refusing a matrix nobody could read."""
    ids: list[uuid.UUID] = []
    for p in point_id:
        if p not in ids:
            ids.append(p)
    if len(ids) < 2:
        raise ValidationError("correlation needs two distinct points")
    if len(ids) > q.MAX_CORRELATION_POINTS:
        raise ValidationError(
            f"at most {q.MAX_CORRELATION_POINTS} series per request "
            f"(asked for {len(ids)}); a wider matrix is unreadable before it is expensive"
        )
    return ids


def _correlation_resolution(
    resolution: str, start_at: dt.datetime, end_at: dt.datetime
) -> tuple[str, str]:
    """Which rollup answers, and why it is the one that answered.

    RAW IS NOT AN OPTION. Correlating raw samples would correlate whatever
    happened to share a timestamp, which is a different question from the one
    this screen asks; and contract §5 puts analysis on the rollups.
    """
    if resolution == "auto":
        return q.choose_resolution(start_at, end_at)
    if resolution in ("1m", "1h"):
        reason = (
            "1-minute rollup (readings_1m); materialized-only, so the newest "
            "~2 minutes may not be included yet"
            if resolution == "1m"
            else "1-hour rollup (readings_1h); real-time aggregate, current hour included"
        )
        return resolution, reason
    raise ValidationError(
        "resolution must be one of: auto, 1m, 1h — correlation is computed on "
        "the rollups, never on raw readings"
    )


def _point_label(m: dict) -> str:
    return f"{m['device_tag'] or '?'} / {m['point_tag'] or '?'}"


def _correlation_series_row(pid: uuid.UUID, m: dict, st: dict | None) -> dict:
    """One series' own summary — what it reported, and whether it ever moved."""
    n = int(st["n"]) if st else 0
    distinct = int(st["distinct_values"]) if st else 0
    return {
        "point_id": pid,
        "point_tag": m["point_tag"],
        "device_tag": m["device_tag"],
        "category": m["category"],
        "unit": m["unit"],
        "buckets": n,
        "distinct_values": distinct,
        "frozen": n > 0 and distinct <= 1,
        "min": st["min"] if st else None,
        "max": st["max"] if st else None,
        "mean": st["mean"] if st else None,
        "first_bucket": st["first_bucket"] if st else None,
        "last_bucket": st["last_bucket"] if st else None,
    }


def _correlation_series(allowed: list[uuid.UUID], meta: dict, stats: dict) -> dict:
    """Every series' summary, with the two sets a pair's status turns on: the
    frozen series (no variance) and the silent ones (no buckets at all)."""
    rows: list[dict] = []
    frozen: set[uuid.UUID] = set()
    silent: set[uuid.UUID] = set()
    for pid in allowed:
        row = _correlation_series_row(pid, meta[pid], stats.get(pid))
        if row["frozen"]:
            frozen.add(pid)
        if row["buckets"] == 0:
            silent.add(pid)
        rows.append(row)
    return {"series": rows, "frozen": frozen, "silent": silent}


def _no_overlap_pair(a, b, meta: dict, silent: set) -> dict:
    """Absence renders as absence. Say WHICH kind of absence it is: a series that
    reported nothing at all is a different problem from two series that reported
    at times that never met."""
    quiet = [p for p in (a, b) if p in silent]
    if quiet:
        why = (
            f"{' and '.join(_point_label(meta[p]) for p in quiet)} reported no numeric "
            f"bucket in this window"
        )
    else:
        why = "the two series never filled the same bucket in this window"
    return {"a": a, "b": b, "n": 0, "r": None, "status": "no_overlap", "reason": why}


def _correlation_pair(
    a, b, row: dict | None, meta: dict, frozen: set, silent: set, resolution: str
) -> dict:
    """One pair's coefficient, or the named reason there is none."""
    n = int(row["n"]) if row else 0
    if n == 0:
        return _no_overlap_pair(a, b, meta, silent)

    overlap = {"overlap_start": row["overlap_start"], "overlap_end": row["overlap_end"]}
    flat = [p for p in (a, b) if p in frozen]
    if flat:
        return {
            "a": a, "b": b, "n": n, "r": None,
            "status": "undefined_frozen",
            "reason": (
                f"undefined — {' and '.join(_point_label(meta[p]) for p in flat)} "
                f"reported one value for all {n} overlapping buckets, so its "
                f"standard deviation is zero and Pearson's r has no value "
                f"(this is not a correlation of zero)"
            ),
            **overlap,
        }
    if n < q.MIN_CORRELATION_BUCKETS:
        return {
            "a": a, "b": b, "n": n, "r": None,
            "status": "too_few",
            "reason": (
                f"only {n} overlapping bucket(s); below "
                f"{q.MIN_CORRELATION_BUCKETS} a coefficient is determined by "
                f"the arithmetic rather than by the building"
            ),
            **overlap,
        }
    r_val = row["r"]
    if r_val is None:
        # corr() went NULL for a reason the distinct-value check did not
        # catch (a series flat only across the OVERLAP, for instance).
        return {
            "a": a, "b": b, "n": n, "r": None,
            "status": "undefined_frozen",
            "reason": (
                f"undefined — one of the two series did not vary across the "
                f"{n} overlapping buckets, so its standard deviation is zero"
            ),
            **overlap,
        }
    return {
        "a": a, "b": b, "n": n, "r": float(r_val),
        "status": "ok",
        "reason": f"Pearson r over {n} aligned {resolution} buckets",
        **overlap,
    }


def _correlation_pairs(
    allowed: list[uuid.UUID], rows: list[dict], meta: dict,
    frozen: set, silent: set, resolution: str
) -> list[dict]:
    """Every unordered pair, once."""
    found = {(r["a_id"], r["b_id"]): r for r in rows}
    pairs: list[dict] = []
    for i, a in enumerate(allowed):
        for b in allowed[i + 1 :]:
            row = found.get((a, b)) or found.get((b, a))
            pairs.append(
                _correlation_pair(a, b, row, meta, frozen, silent, resolution)
            )
    return pairs


@bi_router.get(
    "/correlation",
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def correlation(
    db: Db,
    scope: Caller,
    point_id: Annotated[list[uuid.UUID], Query(min_length=2)],
    start: dt.datetime | None = None,
    end: dt.datetime | None = None,
    resolution: str = "auto",
    hours: Annotated[int, Query(ge=1, le=24 * 90)] = 168,
) -> CorrelationResponse:
    """Pearson correlation between measured series, pairwise, over aligned buckets.

    This endpoint exists because the coefficient does NOT need a unit. r is a
    ratio of a covariance to two standard deviations, so the units cancel; and
    the series are not anonymous — each carries the source's own `device_tag` and
    `point_tag`, which is what the response labels it with. What the number does
    NOT license is an interpretation, and nothing here supplies one: no ranking
    of causes, no "driver", no explanation.

    Everything a reader needs in order to distrust an answer travels with it:

    * `n` — the buckets that actually overlapped. A pair that never overlapped
      is `status="no_overlap"` with `r=None`, never a zero.
    * a FROZEN series (one distinct value) has zero variance, so every r
      involving it is UNDEFINED — `status="undefined_frozen"`, naming the flat
      side. Postgres `corr()` returns NULL there and this does not paper over it.
    * `resolution` / `resolution_reason` — which rollup answered. There is no raw
      path at all here, and `auto` is never silently downgraded.
    """
    tenant = _tenant(scope)
    ids = _correlation_points(point_id)
    start_at, end_at = _window(start, end, hours)
    resolution, reason = _correlation_resolution(resolution, start_at, end_at)

    # Resolve labels FIRST; this is also the tenant check (see `series`). A point
    # that does not come back is not the caller's and is dropped before a single
    # reading is read.
    meta = await q.point_meta(db, tenant, ids)
    allowed = [p for p in ids if p in meta]
    if len(allowed) < 2:
        raise ValidationError("correlation needs two points visible to this caller")

    stats = await q.correlation_stats(
        db, tenant, point_ids=allowed, start=start_at, end=end_at, resolution=resolution
    )
    rows = await q.correlation_pairs(
        db, tenant, point_ids=allowed, start=start_at, end=end_at, resolution=resolution
    )
    summary = _correlation_series(allowed, meta, stats)
    pairs_out = _correlation_pairs(
        allowed, rows, meta, summary["frozen"], summary["silent"], resolution
    )

    samples: list[dict] = []
    truncated = False
    if len(allowed) == 2:
        raw = await q.correlation_scatter(
            db,
            tenant,
            a_id=allowed[0],
            b_id=allowed[1],
            start=start_at,
            end=end_at,
            resolution=resolution,
        )
        samples = [{"t": r["t"], "a": r["a"], "b": r["b"]} for r in raw]
        truncated = len(samples) >= q.MAX_SCATTER_SAMPLES

    return CorrelationResponse(
        resolution=resolution,
        resolution_reason=reason,
        start=start_at,
        end=end_at,
        min_buckets=q.MIN_CORRELATION_BUCKETS,
        series=summary["series"],
        pairs=pairs_out,
        samples=samples,
        samples_truncated=truncated,
    )


# ── Cross-domain correlations (the registry, not the coefficient) ────────────
#
# `/correlation` above computes r between two series a caller names. THIS route
# answers a question one step earlier and, commercially, the more important one:
# which cross-domain questions can this estate answer at all, and for the ones it
# cannot, what kind of thing is missing.
#
# It is on `bi.read` like every other read here. Nothing it touches is a write,
# nothing it reports is auto-applied, and it never proposes to fix anything on the
# operator's behalf — the remedies it returns name a screen a human goes to.


@bi_router.get(
    "/correlations",
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def correlations(
    db: Db,
    scope: Caller,
    start: dt.datetime | None = None,
    end: dt.datetime | None = None,
    hours: Annotated[int, Query(ge=1, le=24 * 365)] = cx.DEFAULT_WINDOW_HOURS,
) -> CorrelationRegistryResponse:
    """Which cross-domain questions this estate can answer, and what blocks the rest.

    A BMS owns one domain, so it can only ask questions inside one. The seven
    correlations seeded in migration 0025 each need two, and each one declares the
    signals it needs rather than hard-coding where they come from. This resolves
    those declarations against the estate and returns, per signal, whether it is
    satisfied and — when it is not — the KIND of gap, what is gating it in this
    estate's own terms, and what closing it would unlock.

    The kinds are the answer, not the count. `needs_new_hardware` on each gap is
    what separates "buy a sensor" from "switch on a module you already own", and
    it is a TRI-STATE: `null` means this service cannot determine it, which
    happens for exactly one reason and is explained in the gap's own `gate`. The
    totals count `null` in its own bucket, so a screen can say "N gaps · 0 need
    new hardware · M undetermined" without the backend having quietly decided
    that undetermined means no.

    The window matters and is echoed back, and it is the basis on which EVERY
    signal is judged — a point counts when it produced readings inside it, not
    when it merely exists or was bound to a role once. "The access stream
    published nothing" and "the chiller's IWT published nothing" are both
    statements about this window, and a signal present over 90 days and absent
    over 7 is a different answer to a different question.

    That is why `signal_silent` exists as a kind of its own. A role bound to a
    sensor that stopped is the most misleading state an estate can be in: every
    configuration screen says it is correct, because it IS correct, and the
    measurement is gone anyway. It is reported as undetermined for hardware, not
    free — this service cannot tell a failed transducer from a dropped gateway
    link from a tag a rebuild renamed.
    """
    tenant = _tenant(scope)
    start_at, end_at = _window(start, end, hours)
    try:
        resolved = await cx.resolve_all(db, tenant, start=start_at, end=end_at)
    except cx.SpecError as exc:
        # A seeded correlation this build cannot resolve. Loud, not silent: a
        # signal nothing can satisfy renders exactly like a real gap, and an
        # operator would go looking for a door that was never the problem.
        raise ValidationError(str(exc)) from exc
    return CorrelationRegistryResponse(
        start=start_at,
        end=end_at,
        hours=int((end_at - start_at).total_seconds() // 3600),
        totals=cx.totals(resolved),
        correlations=resolved,
    )



# ── Plant (L3) ───────────────────────────────────────────────────────────────


@bi_router.get(
    "/sites/{site_id}/plant",
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def site_plant(
    db: Db,
    scope: Caller,
    site_id: uuid.UUID,
    start: dt.datetime | None = None,
    end: dt.datetime | None = None,
    hours: Annotated[int, Query(ge=1, le=24 * 7)] = 1,
) -> dict:
    """A site's systems → equipment → slots, for the L3 plant schematic.

    Each slot carries its DATA READINESS — one of `reporting`, `silent`,
    `ambiguous`, `unresolved`, `unbound` (worst-first in `readiness_states`) —
    with the point it resolved to, that point's latest value in the window, and
    the reason whenever it did not resolve to one reporting point. Each piece of
    equipment and each system carries the least-ready state of its parts, and
    each piece of equipment carries every effective equipment-scope metric's
    outcome (ΔT, band occupancy against its own design band, kW/TR) — a value
    with its working, or a refusal naming what is missing.

    The window is what "reporting" is judged over: a slot reports when its point
    produced a reading inside it, not when the point merely exists. It defaults
    to the last hour, a dozen polls at this estate's five-minute cadence.
    """
    tenant = _tenant(scope)
    start_at, end_at = _window(start, end, hours)
    return await plant_view.plant(db, tenant, site_id, start=start_at, end=end_at)


@bi_router.get(
    "/sites/{site_id}/equipment/suggestions",
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def equipment_suggestions(db: Db, scope: Caller, site_id: uuid.UUID) -> dict:
    """What each device placed in this building probably IS — proposed, never saved.

    For every device: a class of machine (or `null`, said), which point goes in
    which slot with the value it read, checks on those readings, whether it is
    already registered, and — for the power chain — what probably feeds it (one
    candidate is a suggestion, several are a shortlist). Leftovers of old copies
    come back as `fragment: true` so the drawing can keep them off.

    Writes nothing. The console saves through core, which validates every word.
    See `suggest_equipment.py`.
    """
    return await suggest_equipment.suggestions(db, _tenant(scope), site_id)


@bi_router.get(
    "/sites/{site_id}/facts",
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def building_facts(db: Db, scope: Caller, site_id: uuid.UUID) -> dict:
    """One building's facts record: what is on file, with its source and when it
    was recorded, and what is still missing with the figure it holds up.

    Only facts an EFFECTIVE metric definition reads are here, plus the benchmark
    inputs the version of the standard in force reads — `occupancy` and `city`
    are in the mirror and are not asked for, because nothing reads them. Nothing
    is derived: a city is not a climate zone and a floor plan is not an AC share.

    Writes nothing. The area, the tariff and the emission factors are core's
    (`PATCH /sites/{id}`, `PUT /sites/{id}/emission-factors`); the benchmark
    inputs are `PUT /bi/rating/benchmark-config`. See `building_facts.py`.
    """
    return await building_facts_view.building_facts(db, _tenant(scope), site_id)


@bi_router.get(
    "/sites/{site_id}/equipment/nameplate",
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def equipment_nameplate(
    db: Db,
    scope: Caller,
    site_id: uuid.UUID,
    days: int = Query(nameplate_view.DEFAULT_DAYS, ge=1, le=365),
) -> dict:
    """The plate facts still missing on this building's machines, and the ΔT band
    its own readings show.

    Only what a metric actually reads is asked for: a fact is here because some
    effective metric's input says `source: "equipment_fact"` on this class, and
    every question carries the metric keys (`blocks`) that stay refused without
    it. The band comes with an OBSERVATION — the p10–p90 of the hours where both
    water temperatures reported and the machine was cooling — so nobody has to
    remember a design sheet; too few such hours and there is no observation
    rather than a made-up one.

    Writes nothing: the write is core's design PUT. See `nameplate.py`.
    """
    return await nameplate_view.nameplate(db, _tenant(scope), site_id, days=days)


@bi_router.get(
    "/sites/{site_id}/findings",
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def site_findings(
    db: Db,
    scope: Caller,
    site_id: uuid.UUID,
    start: dt.datetime | None = None,
    end: dt.datetime | None = None,
    hours: Annotated[int, Query(ge=1, le=24 * 7)] = 1,
) -> dict:
    """Gate 6 at one site: every finding its plant can raise work on.

    One per equipment metric outcome (value or refusal) and one per `silent` or
    `ambiguous` slot, each with its `source_key`, a title and summary a person
    can read, the evidence exactly as `/plant` returned it, and `work` — the body
    to POST to `/workflow/instances` once an operator has picked a procedure.
    Read-only: listing a finding raises nothing. Same window as `/plant`, because
    it IS `/plant`, read once and restated.
    """
    tenant = _tenant(scope)
    start_at, end_at = _window(start, end, hours)
    plant = await plant_view.plant(db, tenant, site_id, start=start_at, end=end_at)
    return {
        "site_id": plant["site_id"],
        "site_name": plant["site_name"],
        "window": plant["window"],
        "findings": fx.plant_findings(plant),
    }


# ── Units ────────────────────────────────────────────────────────────────────
#
# The unit is the input that separates a number from a quantity, and it is the
# one input a rating cannot do without. `points.unit` is NULL for all 314 points
# because the wire carries no `env.u` (contract §11/§12); these two routes are
# how it stops being NULL, and the rule they exist to enforce is that only a
# HUMAN can make that happen.


@bi_router.get(
    "/units",
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def units(
    db: Db,
    scope: Caller,
    category: str | None = None,
    search: str | None = None,
    confirmed: str = "all",
    limit: Annotated[int, Query(ge=1, le=1000)] = 300,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> UnitListResponse:
    """Every point, its unit, WHO said so, and what its tag appears to say.

    `suggestion` is derived from the point TAG at read time and is never stored.
    That is the whole shape of this feature: `KWH_kwh` and `Freq_Hz` look like
    they carry their unit, and offering that reading for a human to confirm is
    honest, while writing it silently is the naming-convention fabrication the
    contract forbids (§17 — `4F-3F AC DB` names two floors).

    `confirmed=unconfirmed` is the useful view: it is the work.
    """
    if confirmed not in ("all", "confirmed", "unconfirmed"):
        raise ValidationError("confirmed must be one of: all, confirmed, unconfirmed")
    counts, rows = await un.list_units(
        db,
        _tenant(scope),
        category=category,
        search=search,
        confirmed=confirmed,
        limit=limit,
        offset=offset,
    )
    return UnitListResponse(counts=counts, items=rows)


@bi_router.get(
    "/units/patterns",
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def unit_patterns(
    db: Db,
    scope: Caller,
    category: str | None = None,
    site_id: uuid.UUID | None = None,
) -> UnitPatternsResponse:
    """The catalogue of tag conventions, each with the set it is holding RIGHT NOW.

    576 of this estate's 766 live points have no confirmed unit, and they are not
    576 decisions: `1FYC1_IWT`, `4FKC2_IWT` and `1FYorkChiller1_IWT` are one
    decision about one convention. This route is how an operator sees that — per
    pattern, what it proposes, how many unconfirmed points it matches, a sample of
    their tags, and how many it would SKIP because a human already ruled on them.

    It is a READ. Nothing here writes, nothing here is applied, and there is no
    threshold above which anything would be: the numbers exist so that a person
    can look at forty tags and decide, not so the server can decide for them.

    Three kinds of row come back and the screen must not flatten them:

    * `kind="unit"` — a unit is proposed and `POST /units/confirm` can apply it.
    * `kind="state"` — `OnOff STS`, `Work_Mode`. Not measurements. No unit is
      proposed and none can be applied in bulk.
    * `kind="ambiguous"` — `KWL1_A` names power and ends in the amps suffix;
      `Cum_Flow` does not say whether it is a volume or a rate. The pattern
      exists so the collision is VISIBLE, and it proposes nothing.

    `category` narrows to one BI category (`hvac` is the worst backlog: 28 of 176
    confirmed). Pass it here and pass the same value to the confirm call, or the
    set previewed and the set written are not the same set.
    """
    return UnitPatternsResponse(
        **await un.pattern_catalogue(
            db, _tenant(scope), category=category, site_id=site_id
        )
    )


# ── Intake ───────────────────────────────────────────────────────────────────
#
# The surface the units and roles screens were missing. New devices land on this
# estate WEEKLY and, until this route existed, nothing anywhere answered "what
# arrived and still means nothing to us" — the refusal was real but it was buried
# inside a metric evaluation nobody reads until a number renders as a dash.
#
# It is ONE route rather than one per screen because the question spans both
# assertions: a point needs a unit before a rating, a role before a metric, and
# an operator triaging a week's arrivals should not have to hold two lists.


@bi_router.get(
    "/intake",
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def intake(
    db: Db,
    scope: Caller,
    days: Annotated[int, Query(ge=1, le=365)] = intake_store.INTAKE_WINDOW_DAYS,
    state: str | None = None,
    pending: bool = True,
    new_only: bool = False,
    search: str | None = None,
    limit: Annotated[int, Query(ge=1, le=1000)] = 200,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> dict:
    """Arrivals, the confirmation backlog ranked by whether the work pays, and
    the addresses that have never carried a reading.

    `state` is the distinction that matters and it is keyed on
    `max(readings.ts)`, NOT on `points.last_seen_at`. The writer no longer
    touches the dimension row for a message that stored nothing, but the rows it
    already inflated cannot heal — a point that never reports again has no
    truthful timestamp to write — and this is the surface those rows must show
    up on. See `app/api/intake.py` for the rest of the argument.
    `never_reported` is not "pending
    confirmation" — it is an address that does not exist, and it is the trap
    that turns a correct refusal into a metric nobody can explain.

    `pending=true` (the default) is the work: everything whose unit no human has
    confirmed. A missing ROLE rides along per row but is not counted as a
    backlog — most points are an input to no metric and never will be.
    """
    if state is not None and state not in intake_store.STATES:
        raise ValidationError(f"state must be one of: {', '.join(intake_store.STATES)}")
    return await intake_store.intake(
        db,
        _tenant(scope),
        days=days,
        state=state,
        pending=pending,
        new_only=new_only,
        search=search,
        limit=limit,
        offset=offset,
    )


# The ceiling on one pattern application. No pattern on this estate comes near
# it — the largest is 124 points — and that is the point: a request that would
# write to more than this is a request whose set nobody could have reviewed, and
# it is refused with the number rather than truncated to it.
MAX_PATTERN_APPLY = 1000


def _actor_id(who) -> str | None:
    """The caller's USER ID, from the token.

    Not an email: the JWT does not carry one and asking core for it would be an
    HTTP round-trip to decorate a provenance field. An id that resolves in the
    audit log is a better record than a name that could go stale.
    """
    return str(getattr(who, "user_id", "") or "") or None


def _confirm_label(row: dict) -> str:
    return f"{row.get('device_tag') or '?'} / {row.get('point_tag') or '?'}"


def _confirm_response(
    *,
    mode: str,
    pattern,
    unit: str | None,
    actor: str | None,
    dry_run: bool,
    requested: int,
    resolved: int,
    updated: int,
    not_visible: int,
    skipped: list[dict],
    challenged: list[dict],
    would_update: list[dict] | None = None,
) -> dict:
    """One shape for both selectors, and every number in it is a DIFFERENT number
    on purpose.

    `requested` is what the selector covered, `resolved` what survived the
    guards, `updated` what was actually written — 0 on a dry run, always, with
    `would_update` carrying the preview instead. Collapsing these into a single
    "300 confirmed" would hide the two facts that matter most: the rows a human
    had already ruled on, and the rows that are not carrying readings at all.
    """
    return {
        "mode": mode,
        "dry_run": dry_run,
        "pattern": None if pattern is None else pattern.key,
        "pattern_basis": None if pattern is None else pattern.basis,
        "updated": updated,
        "would_update_count": resolved if dry_run else None,
        "would_update": would_update,
        "requested": requested,
        "resolved": resolved,
        # A requested id that is not the caller's tenant's simply does not come
        # back. Said out loud rather than reported as a success.
        "not_visible": not_visible,
        # Rule 2, made visible. Points a human already confirmed, which a pattern
        # is never allowed to overwrite. Reported apart from `updated` because
        # "applied 300" when 40 were skipped is a lie about what happened.
        "skipped_already_confirmed": skipped,
        "skipped_already_confirmed_count": len(skipped),
        "unit": unit,
        "unit_source": None if unit is None or dry_run else "operator",
        "confirmed_by": None if unit is None or dry_run else actor,
        # Said out loud in the success response too. An acknowledged assertion on
        # a silent point is a legitimate act, but it is not the same act as
        # confirming a point that is delivering values, and the operator who did
        # it should see which ones they overrode.
        "confirmed_not_reporting": challenged,
    }


async def _confirm_by_ids(db, tenant, actor: str | None, body: ConfirmUnitsRequest) -> dict:
    """The original path: the operator names the rows.

    Already-confirmed points are NOT skipped here, and that is deliberate. A
    human who selected a row they had ruled on before and asserted again is
    correcting themselves. The guard against silent overwriting belongs to the
    PATTERN path, where the set was expanded by a rule rather than chosen.
    """
    visible = await un.visible_points(db, tenant, body.point_ids)
    if body.dry_run:
        # `acknowledged=True` so the guard REPORTS instead of raising. A dry run
        # exists to show an operator the challenge before they meet it; raising
        # here would make the preview harder to read than the real call.
        challenged = (
            []
            if body.unit is None
            else await intake_store.guard_confirmable(
                db, tenant, point_ids=body.point_ids, acknowledged=True, what="unit"
            )
        )
        return _confirm_response(
            mode="point_ids",
            pattern=None,
            unit=body.unit,
            actor=actor,
            dry_run=True,
            requested=len(body.point_ids),
            resolved=len(visible),
            updated=0,
            not_visible=len(body.point_ids) - len(visible),
            skipped=[],
            challenged=challenged,
            would_update=[
                {"point_id": r["point_id"], "label": _confirm_label(r)} for r in visible
            ],
        )

    challenged = []
    if body.unit is not None:
        challenged = await intake_store.guard_confirmable(
            db,
            tenant,
            point_ids=body.point_ids,
            acknowledged=body.acknowledge_not_reporting,
            what="unit",
        )
    updated = await un.confirm_units(
        db, tenant, point_ids=body.point_ids, unit=body.unit, actor=actor
    )
    return _confirm_response(
        mode="point_ids",
        pattern=None,
        unit=body.unit,
        actor=actor,
        dry_run=False,
        requested=len(body.point_ids),
        resolved=len(visible),
        updated=len(updated),
        not_visible=len(body.point_ids) - len(updated),
        skipped=[],
        challenged=challenged,
    )


async def _confirm_by_pattern(db, tenant, actor: str | None, body: ConfirmUnitsRequest) -> dict:
    """The bulk path: the operator confirms a CATALOGUED convention.

    Every guard this feature has lives in the first thirty lines below, and each
    one is a refusal rather than a correction:

    * an unknown pattern key is a 400 naming the catalogue, never a no-op — a
      client that misspelt `active_power_kw` must not be told it succeeded on
      zero rows;
    * a `state` or `ambiguous` pattern cannot be applied AT ALL. `OnOff STS` is
      not a measurement, and `KWL1_A` is a tag whose two halves disagree; there
      is no unit to write, and the per-id path is where a human settles them;
    * the unit is the CATALOGUE'S, never the request's — `ConfirmUnitsRequest`
      rejects a `unit` sent alongside a `pattern`, so what gets written is
      exactly what `GET /units/patterns` displayed;
    * points a human already confirmed are removed from the set BEFORE the write
      and reported back under `skipped_already_confirmed`. A pattern is not
      allowed to overrule a person.
    """
    pattern = un.PATTERNS_BY_KEY.get(body.pattern or "")
    if pattern is None:
        raise ValidationError(
            f"unknown unit pattern `{body.pattern}` — see GET /bi/units/patterns "
            f"for the catalogue",
            code="UNKNOWN_UNIT_PATTERN",
            details={"patterns": sorted(un.PATTERNS_BY_KEY)},
        )
    if not pattern.proposes_unit:
        raise ValidationError(
            f"`{pattern.key}` proposes no unit and cannot be applied in bulk: "
            f"{pattern.basis}. Confirm these points by `point_ids` if a human has "
            f"decided what they measure.",
            code="PATTERN_PROPOSES_NO_UNIT",
            details={"pattern": pattern.key, "kind": pattern.kind, "basis": pattern.basis},
        )

    _, eligible, already = await un.pattern_targets(
        db, tenant, key=pattern.key, category=body.category, site_id=body.site_id
    )
    if len(eligible) > MAX_PATTERN_APPLY:
        raise ValidationError(
            f"`{pattern.key}` matches {len(eligible)} unconfirmed points, above the "
            f"{MAX_PATTERN_APPLY} this route will apply in one call. Narrow it with "
            f"`category` — a set this size is one nobody reviewed.",
            code="PATTERN_TOO_BROAD",
        )

    point_ids = [r["point_id"] for r in eligible]
    skipped = [
        {
            "point_id": r["point_id"],
            "point_tag": r["point_tag"],
            "unit": r["unit"],
            "unit_source": r["unit_source"],
        }
        for r in already
    ]

    if body.dry_run:
        challenged = await intake_store.guard_confirmable(
            db, tenant, point_ids=point_ids, acknowledged=True, what="unit"
        )
        return _confirm_response(
            mode="pattern",
            pattern=pattern,
            unit=pattern.unit,
            actor=actor,
            dry_run=True,
            requested=len(eligible) + len(already),
            resolved=len(point_ids),
            updated=0,
            not_visible=0,
            skipped=skipped,
            challenged=challenged,
            # The whole set, named. A count is what the operator decides on; the
            # names are what let them find the one row that does not belong.
            would_update=[
                {"point_id": r["point_id"], "label": _confirm_label(r)} for r in eligible
            ],
        )

    challenged = await intake_store.guard_confirmable(
        db,
        tenant,
        point_ids=point_ids,
        acknowledged=body.acknowledge_not_reporting,
        what="unit",
    )
    updated = await un.confirm_units(
        db, tenant, point_ids=point_ids, unit=pattern.unit, actor=actor
    )
    return _confirm_response(
        mode="pattern",
        pattern=pattern,
        unit=pattern.unit,
        actor=actor,
        dry_run=False,
        requested=len(eligible) + len(already),
        resolved=len(point_ids),
        updated=len(updated),
        not_visible=0,
        skipped=skipped,
        challenged=challenged,
    )


@bi_router.post(
    "/units/confirm",
    dependencies=[Depends(require_permission(PERM_MANAGE))],
)
async def confirm_units(db: Db, scope: Caller, who: Who, body: ConfirmUnitsRequest) -> dict:
    """An operator asserts the unit for a set of points they have seen.

    Gated by `bi.manage`, not `bi.read`: this WRITES a fact that a rating divides
    by. It is the same key that gates retiring a point — statements about the
    estate rather than readings of it.

    THE SET IS NAMED TWO WAYS and both of them are a human's. `point_ids` is the
    rows in front of the operator. `pattern` is a catalogued convention
    (`GET /units/patterns`) whose count and sample they read first and whose full
    membership `dry_run` enumerates — because 576 unconfirmed points is not 576
    decisions, and a backlog nobody can finish is its own way of having no units
    at all.

    What is NOT negotiable, and is enforced rather than documented:

    * nothing is auto-applied. This route is the only writer, it runs when a
      person calls it, and there is no confidence score anywhere beneath it;
    * a pattern applies the CATALOGUE'S unit. `ConfirmUnitsRequest` refuses a
      `unit` sent beside a `pattern`, so the thing written is the thing shown;
    * a pattern never overwrites a confirmed unit — those rows come back under
      `skipped_already_confirmed`, counted apart from `updated`;
    * a pattern that proposes no unit (a STATE like `OnOff STS`, or an AMBIGUITY
      like `KWL1_A`) is refused outright. Bulk is precisely the wrong tool for a
      tag whose meaning is in doubt.

    `dry_run: true` resolves the whole thing and writes nothing.

    `unit: null` clears back to unconfirmed — per id only, which has to be
    reachable; see `ConfirmUnitsRequest`.

    A unit asserted on a point that is not carrying readings is CHALLENGED, not
    stored (`app/api/intake.py`): kWh on an address that has never produced a
    number is a fact no rating can ever use, and the confirmation succeeding is
    what makes it invisible. Clearing is never challenged, and a dry run reports
    the challenge instead of raising it.
    """
    tenant = _tenant(scope)
    actor = _actor_id(who)
    if body.pattern:
        return await _confirm_by_pattern(db, tenant, actor, body)
    return await _confirm_by_ids(db, tenant, actor, body)


# ── Ratings ──────────────────────────────────────────────────────────────────


@bi_router.get(
    "/rating/sites",
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def rating_sites(db: Db, scope: Caller) -> SiteFactsListResponse:
    """Sites this store has been told about, with their rating inputs.

    Read from `site_facts` — the local read-model of `neubit_control.sites`, fed
    by the site-facts event mirror (pipeline contract §18). Nothing here opens
    core's database, and nothing here invents a fact: a site with no area shows a
    null area, which is what the screen turns into "cannot rate".
    """
    return SiteFactsListResponse(items=await rt.sites(db, _tenant(scope)))


def _selected_meters(point_id, by_id: dict) -> dict:
    """The meters the caller named: the usable ones, and the named ones that
    cannot count — not at this site, retired, or, the common case, nobody has
    confirmed they are in kWh."""
    chosen: list[uuid.UUID] = []
    unusable: list[str] = []
    for pid in point_id or []:
        if pid in by_id and pid not in chosen:
            chosen.append(pid)
        elif pid not in by_id:
            unusable.append(str(pid))
    return {"chosen": chosen, "unusable": unusable}


async def _role_bound_meters(db, tenant, by_id: dict) -> list:
    """The registers an operator BOUND as `energy_register` in point_roles.

    When this endpoint was written there was no stored fact saying which
    register is the supply, so the caller had to name them per request. The
    metric registry changed that: the role IS that fact now — asserted,
    provenance-carrying, and deliberately excluding twin meters and sub-boards
    (contract §21). An explicit `point_id` list still overrides, because a
    caller asking about one specific meter is asking a narrower question, not
    contradicting the stored fact.
    """
    role_rows = (
        (
            await db.execute(
                sa_text(
                    "SELECT point_id FROM point_roles"
                    " WHERE role = 'energy_register'"
                    "   AND (tenant_id = CAST(:tenant AS uuid) OR (:tenant IS NULL AND tenant_id IS NULL))"
                ),
                {"tenant": str(tenant) if tenant else None},
            )
        )
        .scalars()
        .all()
    )
    chosen: list[uuid.UUID] = []
    for pid in role_rows:
        # Role-bound but not a candidate here = bound at another site, or
        # unplaced. Silently using it would attribute another site's (or no
        # site's) energy to this one, so it is simply not chosen.
        if pid in by_id and pid not in chosen:
            chosen.append(pid)
    return chosen


def _no_meter_reason(candidates: list) -> str:
    """Nothing to add up — and the two ways that happens need two answers."""
    if candidates:
        return (
            "No meter selected. Bind the site's supply registers to the "
            "`energy_register` role on the Metric Roles screen (or pass "
            "`point_id` explicitly) — the platform stores no other fact saying "
            "which meter is the supply, and guessing from a tag would be an "
            "invention."
        )
    return (
        "No point at this site has a CONFIRMED kWh unit. A rating counts "
        "only registers an operator has confirmed are kilowatt-hours; the "
        "wire carries no unit, so until somebody confirms one there is "
        "nothing to add up."
    )


def _epi_from(ok: list[dict], area, site: dict) -> dict:
    """The annualised EPI and what it cost — or the reason there is no interval
    to annualise over."""
    measured = sum(float(m["consumption_kwh"] or 0.0) for m in ok)
    first = min(m["first_bucket"] for m in ok)
    last = max(m["last_bucket"] for m in ok)
    # Days of readings actually covered — NOT the window asked for. A 30-day
    # request over 20 hours of data must annualise from the 20 hours and say
    # so, not pretend it saw a month.
    days_covered = max((last - first).total_seconds() / 86400.0, 0.0)
    if days_covered <= 0:
        return {
            "epi": None, "cost": None,
            "blocked": [
                "The selected meters span less than one hourly bucket, so there is "
                "no interval to annualise over."
            ],
        }
    factor = 365.0 / days_covered
    annualised = measured * factor
    value = annualised / float(area)
    epi = {
        "epi_kwh_per_sqm_year": value,
        "measured_kwh": measured,
        "days_covered": days_covered,
        "annualised_kwh": annualised,
        "area_sqm": float(area),
        "annualisation_factor": factor,
        "formula": (
            f"{measured:,.1f} kWh measured over {days_covered:.2f} days "
            f"× (365 / {days_covered:.2f}) = {annualised:,.1f} kWh/yr, "
            f"÷ {float(area):,.0f} m² = {value:,.1f} kWh/m²/yr"
        ),
    }
    cost = None
    tariff = site["energy_tariff_per_kwh"]
    currency = site["tariff_currency"]
    if tariff and currency:
        cost = {
            "amount": measured * float(tariff),
            "currency": currency,
            "tariff_per_kwh": float(tariff),
            "formula": (
                f"{measured:,.1f} kWh × {float(tariff):g} {currency}/kWh = "
                f"{measured * float(tariff):,.2f} {currency} for the measured window"
            ),
        }
    return {"epi": epi, "cost": cost, "blocked": []}


@bi_router.get(
    "/rating",
    dependencies=[Depends(require_permission(PERM_READ))],
)
async def rating(
    db: Db,
    scope: Caller,
    site_id: uuid.UUID,
    point_id: Annotated[list[uuid.UUID] | None, Query()] = None,
    days: Annotated[int, Query(ge=1, le=1096)] = 30,
) -> RatingResponse:
    """EPI for one site over a window — or the reasons it cannot be computed.

    THE INPUTS, AND WHO OWNS EACH:

    * **kWh** — measured, but only counted from points an operator has CONFIRMED
      are kilowatt-hour registers (`unit_source = 'operator'`). A unit the wire
      happened to send is not somebody standing behind it.
    * **Area** — `site_facts.gross_floor_area_sqm`, mirrored from core, typed by
      an operator in Building Intelligence → Setup → Building facts. NULL blocks
      the rating outright.
    * **Which meters** — the CALLER's, passed as `point_id`. There is no stored
      fact saying which register measures the whole supply, and picking one by
      tag would be a fabrication; summing everything would double-count an
      incomer against its own sub-meters. So the operator names them and the
      response shows each one's arithmetic.

    WHAT IT REFUSES TO DO: no default area, no estimated area, no national
    average, no partial score. Every missing input becomes a line in `blocked`
    and the `epi` field stays null.
    """
    tenant = _tenant(scope)
    end = dt.datetime.now(dt.timezone.utc)
    start = end - dt.timedelta(days=days)

    all_sites = await rt.sites(db, tenant)
    site = next((s for s in all_sites if s["site_id"] == site_id), None)
    if site is None:
        raise ForbiddenError("no such site in this tenant's reporting store")

    candidates = await rt.candidate_meters(db, tenant, site_id)
    by_id = {c["point_id"]: c for c in candidates}

    selected = _selected_meters(point_id, by_id)
    chosen = selected["chosen"]
    unusable = selected["unusable"]
    if not chosen:
        chosen = await _role_bound_meters(db, tenant, by_id)

    blocked: list[str] = []
    if not chosen:
        blocked.append(_no_meter_reason(candidates))
    if unusable:
        blocked.append(
            f"{len(unusable)} selected point(s) are not confirmed kWh registers at "
            f"this site and were not counted."
        )

    meters: list[dict] = []
    if chosen:
        regs = await rt.registers(db, tenant, point_ids=chosen, start=start, end=end)
        meters = [rt.meter_row(by_id[p], regs.get(p)) for p in chosen]

    # `register_frozen` still carries a real measurement (0.0 with the register
    # value beside it) — it is COUNTED, so the EPI stays a statement about what
    # the meters actually recorded. The dishonesty it could cause (a frozen
    # estate grading five stars) is cut off at the band instead, in
    # _withhold_band_if_frozen. Only `register_decreased` and `no_data`
    # contribute nothing: the first has no derivable delta, the second nothing
    # measured at all.
    ok = [m for m in meters if m["status"] in ("ok", "register_frozen")]
    if meters and not ok:
        blocked.append(
            "None of the selected meters produced a usable delta over this window "
            "— see each meter's own reason below."
        )

    area = site["gross_floor_area_sqm"]
    if area is None:
        blocked.append(
            "Cannot rate — no built-up area recorded for this site. An EPI is "
            "kWh per square metre per year; record the gross floor area in "
            f"{FACTS_AT} and this becomes computable. Nothing is "
            "defaulted or estimated in the meantime."
        )

    epi = None
    cost = None
    if ok and area:
        computed = _epi_from(ok, area, site)
        epi = computed["epi"]
        cost = computed["cost"]
        blocked.extend(computed["blocked"])

    return RatingResponse(
        site=site,
        start=start,
        end=end,
        resolution=rt.RESOLUTION,
        resolution_reason=rt.RESOLUTION_REASON,
        meters=meters,
        epi=epi,
        cost=cost,
        benchmark=_withhold_band_if_frozen(
            meters,
            await rt.benchmark_state(
                db, tenant, site_id,
                epi["epi_kwh_per_sqm_year"] if epi else None,
                # The window END picks the standard VERSION: the latest whose
                # effective date ≤ it (jan-2022 today; feb-2009 for windows
                # ending before 2022) — same rule the metric registry applies
                # to definitions.
                as_of=end,
            ),
        ),
        baseline=await rt.baseline_state(db, tenant, site_id),
        blocked=blocked,
    )


class BenchmarkConfigRequest(BaseModel):
    """The site inputs a zone-specific benchmark needs, said by an OPERATOR.

    BEE's bands differ by climate zone and by whether the conditioned area
    exceeds 50% of built-up area. Neither is derivable — a city name is not a
    zone, and a floor plan is not an AC share — so both are explicit
    statements here, and `null` CLEARS (a mis-set zone an operator cannot take
    back would silently grade every EPI against the wrong table).
    """

    site_id: uuid.UUID
    standard_key: str = "bee_star_office"
    climate_zone: str | None = None
    # feb-2009 reads the over/under-50% CATEGORY; jan-2022 reads the
    # CONTINUOUS percentage. Both are operator statements; each version of the
    # standard reads its own field and blocks, by name, on the one it needs.
    ac_category: str | None = None
    ac_share_percent: float | None = PField(default=None, ge=0, le=100)


def _withhold_band_if_frozen(meters: list[dict], bench: dict) -> dict:
    """No grade for a rating whose EVERY register is frozen.

    EPI 0.0 built on registers that stopped moving falls into the BEST band —
    five stars for a dead meter is the confident-garbage shape this platform
    refuses. The EPI itself stays in the response (it IS the measurement, and
    each meter carries its own `register_frozen` status beside it); only the
    band is withheld, and the reason says why rather than pointing at a
    `blocked` list that is empty in this case.
    """
    if (
        bench.get("band") is not None
        and meters
        and all(m["status"] in ("register_frozen", "no_data") for m in meters)
    ):
        bench = {**bench, "band": None, "reason": (
            "every contributing register is frozen across the window — the EPI "
            "measures dead meters, not efficiency, so no band is graded until a "
            "register moves"
        )}
    return bench


@bi_router.put(
    "/rating/benchmark-config",
    dependencies=[Depends(require_permission(PERM_MANAGE))],
)
async def set_benchmark_config(
    db: Db, scope: Caller, who: Who, body: BenchmarkConfigRequest
) -> dict:
    """Record the site's climate zone / AC-share category for the benchmark.

    Values are validated against the SEEDED standard's own tables — a zone the
    standard does not publish is refused by name, because storing it would
    manufacture a blocked state that looks like a config error later.
    """
    tenant = _tenant(scope)
    all_sites = await rt.sites(db, tenant)
    if not any(s["site_id"] == body.site_id for s in all_sites):
        raise ForbiddenError("no such site in this tenant's reporting store")

    # WHOSE row this is, taken from the SITE rather than from the actor.
    #
    # `_tenant(scope)` is None for a super-admin, and this row used to store that
    # None. `benchmark_site_config.tenant_id` is the only thing a tenant erase can
    # match on, so a config a super-admin saved on a tenant's site was a row the
    # right-to-erase would never find — for a site that unambiguously belongs to
    # someone. The site's own tenant is the correct answer either way: a tenant
    # admin gets the same value they would have supplied, and a super-admin acting
    # on a tenant's site writes that tenant's id rather than a blank.
    owner = (
        await db.execute(
            sa_text("SELECT tenant_id FROM site_facts WHERE site_id = CAST(:s AS uuid)"),
            {"s": str(body.site_id)},
        )
    ).scalar()
    if owner is None:
        # `rt.sites` is fed from site_facts, so passing the check above and
        # finding nothing here means the row went away mid-request.
        raise ValidationError("site is no longer in this store")
    # Validate against EVERY seeded version of the standard: a config outlives
    # version transitions (the zone is read by both feb-2009 and jan-2022;
    # `ac_category` only by the fixed-range 2009 tables — the 2022 rows key
    # their zones by SIZE category, which is derived from the area, not stored).
    std = q._rows(
        await db.execute(
            sa_text("SELECT bands FROM benchmark_standards WHERE key = :k"),
            {"k": body.standard_key},
        )
    )
    if not std:
        raise ValidationError(
            f"no benchmark standard `{body.standard_key}` is seeded — a config "
            f"cannot point at a standard that is not there"
        )
    zones: set[str] = set()
    cats: set[str] = set()
    for row in std:
        bands = row["bands"] or {}
        zdefs = bands.get("zones") or {}
        zones |= set(zdefs)
        if (bands.get("kind") or "fixed_ranges") == "fixed_ranges":
            for z in zdefs.values():
                cats |= {k for k in z if k != "label"}
    if body.climate_zone is not None and body.climate_zone not in zones:
        raise ValidationError(
            f"climate zone `{body.climate_zone}` is not in the standard's tables "
            f"({', '.join(sorted(zones))})"
        )
    if body.ac_category is not None and body.ac_category not in cats:
        raise ValidationError(
            f"AC category `{body.ac_category}` is not in the standard's tables "
            f"({', '.join(sorted(cats))})"
        )
    actor = str(getattr(who, "user_id", "") or "") or None
    await db.execute(
        sa_text(
            """
            INSERT INTO benchmark_site_config
                (site_id, tenant_id, standard_key, climate_zone, ac_category,
                 ac_share_percent, set_by, set_at)
            VALUES (CAST(:site AS uuid), CAST(:tenant AS uuid), :std, :zone,
                    :ac, :ac_share, :actor, now())
            ON CONFLICT (site_id) DO UPDATE
               SET standard_key = excluded.standard_key,
                   climate_zone = excluded.climate_zone,
                   ac_category = excluded.ac_category,
                   ac_share_percent = excluded.ac_share_percent,
                   set_by = excluded.set_by, set_at = excluded.set_at
            """
        ),
        {
            "site": str(body.site_id),
            "tenant": str(owner),
            "std": body.standard_key,
            "zone": body.climate_zone,
            "ac": body.ac_category,
            "ac_share": body.ac_share_percent,
            "actor": actor,
        },
    )
    await db.commit()
    return {
        "site_id": str(body.site_id),
        "standard_key": body.standard_key,
        "climate_zone": body.climate_zone,
        "ac_category": body.ac_category,
        "ac_share_percent": body.ac_share_percent,
        "set_by": actor,
    }


# ── The dashboard builder ────────────────────────────────────────────────────
#
# Three routes and no fourth: what datasets exist, what one of them contains, and
# run a widget's state against it. There is deliberately NO route that accepts
# SQL — see `spec.py` and the builder contract §3. The generator lives in
# `sqlgen.py` and runs here, on the server, or it does not run.


def _allowed(who: Principal, ds: registry.Dataset) -> bool:
    """Whether this caller may read this dataset. Each dataset declares its own
    permission (contract §2), so `bi.read` is the IoT dataset's key rather than a
    blanket gate over everything the builder can see."""
    return who.grants(ds.permission)


@bi_router.get("/datasets")
async def datasets(db: Db, who: Who) -> dict:
    """What this caller can chart.

    Read straight from the registry table, so a dataset a domain registered five
    minutes ago is here now — no release of this service, which is the whole point
    of the registry (contract §2). Datasets the caller may not read are omitted
    rather than shown-and-refused: an inventory of other people's data is itself
    information.
    """
    found = await registry.load(db)
    # Publish the permission keys to core's catalog so a role can grant them.
    # Best-effort and debounced; a chart never waits on it.
    await permsync.sync(list(found.values()))
    items = [ds.public() for ds in found.values() if _allowed(who, ds)]
    return {
        "total": len(items),
        "items": items,
        "spec_version": widget_spec.SPEC_VERSION,
        # Everything the editor needs to render its pickers without hard-coding a
        # list that can drift from what the server accepts.
        "aggregates": list(get_args(registry.BuilderAggregate)),
        "filter_ops": list(get_args(builder.FilterOp)),
        "max_series": builder.MAX_SERIES,
        "max_rows": builder.MAX_ROWS,
        "max_hours": builder.MAX_HOURS,
    }


@bi_router.get("/datasets/{key}")
async def dataset(key: str, db: Db, who: Who) -> dict:
    ds = await registry.get(db, key)
    if not _allowed(who, ds):
        raise ForbiddenError(f"missing permission(s): {ds.permission}")
    return ds.public()


@bi_router.get("/datasets/{key}/values")
async def dataset_values(
    key: str,
    db: Db,
    scope: Caller,
    who: Who,
    column: str,
    search: str | None = None,
    hours: Annotated[int, Query(ge=1, le=24 * 90)] = 24 * 7,
    limit: Annotated[int, Query(ge=1, le=200)] = 100,
) -> dict:
    """The distinct values of one DIMENSION, for a filter picker.

    Without this the builder would be a form full of free-text boxes: a person
    filtering on `category` has to know the gateway spells it `hvac`. It is the
    same generated-SQL path as everything else — `column` is a dimension KEY that
    must exist in the registry, never a column name that reaches SQL unchecked.
    """
    ds = await registry.get(db, key)
    if not _allowed(who, ds):
        raise ForbiddenError(f"missing permission(s): {ds.permission}")
    return await ex.distinct_values(
        db,
        _tenant(scope),
        ds,
        column=column,
        search=search,
        hours=hours,
        limit=limit,
    )


@bi_router.post("/query")
async def query(db: Db, scope: Caller, who: Who, body: dict) -> QueryResult:
    """Execute ONE widget's BUILDER STATE and return its data.

    This is the read path behind every widget that charts readings. It lives here
    for the same reason the rest of this router does: pipeline contract §7 gives
    the readings schema one owner, and the owner serves its own reads.

    (Until 2026-09-03 that sentence read "it lives here, not in the dashboards
    service … the dashboards service stores widget definitions and never opens
    this database". There is no dashboards service now — NeuBit's own builder was
    retired and DashForge is the authoring surface — but the argument is unchanged
    and is what still keeps a second reader off this database: whoever holds a
    widget's definition sends the SPEC here and does not query the store itself.)

    The body is a widget SPEC — a structured description of a dataset, some
    columns, an aggregate, a window and a resolution. **It is not SQL and there is
    no field in which SQL can arrive**: every model is `extra="forbid"`, so a body
    carrying `sql` or `where` is a 400 naming the field. The server generates the
    statement (`sqlgen.py`); the client never sees one except as a read-only echo
    on the result.

    Gating is per DATASET, not per router: each dataset declares the permission
    required to read it, and the tenant comes from the token claim and never from
    the request. A spec naming another tenant's rows returns nothing, because
    every generated statement carries the tenant bind.

    The body may also carry a DASHBOARD CONTEXT (`{spec, context}`) — the page's
    global filters, its variables and its shared window. That context is merged
    into the widget's builder STATE before validation, so everything the page
    contributes is checked by the same rules and BOUND by the same generator as
    everything the widget's author wrote. It is emphatically not substituted into
    a query string; `context.py` is the whole argument for why, and what to check.
    """
    spec, ctx = widget_spec.parse_request(body)
    ds = await registry.get(db, spec.query.dataset)
    if not _allowed(who, ds):
        raise ForbiddenError(f"missing permission(s): {ds.permission}")
    # BEFORE `validated`: a filter the page contributed must face the same
    # comparability and window rules as one the widget carries, and a page filter
    # that pins an incomparable measure to one series legitimately makes an
    # otherwise-refused widget answerable.
    notes = context.resolve(spec, ctx, ds)
    spec.query.validated(ds)
    result = await ex.run(db, _tenant(scope), ds, spec)
    result.context_notes = [n.model_dump() for n in notes]
    return result


@bi_router.get("/query/capabilities")
async def capabilities(db: Db, who: Who) -> dict:
    """What this build's spec supports — the builder reads it instead of guessing.

    A frontend that hard-codes the aggregate list drifts from the backend the
    moment one is added or removed. Serving it means the widget editor's options
    and the validator that rejects them can never disagree.
    """
    found = await registry.load(db)
    return {
        "spec_version": widget_spec.SPEC_VERSION,
        "shape": "table",
        "aggregates": list(get_args(registry.BuilderAggregate)),
        "filter_ops": list(get_args(builder.FilterOp)),
        "datasets": [
            {"key": ds.key, "name": ds.name} for ds in found.values() if _allowed(who, ds)
        ],
        # Chart types THIS BUILD's UI draws. The executor does not validate `viz`
        # at all (see spec.py), so this list is advisory: it tells the editor what
        # to offer, and adding to it never invalidates a stored dashboard.
        "viz": ["line", "bar", "stat", "table"],
        "max_series": builder.MAX_SERIES,
        "max_rows": builder.MAX_ROWS,
        "max_hours": builder.MAX_HOURS,
    }


@bi_router.get("/whoami", dependencies=[Depends(require_permission(PERM_READ))])
async def whoami(scope: Caller) -> dict:
    """What tenant this caller's queries are filtered by. For diagnosis only."""
    return {
        "tenant_id": str(scope.tenant_id) if scope.tenant_id else None,
        "is_platform": scope.is_platform,
    }


# The metric registry's routes (/bi/metrics/*) live in app/api/metrics.py and are
# mounted here so they inherit this router's gates. Mounted at the END of the module
# only for reading order — `include_router` copies routes at call time, so the
# position relative to this file's own decorators makes no difference.
bi_router.include_router(_metrics_router)
