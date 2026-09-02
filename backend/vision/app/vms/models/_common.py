"""Shared helpers + column conventions for the VMS ORM.

Every VMS table is TENANT-SCOPED (nullable ``tenant_id``; NULL = a platform /
super-admin / system row) — the kernel multi-tenancy pattern, identical to the
access service. Reads and by-id lookups go through ``kernel.auth.scoped`` /
``assert_owned`` so isolation lives in one place.

Portable generic types (String/Boolean/DateTime/Integer/Uuid/JSON) keep the models
working on Postgres and SQLite (tests). NO PG enum columns — status/mode/type
fields are plain strings, dodging the asyncpg add-column enum footgun (project
memory). Enterprise fields (recording / advanced / ptz / placement / node) are
present from day 1 (build-once) even though the logic that fills them ships in
later phases.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone


def _uuid_str() -> str:
    return str(uuid.uuid4())


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)
