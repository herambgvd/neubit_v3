"""DashForge-embed service database handle — its OWN Postgres db (neubit_dashforge).

Its own database on the shared Postgres, exactly like `neubit_ingest` /
`neubit_workflow` / `neubit_dashboards`. It holds REGISTRATIONS and nothing else:
which DashForge dashboards this platform shows, under what name, and what the
embed needs in order to be minted.

What is deliberately NOT here, and why the table is so thin:

* **No dashboard definition.** Layout, widgets, queries and variables live in
  DashForge, which owns them. Mirroring any of it here would create a second
  copy free to drift from the real one, and the first symptom would be a
  dashboard that renders one thing and is described in NeuBit as another.
* **No readings.** A widget's numbers are fetched by DashForge from its own
  datasource at render time; nothing here can go stale.
* **No embed token.** A token is a bearer credential and is minted per viewing
  session (see `embeds/client.py`). Storing one would turn this table into a
  credential store whose rows outlive the session that needed them.

So a row here is a POINTER plus a display name — the smallest thing that lets
NeuBit's permission model stand in front of somebody else's dashboard.
"""

from __future__ import annotations

from kernel.config import get_settings
from kernel.db import Database

database = Database(get_settings().database_url)

Base = database.Base
get_db = database.get_db
get_engine = database.get_engine
