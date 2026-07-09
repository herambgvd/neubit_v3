"""Linkage rule CRUD + the linkage engine (P5-B).

Two roles, mirroring the events domain's service split:

  * ``LinkageRuleService`` — tenant-scoped CRUD over ``linkage_rules`` (gated
    ``vms.config.manage`` at the router) + read of the ``linkage_fires`` audit. Every
    read/by-id goes through ``kernel.auth.scoped`` / ``assert_owned``; new rows are
    stamped with the caller's ``tenant_id``.

  * ``LinkageEngine`` — the match→scope→schedule→cooldown→execute path. The NATS consumer
    (``app.vms.linkage.consumer``) hands it a decoded envelope (a camera ``vms.>`` event
    OR an access ``access.>`` door event); the engine finds every enabled rule for the
    tenant + trigger type, filters by (trigger_filter + camera scope + schedule window +
    cooldown), resolves the target camera(s) (for a door event, via door→camera
    resolution), executes each rule's action list, and writes a ``LinkageFire`` audit row
    per fired rule. Runs OUTSIDE a request scope (a background writer): it trusts the
    tenant carried in the event envelope and uses its own DB session per event.

Cooldown is in-process (rule_id → last-fire monotonic ts), the same as gvd_nvr's
``LinkageEngine._last_fired`` — cheap + resets on restart (a restart re-arming a rule is
acceptable). The audit row is the durable record.

Graceful discipline: a bad rule / a down action never stalls the consumer — every action
failure is caught + recorded in the fire-audit; the engine returns the fired-rule count.
"""

from __future__ import annotations

import logging
import time
import uuid as _uuid
from datetime import datetime, time as dtime, timezone

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from kernel.auth import Scope, assert_owned, scoped

from app.vms.models import CameraGroup, LinkageFire, LinkageRule

from .actions import EXECUTORS, ActionContext
from .door_camera import resolve_cameras_for_door
from .schemas import (
    LinkageFireListResponse,
    LinkageFirePublic,
    LinkageRuleCreate,
    LinkageRuleListResponse,
    LinkageRulePublic,
    LinkageRuleUpdate,
)

log = logging.getLogger("vision.linkage")


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _coerce_tenant(tenant_id) -> _uuid.UUID | None:
    if not tenant_id:
        return None
    if isinstance(tenant_id, _uuid.UUID):
        return tenant_id
    try:
        return _uuid.UUID(str(tenant_id))
    except (ValueError, TypeError):
        return None


def _actor_id(actor) -> str | None:
    if actor is None:
        return None
    return str(getattr(actor, "user_id", "")) or None


# Severity ordering for ``min_severity`` filters.
_SEV_ORDER = {"info": 0, "warning": 1, "alarm": 2, "critical": 3}
# Cron-ish weekday keys for the schedule blob.
_WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]


# ═══════════════════════════════════════════════════════════════════════════════
# CRUD service (tenant-scoped, gated at the router)
# ═══════════════════════════════════════════════════════════════════════════════
class LinkageRuleService:
    """Tenant-scoped CRUD over ``linkage_rules`` + the ``linkage_fires`` audit read."""

    def __init__(self, db: AsyncSession, scope: Scope) -> None:
        self.db = db
        self.scope = scope

    async def create(self, body: LinkageRuleCreate, *, actor) -> LinkageRulePublic:
        row = LinkageRule(
            tenant_id=self.scope.tenant_id,
            name=body.name,
            description=body.description,
            is_active=body.is_active,
            trigger_event_type=body.trigger_event_type,
            trigger_filter=body.trigger_filter or {},
            camera_scope=body.camera_scope or {},
            actions=[a.model_dump() for a in body.actions],
            cooldown_seconds=body.cooldown_seconds,
            schedule=body.schedule or {},
            created_by=_actor_id(actor),
            updated_by=_actor_id(actor),
        )
        self.db.add(row)
        await self.db.commit()
        await self.db.refresh(row)
        return LinkageRulePublic.from_row(row)

    async def _owned(self, rule_id: str) -> LinkageRule:
        row = await self.db.get(LinkageRule, rule_id)
        assert_owned(row, self.scope, message="linkage rule not found")
        return row

    async def get(self, rule_id: str) -> LinkageRulePublic:
        return LinkageRulePublic.from_row(await self._owned(rule_id))

    async def list_(
        self,
        *,
        trigger_event_type: str | None = None,
        is_active: bool | None = None,
        skip: int = 0,
        limit: int = 50,
    ) -> LinkageRuleListResponse:
        stmt = scoped(select(LinkageRule), LinkageRule, self.scope)
        count_stmt = scoped(select(func.count(LinkageRule.id)), LinkageRule, self.scope)

        def _apply(q):
            if trigger_event_type is not None:
                q = q.where(LinkageRule.trigger_event_type == trigger_event_type)
            if is_active is not None:
                q = q.where(LinkageRule.is_active.is_(is_active))
            return q

        stmt, count_stmt = _apply(stmt), _apply(count_stmt)
        total = int((await self.db.execute(count_stmt)).scalar() or 0)
        rows = list(
            (
                await self.db.execute(
                    stmt.order_by(LinkageRule.created_at.desc()).offset(skip).limit(limit)
                )
            )
            .scalars()
            .all()
        )
        return LinkageRuleListResponse(
            items=[LinkageRulePublic.from_row(r) for r in rows],
            total=total,
            skip=skip,
            limit=limit,
        )

    async def update(
        self, rule_id: str, body: LinkageRuleUpdate, *, actor
    ) -> LinkageRulePublic:
        row = await self._owned(rule_id)
        data = body.model_dump(exclude_unset=True)
        if "actions" in data and body.actions is not None:
            data["actions"] = [a.model_dump() for a in body.actions]
        for field, value in data.items():
            setattr(row, field, value)
        row.updated_by = _actor_id(actor)
        row.updated_at = _utcnow()
        await self.db.commit()
        await self.db.refresh(row)
        return LinkageRulePublic.from_row(row)

    async def delete(self, rule_id: str) -> None:
        row = await self._owned(rule_id)
        await self.db.delete(row)
        await self.db.commit()

    async def list_fires(
        self,
        *,
        rule_id: str | None = None,
        camera_id: str | None = None,
        skip: int = 0,
        limit: int = 50,
    ) -> LinkageFireListResponse:
        stmt = scoped(select(LinkageFire), LinkageFire, self.scope)
        count_stmt = scoped(select(func.count(LinkageFire.id)), LinkageFire, self.scope)

        def _apply(q):
            if rule_id is not None:
                q = q.where(LinkageFire.rule_id == rule_id)
            if camera_id is not None:
                q = q.where(LinkageFire.camera_id == camera_id)
            return q

        stmt, count_stmt = _apply(stmt), _apply(count_stmt)
        total = int((await self.db.execute(count_stmt)).scalar() or 0)
        rows = list(
            (
                await self.db.execute(
                    stmt.order_by(LinkageFire.fired_at.desc()).offset(skip).limit(limit)
                )
            )
            .scalars()
            .all()
        )
        return LinkageFireListResponse(
            items=[LinkageFirePublic.from_row(r) for r in rows],
            total=total,
            skip=skip,
            limit=limit,
        )


# ═══════════════════════════════════════════════════════════════════════════════
# Engine (background — driven by the NATS consumer)
# ═══════════════════════════════════════════════════════════════════════════════
class LinkageEngine:
    """Match an event to enabled rules → scope → schedule → cooldown → execute → audit."""

    def __init__(self, sessionmaker: async_sessionmaker[AsyncSession]) -> None:
        self._sessionmaker = sessionmaker
        # rule_id → last-fire monotonic ts (in-process cooldown; resets on restart).
        self._last_fired: dict[str, float] = {}

    # ── entry points the consumer calls ─────────────────────────────────────
    async def handle_camera_event(self, env: dict) -> int:
        """A ``tenant.<id>.vms.camera.<type>`` event → fire matching rules.

        Returns the number of rules that fired (for tests/logging). Never raises.
        """
        payload = env.get("payload") or {}
        tenant_id = env.get("tenant_id")
        event_type = payload.get("event_type")
        camera_id = payload.get("camera_id")
        if not event_type or not camera_id:
            return 0
        return await self._dispatch(
            tenant_id=tenant_id,
            trigger_event_type=event_type,
            payload=payload,
            camera_id=camera_id,
            door_ref=None,
            source_event_id=payload.get("event_id"),
        )

    async def handle_access_event(self, env: dict) -> int:
        """A ``tenant.<id>.access.<category>.<type>`` event → access↔video verification.

        The trigger type is mapped to ``access_<category>_<type>`` (e.g. a door
        forced/held event → ``access_door_forced`` / ``access_door_held``) so a linkage
        rule can target it. The target camera(s) are resolved from the door (explicit map
        or placement proximity), NOT from the rule's camera scope. Returns the fired-rule
        count. Never raises.
        """
        payload = env.get("payload") or {}
        tenant_id = env.get("tenant_id")
        # The envelope ``type`` is ``access.<category>.<type>``; derive the trigger key.
        etype = env.get("type") or ""
        parts = etype.split(".")
        if len(parts) >= 3 and parts[0] == "access":
            trigger = f"access_{parts[1]}_{parts[2]}"
        else:
            category = payload.get("category") or "door"
            evt = payload.get("type") or "event"
            trigger = f"access_{category}_{evt}"
        door_ref = payload.get("door_ref")
        return await self._dispatch(
            tenant_id=tenant_id,
            trigger_event_type=trigger,
            payload=payload,
            camera_id=None,  # resolved from the door
            door_ref=door_ref,
            source_event_id=payload.get("event_id"),
        )

    # ── core dispatch ────────────────────────────────────────────────────────
    async def _dispatch(
        self,
        *,
        tenant_id,
        trigger_event_type: str,
        payload: dict,
        camera_id: str | None,
        door_ref: str | None,
        source_event_id: str | None,
    ) -> int:
        tid = _coerce_tenant(tenant_id)
        try:
            rules = await self._matching_rules(tid, trigger_event_type)
        except Exception as exc:  # noqa: BLE001 — a bad load must not kill the consumer
            log.warning("linkage rule load failed (%s): %s", trigger_event_type, exc)
            return 0

        fired = 0
        now = _utcnow()
        for rule in rules:
            try:
                if not self._filter_matches(rule, payload):
                    continue
                if not self._schedule_open(rule, now):
                    continue

                # Resolve target camera(s) BEFORE the cooldown check so a scope-gated-out
                # camera event doesn't consume the cooldown slot.
                if door_ref is not None:
                    # A door event: resolve the camera(s) at the door. An empty result
                    # still fires camera-less actions (notify), so it does NOT gate.
                    cams, strategy = await resolve_cameras_for_door(
                        str(tid) if tid else None, door_ref, rule.trigger_filter or {}
                    )
                else:
                    # A camera event: the scope is a GATE — an empty result means the
                    # event camera isn't in scope, so the rule does not fire at all.
                    cams = await self._scope_cameras(rule, camera_id)
                    strategy = "scope"
                    if not cams:
                        continue

                if not self._cooldown_ok(rule):
                    log.debug("linkage rule %s skipped (cooldown)", rule.id)
                    continue

                await self._fire_rule(
                    rule=rule,
                    tid=tid,
                    payload=payload,
                    camera_ids=cams,
                    door_ref=door_ref,
                    source_event_id=source_event_id,
                    resolution=strategy,
                )
                fired += 1
            except Exception as exc:  # noqa: BLE001 — one bad rule never stalls the rest
                log.warning("linkage rule %s errored: %s", getattr(rule, "id", "?"), exc)
        return fired

    async def _matching_rules(self, tid, trigger_event_type: str) -> list[LinkageRule]:
        """Active rules for this tenant + trigger type (own session)."""
        async with self._sessionmaker() as db:
            stmt = select(LinkageRule).where(
                LinkageRule.is_active.is_(True),
                LinkageRule.trigger_event_type == trigger_event_type,
            )
            # Tenant match: a rule's tenant must equal the event's tenant. A NULL-tenant
            # (platform) rule matches any event (rare — platform-wide policy).
            if tid is not None:
                stmt = stmt.where(
                    (LinkageRule.tenant_id == tid) | (LinkageRule.tenant_id.is_(None))
                )
            else:
                stmt = stmt.where(LinkageRule.tenant_id.is_(None))
            return list((await db.execute(stmt)).scalars().all())

    # ── match predicates ──────────────────────────────────────────────────────
    def _filter_matches(self, rule: LinkageRule, payload: dict) -> bool:
        """Apply the rule's ``trigger_filter`` against the event payload.

        Supported keys: exact ``severity``; ``min_severity`` (>=); ``zone`` (exact);
        ``result`` (access event result, e.g. "denied"); plus any other key is an exact
        equality against the payload (or the payload's ``raw``). Reserved keys
        (``door_camera_map``) are ignored here (they drive resolution, not matching).
        """
        flt = rule.trigger_filter or {}
        raw = payload.get("raw") or {}
        for key, want in flt.items():
            if key == "door_camera_map":
                continue
            if key == "min_severity":
                have = _SEV_ORDER.get(str(payload.get("severity", "info")), 0)
                if have < _SEV_ORDER.get(str(want), 0):
                    return False
                continue
            got = payload.get(key)
            if got is None:
                got = raw.get(key)
            if str(got) != str(want):
                return False
        return True

    def _schedule_open(self, rule: LinkageRule, now: datetime) -> bool:
        """Is ``now`` inside a rule's weekly active window? Empty schedule = always on.

        ``schedule`` = ``{"mon": [["08:00","18:00"], ...], ...}`` (UTC HH:MM windows).
        A weekday key present but empty = closed that day; an absent key = closed too
        (so a non-empty schedule is an allow-list). An entirely empty schedule = always.
        """
        sched = rule.schedule or {}
        if not sched:
            return True
        day = _WEEKDAYS[now.weekday()]
        windows = sched.get(day)
        if not windows:
            return False
        t = now.timetz().replace(tzinfo=None) if now.tzinfo else now.time()
        for win in windows:
            try:
                start = _parse_hhmm(win[0])
                end = _parse_hhmm(win[1])
            except (IndexError, ValueError, TypeError):
                continue
            if start <= t <= end:
                return True
        return False

    def _cooldown_ok(self, rule: LinkageRule) -> bool:
        """True if the rule is NOT within its cooldown window; marks the fire time."""
        cd = rule.cooldown_seconds or 0
        now = time.monotonic()
        if cd > 0:
            last = self._last_fired.get(rule.id, 0.0)
            if (now - last) < cd:
                return False
        self._last_fired[rule.id] = now
        return True

    async def _scope_cameras(
        self, rule: LinkageRule, event_camera_id: str | None
    ) -> list[str]:
        """Resolve the cameras a camera-event rule targets.

        ``camera_scope``:
          * ``{"all": true}`` / empty → the event's own camera.
          * ``{"camera_ids": [...]}`` → the event camera IF it's in the list (else no
            match — the rule only acts on cameras it's scoped to). If the event camera is
            in scope, the action targets that camera.
          * ``{"group_ids": [...]}`` → the event camera IF it belongs to one of the
            groups.
        A camera-event rule always acts on the EVENT's camera (not a fan-out) — the scope
        is a gate, not a target list. Returns ``[event_camera_id]`` or ``[]``.
        """
        scope = rule.camera_scope or {}
        if not event_camera_id:
            return []
        if not scope or scope.get("all"):
            return [event_camera_id]
        cam_ids = scope.get("camera_ids")
        if isinstance(cam_ids, list) and cam_ids:
            return [event_camera_id] if event_camera_id in cam_ids else []
        group_ids = scope.get("group_ids")
        if isinstance(group_ids, list) and group_ids:
            if await self._camera_in_groups(event_camera_id, group_ids):
                return [event_camera_id]
            return []
        # Unknown scope shape → default to the event camera (fail-open on the target).
        return [event_camera_id]

    async def _camera_in_groups(self, camera_id: str, group_ids: list[str]) -> bool:
        """True if the camera is a member of any of the given groups.

        Membership is the ``CameraGroup.camera_ids`` JSON list (flat, like access
        door_ids) — no association table. Best-effort; a missing group is skipped.
        """
        async with self._sessionmaker() as db:
            groups = (
                await db.execute(
                    select(CameraGroup.camera_ids).where(CameraGroup.id.in_(group_ids))
                )
            ).scalars().all()
        for members in groups:
            if isinstance(members, list) and camera_id in members:
                return True
        return False

    # ── execute + audit ────────────────────────────────────────────────────────
    async def _fire_rule(
        self,
        *,
        rule: LinkageRule,
        tid,
        payload: dict,
        camera_ids: list[str],
        door_ref: str | None,
        source_event_id: str | None,
        resolution: str,
    ) -> None:
        """Execute a rule's action list against the resolved camera(s) + write the audit."""
        event_type = payload.get("event_type") or payload.get("type") or rule.trigger_event_type
        severity = payload.get("severity") or "info"
        title = payload.get("title") or event_type
        reason = self._reason(rule, payload, door_ref)

        # A rule with camera actions but no resolved camera still runs camera-less
        # actions (notify). Use a single representative camera for camera-bound actions;
        # if several resolved, run camera-bound actions per camera.
        results: list[dict] = []
        first_recording_id: str | None = None

        target_cams = camera_ids or [None]  # at least one pass (camera-less actions)
        # De-dupe camera-less passes: if there is no camera, only run non-camera actions
        # once; if there are cameras, run camera actions per camera + camera-less once.
        ran_cameraless = False

        for cam in target_cams:
            ctx = ActionContext(
                tenant_id=str(tid) if tid else None,
                camera_id=cam,
                event_id=source_event_id,
                event_type=str(event_type),
                severity=str(severity),
                title=str(title),
                sessionmaker=self._sessionmaker,
                reason=reason,
            )
            for action in rule.actions or []:
                if not isinstance(action, dict):
                    continue
                atype = action.get("type")
                cfg = action.get("config") or {}
                executor = EXECUTORS.get(atype)
                if executor is None:
                    results.append({"type": atype, "ok": False, "detail": "unknown action"})
                    continue
                camera_bound = atype in {"start_recording", "ptz_preset", "trigger_output", "popup"}
                if not camera_bound and ran_cameraless:
                    continue  # notify runs once, not per camera
                try:
                    res = await executor(ctx, cfg)
                except Exception as exc:  # noqa: BLE001 — an action never crashes the fire
                    log.warning("linkage action %s crashed: %s", atype, exc)
                    results.append({"type": atype, "ok": False, "detail": f"crashed: {exc}"})
                    continue
                d = res.as_dict()
                if cam:
                    d["camera_id"] = cam
                results.append(d)
                if res.recording_id and not first_recording_id:
                    first_recording_id = res.recording_id
            ran_cameraless = True

        await self._audit(
            rule=rule,
            tid=tid,
            camera_id=camera_ids[0] if camera_ids else None,
            door_ref=door_ref,
            source_event_id=source_event_id,
            results=results,
            recording_id=first_recording_id,
        )
        log.info(
            "linkage rule '%s' fired (trigger=%s cams=%s resolution=%s actions=%d)",
            rule.name, rule.trigger_event_type, camera_ids or "-", resolution, len(results),
        )

    def _reason(self, rule: LinkageRule, payload: dict, door_ref: str | None) -> str:
        if door_ref:
            return f"{rule.trigger_event_type} at door {door_ref}"
        cam = payload.get("camera_id")
        return f"{payload.get('event_type') or rule.trigger_event_type}" + (f" on camera {cam}" if cam else "")

    async def _audit(
        self,
        *,
        rule: LinkageRule,
        tid,
        camera_id: str | None,
        door_ref: str | None,
        source_event_id: str | None,
        results: list[dict],
        recording_id: str | None,
    ) -> None:
        try:
            async with self._sessionmaker() as db:
                db.add(
                    LinkageFire(
                        tenant_id=tid,
                        rule_id=rule.id,
                        rule_name=rule.name,
                        trigger_event_type=rule.trigger_event_type,
                        source_event_id=source_event_id,
                        camera_id=camera_id,
                        door_ref=door_ref,
                        actions_result=results,
                        recording_id=recording_id,
                    )
                )
                await db.commit()
        except Exception as exc:  # noqa: BLE001 — the audit write is best-effort
            log.warning("linkage fire audit write failed for rule %s: %s", rule.id, exc)


def _parse_hhmm(value: str) -> dtime:
    """``"HH:MM"`` → a naive ``time`` (UTC). Raises ValueError on a bad token."""
    h, m = value.split(":")
    return dtime(int(h), int(m))
