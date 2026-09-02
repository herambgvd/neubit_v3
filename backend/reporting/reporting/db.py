"""Reporting store database handle — its OWN Postgres db (neubit_reporting).

Same shape as every other satellite service (`app/db.py` in ingest / vision):
kernel's Database factory pointed at this service's VE_DATABASE_URL. Models
inherit from ``Base``.

The reporting database is the ONE place on the platform where data from several
services is gathered for querying. That is deliberate and is the documented
exception to the no-cross-service-reads rule. Nothing in here reaches back into
another service's private schema — data arrives over NATS, never by peeking.
"""

from __future__ import annotations

from kernel.config import get_settings
from kernel.db import Database

database = Database(get_settings().database_url)

Base = database.Base
get_db = database.get_db
get_engine = database.get_engine
