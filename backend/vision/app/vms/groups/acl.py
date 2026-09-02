"""Per-camera ACL enforcement — the request-time gate over ``camera_acl``.

The coarse RBAC lives in core (a role's ``vms.*`` permission, enforced by
``kernel.auth.require_permission`` on each endpoint). This module adds the
FINE-grained, per-camera/per-privilege layer the VMS owns.

Semantics (RESTRICTIVE, never additive):
  * The ACL can only ever DENY a caller who already passed the coarse role gate;
    it NEVER grants a privilege the caller's role lacks. (The role check happens
    first, in the endpoint's ``require_permission`` dependency.)
  * A camera with NO ACL rows at all is OPEN to anyone who passed the role gate —
    this is the backward-compatible default (no camera has ACLs today, so nothing
    breaks). The ACL only starts biting a camera once at least one row targets it.

Resolution for ``(camera_id, privilege, caller)``:
  1. Super-admin (``scope.is_platform``) → ALLOW (bypass; sees every tenant).
  2. Gather the tenant-scoped ACL rows relevant to this camera:
       * every ``target_type='camera' AND target_id=camera_id`` row, PLUS
       * every ``target_type='group' AND target_id IN (camera's group ids)`` row,
         where the camera's groups are the ``camera_groups`` whose ``camera_ids``
         JSON membership list contains ``camera_id`` (tenant-scoped).
  3. If NO such rows exist → "no ACL configured" → ALLOW (the fallback above).
  4. If rows exist → ALLOW iff ANY row matches the caller AND grants the privilege:
       ``row.subject_type + ":" + row.subject_id in caller.subjects()``
       AND ``privilege in row.privileges``.
     Otherwise → DENY (raise ``ForbiddenError``).

Subject-side ``group`` grants are a documented NO-OP for now: core has no
user-group membership model, so ``Principal.subjects()`` never carries a
``group:<id>`` subject — a ``subject_type='group'`` row therefore matches no one
and is silently ignored on the subject side. (The TARGET side ``group`` resolution
in step 2 IS implemented — those are camera-groups, which exist.)

Every query is tenant-scoped via ``kernel.auth.scoped`` so ACL/group resolution
can never leak across tenants.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from kernel.auth import Scope, scoped
from kernel.errors import ForbiddenError

from app.vms.models import CameraACL, CameraGroup

if TYPE_CHECKING:  # avoid a hard import cycle; Principal is only type-referenced
    from kernel.auth import Principal


# The privileges an ACL row may grant (kept here for reference / validation callers).
PRIVILEGES = ("view_live", "playback", "export", "ptz", "config")


async def _camera_group_ids(
    db: AsyncSession, *, scope: Scope, camera_id: str
) -> list[str]:
    """Tenant-scoped: the ids of every camera-group whose membership includes camera_id.

    JSON-list membership isn't portably filterable in SQL (SQLite/PG differ), so we
    fetch the tenant's groups and test membership in Python — mirroring the group
    service's own ``_detach_from_patterns`` sweep discipline.
    """
    stmt = scoped(select(CameraGroup), CameraGroup, scope)
    groups = (await db.execute(stmt)).scalars().all()
    return [g.id for g in groups if camera_id in (g.camera_ids or [])]


async def enforce_camera_privilege(
    db: AsyncSession,
    *,
    scope: Scope,
    principal: "Principal",
    camera_id: str,
    privilege: str,
) -> None:
    """Enforce the per-camera ACL for ``privilege`` on ``camera_id`` — RESTRICTIVE.

    Returns ``None`` when the caller is ALLOWED; raises ``ForbiddenError`` when DENIED.
    Implements the 4-step resolver documented in this module (super-admin bypass,
    tenant-scoped camera + camera-group targeted rows, no-ACL fallback, subject/
    privilege match). See the module docstring for the full semantics.

    This is called AFTER the endpoint's coarse ``require_permission`` dependency has
    already passed — it can only narrow that grant, never widen it.
    """
    # 1. Super-admin bypasses the fine-grained ACL entirely.
    if scope.is_platform:
        return

    # 2. Gather the tenant-scoped ACL rows relevant to this camera: the camera-targeted
    #    rows PLUS the rows targeting any camera-group the camera belongs to.
    group_ids = await _camera_group_ids(db, scope=scope, camera_id=camera_id)

    conditions = (CameraACL.target_type == "camera") & (CameraACL.target_id == camera_id)
    if group_ids:
        conditions = conditions | (
            (CameraACL.target_type == "group") & (CameraACL.target_id.in_(group_ids))
        )
    stmt = scoped(select(CameraACL), CameraACL, scope).where(conditions)
    rows = (await db.execute(stmt)).scalars().all()

    # 3. No ACL rows target this camera → open to anyone past the role gate (default).
    if not rows:
        return

    # 4. Rows exist → the ACL now governs this camera. Allow iff SOME row both matches
    #    the caller (subject) AND grants the requested privilege. Group-SUBJECT rows are
    #    a no-op (a caller never carries a "group:<id>" subject — see module docstring).
    caller_subjects = set(principal.subjects())
    for row in rows:
        subject_key = f"{row.subject_type}:{row.subject_id}"
        if subject_key in caller_subjects and privilege in (row.privileges or []):
            return

    raise ForbiddenError(
        f"no per-camera '{privilege}' grant for this camera",
        details={"camera_id": camera_id, "privilege": privilege},
    )
