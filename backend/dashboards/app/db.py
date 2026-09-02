"""Dashboards service database handle — its OWN Postgres db (neubit_dashboards).

Its own database, on the shared Postgres, exactly like `neubit_ingest` /
`neubit_workflow` / `neubit_vision`. It holds dashboard definitions and nothing
else: no readings, no copy of the points dimension, no cached values. A widget's
numbers are fetched from the reading-writer at render time, so there is nothing
here that can go stale against `neubit_reporting`.
"""

from __future__ import annotations

from kernel.config import get_settings
from kernel.db import Database

database = Database(get_settings().database_url)

Base = database.Base
get_db = database.get_db
get_engine = database.get_engine
