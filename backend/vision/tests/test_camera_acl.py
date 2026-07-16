"""Per-camera ACL enforcement tests (``enforce_camera_privilege``) — no network.

Exercises the RESTRICTIVE per-camera ACL resolver directly against an in-memory
SQLite DB (mirrors the P3 service-test discipline: ``Base.metadata.create_all``,
``pytest-asyncio`` auto mode). Covers the full 4-step semantics:

  * no ACL rows → ALLOW (backward-compatible fallback).
  * user-subject grant WITH the privilege → ALLOW; WITHOUT it → DENY.
  * role-subject grant (the caller's role) → ALLOW.
  * a grant for a DIFFERENT subject only → DENY.
  * group-TARGET grant (camera is a member of a granted camera-group) → ALLOW.
  * super-admin scope → ALLOW regardless of rows.
  * tenant isolation: another tenant's rows are invisible → fallback ALLOW.
  * subject-side ``group`` grant → no-op (never matches) → DENY.
"""

from __future__ import annotations

import uuid

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from kernel.auth import Principal, Scope
from kernel.errors import ForbiddenError

from app.db import Base
from app.vms.groups.acl import enforce_camera_privilege
from app.vms.models import CameraACL, CameraGroup

TENANT = uuid.uuid4()
OTHER_TENANT = uuid.uuid4()

CAMERA_ID = "cam-001"
ROLE_ID = str(uuid.uuid4())


@pytest_asyncio.fixture
async def db():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    Session = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with Session() as s:
        yield s
    await engine.dispose()


def _principal(*, role_id: str | None = ROLE_ID, tenant=TENANT) -> Principal:
    """A tenant caller with a fixed user id + (optional) role id."""
    return Principal(
        user_id=uuid.uuid4(),
        tenant_id=tenant,
        is_superadmin=False,
        permissions=["*"],
        role_id=role_id,
    )


def _tenant_scope(tenant=TENANT) -> Scope:
    return Scope(tenant_id=tenant, is_superadmin=False)


def _platform_scope() -> Scope:
    return Scope(tenant_id=None, is_superadmin=True)


async def _add_acl(
    db, *, subject_type, subject_id, target_type, target_id, privileges, tenant=TENANT
):
    row = CameraACL(
        tenant_id=tenant,
        subject_type=subject_type,
        subject_id=subject_id,
        target_type=target_type,
        target_id=target_id,
        privileges=list(privileges),
    )
    db.add(row)
    await db.commit()
    return row


async def _add_group(db, *, name, camera_ids, tenant=TENANT):
    row = CameraGroup(tenant_id=tenant, name=name, camera_ids=list(camera_ids))
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row


# ── 1. no ACL rows → allowed (fallback) ──────────────────────────────────
async def test_no_acl_rows_allows(db):
    principal = _principal()
    # Should not raise.
    await enforce_camera_privilege(
        db, scope=_tenant_scope(), principal=principal, camera_id=CAMERA_ID, privilege="view_live"
    )


# ── 2. user-subject grant with / without the privilege ───────────────────
async def test_user_grant_with_privilege_allows(db):
    principal = _principal()
    await _add_acl(
        db,
        subject_type="user",
        subject_id=str(principal.user_id),
        target_type="camera",
        target_id=CAMERA_ID,
        privileges=["view_live", "playback"],
    )
    await enforce_camera_privilege(
        db, scope=_tenant_scope(), principal=principal, camera_id=CAMERA_ID, privilege="view_live"
    )


async def test_user_grant_without_privilege_denies(db):
    principal = _principal()
    await _add_acl(
        db,
        subject_type="user",
        subject_id=str(principal.user_id),
        target_type="camera",
        target_id=CAMERA_ID,
        privileges=["view_live"],  # no 'export'
    )
    with pytest.raises(ForbiddenError):
        await enforce_camera_privilege(
            db, scope=_tenant_scope(), principal=principal, camera_id=CAMERA_ID, privilege="export"
        )


# ── 3. role-subject grant (caller's role) → allowed ──────────────────────
async def test_role_grant_allows(db):
    principal = _principal(role_id=ROLE_ID)
    await _add_acl(
        db,
        subject_type="role",
        subject_id=ROLE_ID,
        target_type="camera",
        target_id=CAMERA_ID,
        privileges=["ptz"],
    )
    await enforce_camera_privilege(
        db, scope=_tenant_scope(), principal=principal, camera_id=CAMERA_ID, privilege="ptz"
    )


# ── 4. grant for a DIFFERENT subject only → denied ───────────────────────
async def test_other_subject_only_denies(db):
    principal = _principal()
    await _add_acl(
        db,
        subject_type="user",
        subject_id=str(uuid.uuid4()),  # someone else
        target_type="camera",
        target_id=CAMERA_ID,
        privileges=["view_live"],
    )
    with pytest.raises(ForbiddenError):
        await enforce_camera_privilege(
            db, scope=_tenant_scope(), principal=principal, camera_id=CAMERA_ID, privilege="view_live"
        )


# ── 5. group-TARGET grant (camera in a granted group) → allowed ──────────
async def test_group_target_grant_allows(db):
    principal = _principal()
    group = await _add_group(db, name="Lobby", camera_ids=[CAMERA_ID, "cam-002"])
    await _add_acl(
        db,
        subject_type="user",
        subject_id=str(principal.user_id),
        target_type="group",
        target_id=group.id,
        privileges=["playback"],
    )
    await enforce_camera_privilege(
        db, scope=_tenant_scope(), principal=principal, camera_id=CAMERA_ID, privilege="playback"
    )


async def test_group_target_grant_wrong_privilege_denies(db):
    principal = _principal()
    group = await _add_group(db, name="Lobby", camera_ids=[CAMERA_ID])
    await _add_acl(
        db,
        subject_type="user",
        subject_id=str(principal.user_id),
        target_type="group",
        target_id=group.id,
        privileges=["playback"],  # no 'export'
    )
    with pytest.raises(ForbiddenError):
        await enforce_camera_privilege(
            db, scope=_tenant_scope(), principal=principal, camera_id=CAMERA_ID, privilege="export"
        )


# ── 6. super-admin scope → allowed regardless of rows ────────────────────
async def test_superadmin_bypasses(db):
    principal = _principal()
    # A restrictive row that would DENY a normal caller.
    await _add_acl(
        db,
        subject_type="user",
        subject_id=str(uuid.uuid4()),
        target_type="camera",
        target_id=CAMERA_ID,
        privileges=["view_live"],
    )
    # Super-admin (platform scope) bypasses.
    await enforce_camera_privilege(
        db, scope=_platform_scope(), principal=principal, camera_id=CAMERA_ID, privilege="view_live"
    )


# ── 7. tenant isolation: another tenant's rows are invisible → fallback ───
async def test_cross_tenant_rows_invisible(db):
    principal = _principal(tenant=TENANT)
    # A grant owned by ANOTHER tenant for this camera id.
    await _add_acl(
        db,
        subject_type="user",
        subject_id=str(principal.user_id),
        target_type="camera",
        target_id=CAMERA_ID,
        privileges=["view_live"],
        tenant=OTHER_TENANT,
    )
    # From TENANT's scope, no rows are visible → fallback ALLOW (row belongs to OTHER_TENANT).
    await enforce_camera_privilege(
        db, scope=_tenant_scope(TENANT), principal=principal, camera_id=CAMERA_ID, privilege="view_live"
    )


# ── 8. subject-side 'group' grant is a documented no-op → denied ─────────
async def test_subject_group_grant_is_noop(db):
    principal = _principal()
    # A grant whose subject is a core group — the caller never carries a "group:<id>"
    # subject, so this matches no one and is ignored. Because a row DOES target the
    # camera, the fallback no longer applies → DENY.
    await _add_acl(
        db,
        subject_type="group",
        subject_id=str(uuid.uuid4()),
        target_type="camera",
        target_id=CAMERA_ID,
        privileges=["view_live"],
    )
    with pytest.raises(ForbiddenError):
        await enforce_camera_privilege(
            db, scope=_tenant_scope(), principal=principal, camera_id=CAMERA_ID, privilege="view_live"
        )
