"""Administering OTHER people's accounts.

Every route here takes a user id, which is what makes it the highest-risk surface in
core: each one needs an explicit ownership check, and each one is a place to forget
it. `scope.owns()` treating a NULL tenant_id as "owned by everyone" turned exactly
these routes into a tenant-to-platform privilege escalation — a tenant admin could
fetch the super-admin by id and reset its password.

`tests/test_tenant_isolation.py` points a tenant-admin at the super-admin row on
every verb in this file.
"""

from __future__ import annotations

import csv
import io
import secrets
import uuid

from fastapi import Depends, File, UploadFile
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ...core.audit import record as audit_record
from ...core.errors import UnauthorizedError, ValidationError
from ...core.logging import get_logger
from ...core.pagination import Page, PageParams, page_params, paginate
from ...db.base import get_db
from ...tenancy.scope import scope_of, scoped
from ..deps import require_permission
from ..models import User
from ..permissions import CorePerm
from ..schemas import CloneUserIn, ConfirmPasswordIn, CreateUserIn, UpdateUserIn, UserOut
from ...core.uploads import read_capped
from ..service import AuthService
from ._shared import _user_out
from . import admin_router

#: Cap on a user-import CSV. Generous — a real bulk import of tens of thousands of
#: rows is a few megabytes — and finite, which is the whole point.
MAX_IMPORT_BYTES = 16 * 1024 * 1024


# --- users -------------------------------------------------------------------
@admin_router.post("/users", response_model=UserOut, status_code=201)
async def create_user(
    data: CreateUserIn,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_permission(CorePerm.USER_MANAGE)),
) -> UserOut:
    # A name is mandatory when an admin creates an account by hand: the audit trail
    # and every user list read as a person, not an address. (CSV import deliberately
    # still accepts a blank name column — see import_users.)
    if not (data.full_name or "").strip():
        raise ValidationError("Full name is required.")
    # Scope forces a tenant-admin's new users into their own tenant and blocks
    # setting is_superadmin / a cross-tenant tenant_id (see AuthService.create_user).
    user = await AuthService(db).create_user(data, scope_of(actor))
    await audit_record(
        db, actor=actor, action="user.create", target_type="user",
        target_id=str(user.id), meta={"email": user.email},
    )
    if data.send_invite:
        await _send_invite_email(db, user)
    return await _user_out(user)


async def _send_invite_email(db: AsyncSession, user: User) -> None:
    """Email the new user a welcome + secure 'set your password' activation link.
    Reuses the password-reset token, so clicking it both verifies their inbox and
    lets them choose a password. Best-effort: a mail failure won't fail user creation.
    """
    from ...branding import service as branding_service
    from ...core.config import get_settings
    from ...messaging import templates as email_templates
    from ...messaging.email import send_email

    try:
        res = await AuthService(db).request_password_reset(user.email)
        if res is None:
            return
        _, raw = res
        settings = get_settings()
        activate_url = f"{settings.frontend_url.rstrip('/')}/forgot-password?token={raw}"
        # Brand the invite with the new user's tenant (falls back to the platform
        # default), and pull the welcome template override from the same tenant.
        branding = await branding_service.resolve(db, user.tenant_id)
        ctx = {
            "name": user.full_name or user.email,
            "app_name": branding.app_name,
            "activate_url": activate_url,
        }
        subject, body = await email_templates.render_with_overrides(
            db, "welcome", ctx, tenant_id=user.tenant_id
        )
        html = email_templates.wrap_email(branding.app_name, body)
        await send_email(db, [user.email], subject, html, user.tenant_id)
    except Exception:  # pragma: no cover - invites are best-effort
        get_logger("auth").warning("invite email failed for %s", user.email, exc_info=True)


@admin_router.get("/users", response_model=Page[UserOut])
async def list_users(
    params: PageParams = Depends(page_params),
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_permission(CorePerm.USER_READ)),
) -> Page[UserOut]:
    # Tenant scoping lives in scope.py, not here. Super-admins see everyone; every
    # other caller is filtered to their own tenant_id, NULL being a tenancy like any
    # other. This used to flatten the Scope to a bare tenant_id, which made a
    # non-superadmin platform user (tenant_id NULL) indistinguishable from a
    # super-admin and handed them the whole directory.
    svc = AuthService(db)
    page = await paginate(db, svc.users_query(scope_of(actor)), params)
    counts = await svc.active_session_counts([u.id for u in page.items])
    page.items = [await _user_out(u, counts.get(u.id, 0)) for u in page.items]
    return page


@admin_router.get("/users/export")
async def export_users(
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_permission(CorePerm.USER_READ)),
) -> StreamingResponse:
    """Download all users as a CSV (email, name, role, status, verified, last login).

    Tenant-scoped through the same helper the listing uses, so the two cannot drift.
    The hand-rolled filter this replaces read ``if not actor.is_superadmin and
    actor.tenant_id is not None`` — a caller who was neither (a platform user with
    ``user.read`` and no tenant) matched no branch, so no filter was applied and the
    CSV held every user on the platform.
    """
    stmt = scoped(select(User).order_by(User.created_at.desc()), User, scope_of(actor))
    rows = (await db.execute(stmt)).scalars().all()
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["email", "full_name", "role", "is_active", "email_verified", "last_login_at"])
    for u in rows:
        writer.writerow(
            [
                u.email,
                u.full_name or "",
                u.role.name if u.role else "",
                u.is_active,
                u.email_verified,
                u.last_login_at.isoformat() if u.last_login_at else "",
            ]
        )
    buf.seek(0)
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=users.csv"},
    )


def _truthy(value: str) -> bool:
    return str(value).strip().lower() in {"1", "true", "yes", "y", "on"}


@admin_router.post("/users/import")
async def import_users(
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_permission(CorePerm.USER_MANAGE)),
) -> dict:
    """Bulk-create users from a CSV.

    Columns: ``email`` (required), ``full_name``, ``role`` (role name; falls back to
    the caller's role), ``send_invite`` (default true). When no password column is
    given, a random one is set and the user is invited to choose their own.
    """
    # Capped, and it had NO cap at all before — `await file.read()` on an unbounded
    # upload, then `.decode()` on the result, so a single request could allocate the
    # body twice over. `user.manage` is a privileged permission, but "the caller is
    # an admin" is not a reason to let one request decide how much memory the
    # process uses.
    raw = (await read_capped(file, MAX_IMPORT_BYTES, field="CSV")).decode(
        "utf-8-sig", errors="replace"
    )
    reader = csv.DictReader(io.StringIO(raw))
    scope = scope_of(actor)
    # Only offer roles the acting admin can actually assign (own-tenant + shared
    # system roles for a tenant-admin; all roles for a super-admin).
    roles = (await db.execute(AuthService(db).roles_query(scope))).scalars().all()
    role_by_name = {r.name.lower(): r for r in roles}

    created, skipped, errors = 0, 0, []
    svc = AuthService(db)
    for i, row in enumerate(reader, start=2):  # row 1 is the header
        email = (row.get("email") or "").strip()
        if not email:
            continue
        role_name = (row.get("role") or "").strip().lower()
        role = role_by_name.get(role_name) or actor.role
        send_invite = _truthy(row.get("send_invite", "true"))
        password = (row.get("password") or "").strip() or (secrets.token_urlsafe(10) + "aA1")
        try:
            # scope stamps each imported user with the acting admin's tenant.
            user = await svc.create_user(
                CreateUserIn(
                    email=email,
                    password=password,
                    full_name=(row.get("full_name") or "").strip() or None,
                    role_id=role.id,
                    send_invite=send_invite,
                ),
                scope,
            )
            if send_invite:
                await _send_invite_email(db, user)
            created += 1
        except Exception as exc:  # duplicate email, bad data, …
            skipped += 1
            errors.append({"row": i, "email": email, "error": str(exc)})

    await audit_record(
        db, actor=actor, action="user.import", target_type="user", target_id="bulk",
        meta={"created": created, "skipped": skipped},
    )
    return {"created": created, "skipped": skipped, "errors": errors[:20]}


@admin_router.get("/users/{user_id}", response_model=UserOut)
async def get_user(
    user_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_permission(CorePerm.USER_READ)),
) -> UserOut:
    """Fetch one user. A tenant-admin only sees users in their own tenant (404
    otherwise); super-admins see any user."""
    svc = AuthService(db)
    user = await svc.get_user(user_id, scope_of(actor))
    counts = await svc.active_session_counts([user.id])
    return await _user_out(user, counts.get(user.id, 0))


@admin_router.patch("/users/{user_id}", response_model=UserOut)
async def update_user(
    user_id: uuid.UUID,
    data: UpdateUserIn,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_permission(CorePerm.USER_MANAGE)),
) -> UserOut:
    user = await AuthService(db).update_user(user_id, data, scope_of(actor))
    # Record WHAT changed, never the secret itself — an audit trail holding plaintext
    # passwords would be a breach in its own right. mode="json" keeps the UUIDs/emails
    # storable in the JSON meta column.
    changed = data.model_dump(exclude_none=True, mode="json")
    if changed.pop("password", None):  # truthy, like the service's "blank = unchanged"
        changed["password_changed"] = True
    await audit_record(
        db, actor=actor, action="user.update", target_type="user",
        target_id=str(user_id), meta=changed,
    )
    return await _user_out(user)


@admin_router.delete("/users/{user_id}", status_code=204)
async def delete_user(
    user_id: uuid.UUID,
    data: ConfirmPasswordIn,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_permission(CorePerm.USER_MANAGE)),
) -> None:
    """Delete a user. Requires the acting admin to re-enter their own password,
    and blocks deleting your own account."""
    if actor.id == user_id:
        raise ValidationError("You cannot delete your own account.")
    svc = AuthService(db)
    if not svc.verify_actor_password(actor, data.password):
        raise UnauthorizedError("Password confirmation failed.")
    user = await svc.delete_user(user_id, scope_of(actor))
    await audit_record(
        db, actor=actor, action="user.delete", target_type="user",
        target_id=str(user_id), meta={"email": user.email},
    )


# --- admin account actions ---------------------------------------------------
@admin_router.post("/users/{user_id}/lock", response_model=UserOut)
async def lock_user(
    user_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_permission(CorePerm.USER_MANAGE)),
) -> UserOut:
    """Manually lock a user out of sign-in until an admin unlocks them."""
    if actor.id == user_id:
        raise ValidationError("You cannot lock your own account.")
    user = await AuthService(db).admin_lock_user(user_id, scope_of(actor))
    await audit_record(
        db, actor=actor, action="user.lock", target_type="user",
        target_id=str(user_id), meta={"email": user.email},
    )
    return await _user_out(user)


@admin_router.post("/users/{user_id}/unlock", response_model=UserOut)
async def unlock_user(
    user_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_permission(CorePerm.USER_MANAGE)),
) -> UserOut:
    """Clear a lock (manual or brute-force) and reset the failed-login counter."""
    user = await AuthService(db).admin_unlock_user(user_id, scope_of(actor))
    await audit_record(
        db, actor=actor, action="user.unlock", target_type="user",
        target_id=str(user_id), meta={"email": user.email},
    )
    return await _user_out(user)


@admin_router.post("/users/{user_id}/reset-mfa", response_model=UserOut)
async def reset_user_mfa(
    user_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_permission(CorePerm.USER_MANAGE)),
) -> UserOut:
    """Disable the target user's TOTP second factor (lost-device recovery)."""
    user = await AuthService(db).admin_reset_mfa(user_id, scope_of(actor))
    await audit_record(
        db, actor=actor, action="user.reset_mfa", target_type="user",
        target_id=str(user_id), meta={"email": user.email},
    )
    return await _user_out(user)


@admin_router.post("/users/{user_id}/revoke-sessions", response_model=UserOut)
async def force_sign_out_user(
    user_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_permission(CorePerm.USER_MANAGE)),
) -> UserOut:
    """Force sign-out: revoke every live session/refresh token for the user."""
    user = await AuthService(db).admin_revoke_sessions(user_id, scope_of(actor))
    await audit_record(
        db, actor=actor, action="user.revoke_sessions", target_type="user",
        target_id=str(user_id), meta={"email": user.email},
    )
    return await _user_out(user, 0)


@admin_router.post("/users/{user_id}/clone", response_model=UserOut, status_code=201)
async def clone_user(
    user_id: uuid.UUID,
    data: CloneUserIn,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_permission(CorePerm.USER_MANAGE)),
) -> UserOut:
    """Fast onboarding: copy a user's role, status and site scope into a new account
    (fresh email/name; the new user sets their own password via the invite)."""
    svc = AuthService(db)
    user = await svc.clone_user(user_id, data, scope_of(actor))
    await audit_record(
        db, actor=actor, action="user.clone", target_type="user",
        target_id=str(user.id), meta={"email": user.email, "cloned_from": str(user_id)},
    )
    if data.send_invite:
        await _send_invite_email(db, user)
    return await _user_out(user)


