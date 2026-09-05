"""The DYNAMIC half of the permission catalog.

`permissions.PERMISSIONS` is a python constant and is the authority on every key
the code itself enforces. It cannot cover keys that do not exist at build time —
and the dataset registry creates exactly those: a domain registers a dataset with
an INSERT into `neubit_reporting.dashboard_datasets` and names the permission
needed to read it. (This said "the dashboard builder's dataset registry". The
builder was retired on 2026-09-03; the registry outlived it and the READING-WRITER
owns it — `backend/reading-writer/app/api/permsync.py` is what POSTs these keys.
The mechanism below is unchanged.) If core has never heard of that key,
`PERMISSIONS.unknown()` refuses it on role create and **no role can grant it**.

That is the bug the builder contract names: `ingest.read` / `ingest.manage` were
enforced by the backend and never registered, so only a wildcard admin could
reach Ingest. Registering a key is not book-keeping; it is what makes the
permission grantable.

So a satellite POSTs its keys to `/auth/permissions/registrations` and they land
in `permission_registrations`. This module is the read side: it merges them into
the grouped catalog the role editor renders, and into the validity check role
create/update runs.

**Static always wins.** A registration can add a key; it can never redefine one
the code enforces, and it can never make an unknown key look enforced.
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

    A registered key whose name collides with a static one is DROPPED — the code's
    own catalog describes what the code enforces, and letting a satellite relabel
    `user.manage` would be a way to lie to the person editing a role.
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
        # Select-then-write rather than an ON CONFLICT: core's tests run on
        # SQLite and a postgres-only upsert would make this module untestable
        # there. The volume is a handful of rows on startup, so the round trip
        # costs nothing.
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
