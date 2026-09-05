"""The workflow REST API, assembled from the feature routers.

Each feature owns its own ``router.py``; this module only collects them. It is
the one place the MOUNT ORDER is decided, and that order is load-bearing in one
narrow way: FastAPI's generated OpenAPI lists paths in route-registration order,
so reordering this list changes ``/openapi.json`` byte-for-byte even though every
route still resolves identically. Keep it as it is unless a path genuinely moves.

All routers mount under the service ``api_prefix`` (``/api/v1``) with a
``/workflow`` prefix, so paths are ``/api/v1/workflow/...``. Every endpoint is
gated by a ``workflow.*`` permission via ``kernel.auth.require_permission`` and
runs inside the caller's tenant scope (``get_scope``).

Permission keys used:
    workflow.sop.read/create/update/delete
    workflow.state.*  workflow.transition.*  workflow.trigger.*  workflow.form.*
    workflow.notification.*  workflow.threat_level.read/update
    workflow.instance.read/create/update
"""

from __future__ import annotations

from .forms.router import form_router
from .instances.router import instance_router
from .notifications.router import notification_router
from .sops.router import sop_router, state_router, transition_router
from .threat_levels.router import threat_router
from .triggers.router import alert_format_router, event_router, trigger_router

# All routers — mounted by app.main under the api_prefix.
routers = [
    sop_router,
    state_router,
    transition_router,
    trigger_router,
    alert_format_router,
    event_router,
    form_router,
    notification_router,
    threat_router,
    instance_router,
]
