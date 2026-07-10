"""PTZ operator-control domain (G1) — move / zoom / focus + preset CRUD + patrols.

Self-contained domain package (``schemas`` + ``service`` + ``router`` + ``cycler``) mounted
under ``/vms``. Builds on the multi-brand ``drivers`` PTZ seam (continuous/zoom/focus/stop +
preset set/goto/remove) and the tenant-scoped ``PtzPreset`` / ``PtzPatrol`` catalogs.

  * Move: ``POST /vms/cameras/{id}/ptz/move`` + ``/ptz/stop`` + ``/ptz/zoom`` + ``/ptz/focus``.
  * Presets: ``GET/POST /vms/cameras/{id}/ptz/presets`` + ``/presets/{pid}/goto`` + ``DELETE``.
  * Patrols: ``GET/POST /vms/cameras/{id}/ptz/patrols`` + ``PATCH/DELETE`` + ``/start`` + ``/stop``.

Patrols run via the process-local ``PatrolCycler`` (goto-preset in order on dwell). A process
restart drops running cyclers — accepted caveat; ``is_running`` records intent so an operator
re-starts them.
"""

from __future__ import annotations

from .cycler import PatrolCycler, get_cycler

__all__ = ["PatrolCycler", "get_cycler"]
