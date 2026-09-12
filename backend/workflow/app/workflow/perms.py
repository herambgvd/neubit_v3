"""The permission keys this service enforces.

These strings are a wire contract: the core service publishes the same catalog to
the role editor (``CorePerm.WORKFLOW_*`` in core's ``app/auth/permissions.py``) and
the JWT arrives carrying them. Core and workflow are deployed separately and share
only ``kernel``, so the catalog cannot be imported — it is mirrored here instead,
and the VALUES must stay byte-identical to core's. A key spelled freehand at a
route is the failure this module exists to prevent: it never matches a granted
permission, so the route 403s for everyone, or — renamed on one side only — it
stops gating what the screen thinks it gates.
"""

from __future__ import annotations

SOP_READ = "workflow.sop.read"
SOP_CREATE = "workflow.sop.create"
SOP_UPDATE = "workflow.sop.update"
SOP_DELETE = "workflow.sop.delete"

TRIGGER_READ = "workflow.trigger.read"
TRIGGER_CREATE = "workflow.trigger.create"
TRIGGER_UPDATE = "workflow.trigger.update"
TRIGGER_DELETE = "workflow.trigger.delete"

INSTANCE_READ = "workflow.instance.read"
INSTANCE_CREATE = "workflow.instance.create"
INSTANCE_UPDATE = "workflow.instance.update"

FORM_READ = "workflow.form.read"
FORM_CREATE = "workflow.form.create"
FORM_UPDATE = "workflow.form.update"
FORM_DELETE = "workflow.form.delete"

NOTIFICATION_READ = "workflow.notification.read"
NOTIFICATION_CREATE = "workflow.notification.create"
NOTIFICATION_UPDATE = "workflow.notification.update"
NOTIFICATION_DELETE = "workflow.notification.delete"

THREAT_LEVEL_READ = "workflow.threat_level.read"
THREAT_LEVEL_UPDATE = "workflow.threat_level.update"
