"""Federation API — the recorders' estate, aggregated.

The central VMS surfaces the cameras each registered ``MediaNode`` owns and commands
them THROUGH that node. Cameras stay owned and managed on the recorder; this service
never writes one.

This file is now only the assembly. The routes live in five modules named for what a
call asks for — see ``_common`` for the split and the shared plumbing. ``schedules``
is the youngest and the odd one: it is the single config authorship the credential
carries, and the module docstring says why.

INCLUDE ORDER IS PART OF THE CONTRACT. FastAPI matches in registration order and a
path parameter matches a literal segment happily, so a static route must be registered
before the parameterised one it would otherwise hide. ``evidence`` keeps
``/exports/public-key`` above ``/exports/{export_id}`` for exactly that reason, and the
modules do not overlap each other's prefixes — which is what makes the order between
them free.
"""

from __future__ import annotations

from fastapi import APIRouter

from app.vms.federation import device, estate, evidence, schedules, storage

router = APIRouter(prefix="/vms/federation", tags=["federation"])

router.include_router(estate.router)
router.include_router(device.router)
router.include_router(evidence.router)
router.include_router(storage.router)
# After `evidence`, which owns /cameras/{id}/recording/start|stop. This module's
# per-camera route is /cameras/{id}/recording-config — a different literal, so the
# order is free; it is included last only to keep the config surface visibly last.
router.include_router(schedules.router)

__all__ = ["router"]
