"""Workflow service database handle — its OWN Postgres db (neubit_workflow).

Uses kernel's Database factory, pointed at this service's VE_DATABASE_URL.
Domain models (added later) inherit from ``Base``; routes depend on ``get_db``.
"""

from __future__ import annotations

from kernel.config import get_settings
from kernel.db import Database

database = Database(get_settings().database_url)

Base = database.Base
get_db = database.get_db
get_engine = database.get_engine
