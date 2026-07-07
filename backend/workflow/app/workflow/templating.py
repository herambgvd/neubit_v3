"""Safe Jinja2 rendering for notification templates.

Notification ``subject``/``body`` may be authored as Jinja2 templates that render
against an incident context (``instance``, ``from_state``, ``to_state``,
``sop_name``, ``site_id``, ``priority``, ``event_type``, …). We render inside a
``SandboxedEnvironment`` (no attribute access to dunders / arbitrary callables)
and treat missing variables as empty strings rather than raising, so a template
referencing a var that isn't in the context never breaks a dispatch.
"""

from __future__ import annotations

import logging

from jinja2 import ChainableUndefined
from jinja2.sandbox import SandboxedEnvironment

log = logging.getLogger("workflow.templating")

# ChainableUndefined lets ``{{ a.b.c }}`` resolve to empty even when ``a`` is
# missing, instead of raising UndefinedError. StrictUndefined would be the
# opposite; we want forgiving.
_env = SandboxedEnvironment(undefined=ChainableUndefined, autoescape=False)


def render_template(source: str | None, context: dict) -> str:
    """Render a Jinja2 template string against ``context`` (best-effort).

    Returns "" for a falsy ``source``. On any template error (bad syntax, sandbox
    violation) we log and fall back to the raw source so a broken template degrades
    to a literal string rather than dropping the notification.
    """
    if not source:
        return ""
    try:
        return _env.from_string(source).render(**context)
    except Exception as exc:  # noqa: BLE001 - never let a template break dispatch
        log.warning("notification template render failed: %s", exc)
        return source


def build_notification_context(inst, *, from_state=None, to_state=None, sop_name=None) -> dict:
    """Assemble the render context exposed to notification templates.

    Keys (contract — the frontend/template authors rely on these names):
        instance     — the WorkflowInstance-ish object (attr access: .name, .priority…)
        instance_id, instance_name, sop_id, sop_name, sop_version
        priority, status, site_id, event_type, event_id
        from_state, to_state       — human state names (str) for the transition
        current_state              — current state name
        assigned_to, tags, trigger_data, metadata
    """
    extra = getattr(inst, "extra", None) or {}
    return {
        "instance": inst,
        "instance_id": getattr(inst, "instance_id", None),
        "instance_name": getattr(inst, "name", None),
        "sop_id": getattr(inst, "sop_id", None),
        "sop_name": sop_name if sop_name is not None else getattr(inst, "sop_name", None),
        "sop_version": getattr(inst, "sop_version", None),
        "priority": getattr(inst, "priority", None),
        "status": getattr(inst, "status", None),
        "site_id": getattr(inst, "site_id", None),
        "event_type": getattr(inst, "event_type", None),
        "event_id": getattr(inst, "event_id", None),
        "from_state": from_state,
        "to_state": to_state,
        "current_state": getattr(inst, "current_state_name", None),
        "assigned_to": getattr(inst, "assigned_to", None),
        "tags": getattr(inst, "tags", None) or [],
        "trigger_data": getattr(inst, "trigger_data", None) or {},
        "metadata": extra,
    }
