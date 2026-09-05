"""DashForge embed registry — which DashForge dashboards this platform shows.

A core module, mounted by ``create_base_app`` like ``sites`` or ``licensing``.
It is a small CRUD surface over one table plus ONE privileged route that mints a
short-lived embed token for a caller who has passed NeuBit's permission check.

WHY IT IS A MODULE AND NOT A SERVICE. It stood as ``backend/dashforge``, its own
container and its own database, from 2026-09-03 to 2026-09-05. That shape was
copied from ingest / workflow / vision because it is the fleet's pattern, and the
pattern on its own turned out not to be a reason: 1,256 lines with no public
surface, no independent load, no separate scaling need and no failure domain
worth isolating — a container, a database, a migration chain, a gateway route and
a healthcheck to keep in step, all to hold a table of pointers. Folded in here on
2026-09-05. Nothing about the security of the feature moved with it; see below.

What it is NOT, and why:

* It is not a dashboard builder. DashForge is the single dashboarding surface;
  authoring happens there. Nothing here stores a layout, a widget or a query, so
  there is no second definition of a dashboard to drift from the real one.
* It is not a query path. A widget's numbers are fetched by DashForge from its
  own datasource. Nothing here opens ``neubit_reporting``, so the rule that gives
  the readings schema one owner (contract §7) is untouched by the integration.
* It was NOT, on the day it landed, the retirement of ``backend/dashboards`` —
  that service was deliberately left running until this integration had been
  proven, because two dashboard surfaces existing at once is a smaller cost than
  deleting a working one on the day its replacement first boots. That proving is
  done: the builder was removed on 2026-09-03, and this is now the only
  dashboarding surface. Kept rather than deleted because the sequencing is the
  reason the changeover was survivable, and the next person tempted to land a
  replacement and a deletion together should see it.

Gating is declared once on the router itself (``router.py``) so no route can
forget it: the ``analytics`` module entitlement, the tenant-active check, and per
route ``dashforge.read`` or ``dashforge.manage``.
"""

from .router import router

__all__ = ["router"]
