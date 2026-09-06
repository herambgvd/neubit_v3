"""DashForge embed registry — which DashForge dashboards this platform shows.

A core module, mounted by ``create_base_app`` like ``sites`` or ``licensing``: a
small CRUD surface over one table, plus one privileged route that mints a
short-lived embed token for a caller who passed NeuBit's permission check.

A module, not a service: it has no public surface, no independent load and no
failure domain worth isolating, so a container, database and migration chain for a
table of pointers was not worth keeping in step.

What it is not:

* Not a dashboard builder. Authoring happens in DashForge. Nothing here stores a
  layout, widget or query, so there is no second definition to drift.
* Not a query path. Widget numbers come from DashForge's own datasource; nothing
  here opens ``neubit_reporting``, leaving that schema one owner (contract §7).

Gating is declared once on the router (``router.py``) so no route can forget it:
the ``analytics`` entitlement, the tenant-active check, and per route
``dashforge.read`` or ``dashforge.manage``.
"""

from .router import router

__all__ = ["router"]
