"""The dynamic half of the permission catalog.

`permissions.PERMISSIONS` is the authority on every key the code enforces, but it
cannot cover keys that do not exist at build time — dataset read permissions are
registered as data (rows in `neubit_reporting.dashboard_datasets`). A key core has
never heard of is refused by `PERMISSIONS.unknown()` on role create, so no role
can grant it.

Satellites POST their keys to `/auth/permissions/registrations`
(`backend/reading-writer/app/api/permsync.py` is the worked example) and they land
in `permission_registrations`. This module is the read side: it merges them into
the grouped catalog the role editor renders and into the role create/update check.

Static always wins: a registration can add a key, never redefine one the code
enforces, and never make an unknown key look enforced.
"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .models import PermissionRegistration
from .permissions import PERMISSIONS


async def registered(db: AsyncSession) -> list[PermissionRegistration]:
    rows = await db.execute(
        select(PermissionRegistration).order_by(
            PermissionRegistration.group_name, PermissionRegistration.key
        )
    )
    return list(rows.scalars().all())


async def known_keys(db: AsyncSession) -> set[str]:
    """Every grantable key: the static catalog plus what services registered."""
    rows = await db.execute(select(PermissionRegistration.key))
    return PERMISSIONS.keys() | set(rows.scalars().all())


async def unknown(db: AsyncSession, perms) -> list[str]:
    """Keys that are grantable by nothing. The wildcard is excluded (it is
    reserved for the built-in Administrator and rejected separately)."""
    known = await known_keys(db)
    return [p for p in perms if p != "*" and p not in known]


async def grouped(db: AsyncSession) -> dict[str, list[dict]]:
    """The role editor's payload: static groups, with registered keys merged in.

    A registered key colliding with a static one is dropped — a satellite must not
    be able to relabel `user.manage` for the person editing a role.
    """
    out = PERMISSIONS.grouped()
    static = PERMISSIONS.keys()
    for r in await registered(db):
        if r.key in static:
            continue
        out.setdefault(r.group_name, []).append(
            {
                "key": r.key,
                "label": r.label,
                "description": r.description,
                # Marked so the editor can say where it came from. Purely
                # informational — it grants exactly like any other key.
                "registered_by": r.source,
            }
        )
    return out


async def register(db: AsyncSession, *, source: str, permissions: list[dict]) -> int:
    """Upsert a service's permission keys. Idempotent — a service calls this on
    every startup and whenever its own registry changes, and re-registering the
    same key must be a no-op rather than a conflict."""
    written = 0
    for p in permissions:
        key = (p.get("key") or "").strip()
        if not key or key in PERMISSIONS.keys():
            # Nothing to do for a key the static catalog already defines.
            continue
        label = (p.get("label") or key)[:200]
        group = (p.get("group") or "Other")[:80]
        desc = p.get("description") or ""
        # Select-then-write rather than ON CONFLICT: a postgres-only upsert would
        # be untestable on SQLite, and it is a handful of rows on startup.
        row = await db.get(PermissionRegistration, key)
        if row is None:
            db.add(
                PermissionRegistration(
                    key=key, label=label, group_name=group,
                    description=desc, source=source[:64],
                )
            )
        else:
            row.label, row.group_name, row.description = label, group, desc
            row.source = source[:64]
        written += 1
    await db.commit()
    return written
