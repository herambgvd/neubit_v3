"""The linkage ``notify`` action's TEMPLATE path — what makes a custom template real.

An operator can author an email template in core's Templates screen. Until a rule
could name one, nothing outside core rendered them, so a custom template was a
document with no sender. A rule that carries ``{"template": "<name>"}`` has it
rendered through core at publish time and publishes the RESULT, so the workflow
consumer and the SMTP connector stay template-unaware.

Covered here: the render is used, the publish carries the HTML flag, a failed
render degrades to the plain wording instead of losing the alert, and a rule with
no template still publishes exactly what it published before.
"""

from __future__ import annotations

import uuid

import pytest

import app.vms.linkage.actions as actions
from app.vms.linkage.actions import ActionContext, action_notify

pytestmark = pytest.mark.asyncio

TENANT = str(uuid.uuid4())


def _ctx() -> ActionContext:
    return ActionContext(
        tenant_id=TENANT,
        camera_id="cam-1",
        event_id="evt-1",
        event_type="motion",
        severity="high",
        title="Perimeter breach",
        sessionmaker=None,
        reason="Person in restricted zone",
    )


@pytest.fixture
def published(monkeypatch) -> list[dict]:
    """Capture what the action would publish on tenant.<id>.notify.request."""
    seen: list[dict] = []

    async def _emit(tenant_id, payload):
        seen.append(payload)
        return f"tenant.{tenant_id}.notify.request"

    monkeypatch.setattr(actions, "emit_notify_request", _emit)
    return seen


async def test_named_template_is_rendered_and_published(published, monkeypatch):
    calls: list[tuple] = []

    async def _render(tenant_id, name, context):
        calls.append((tenant_id, name, context))
        return "Gate breach at Lobby", "<p>Person in restricted zone</p>"

    monkeypatch.setattr(actions.core_templates, "render", _render)

    res = await action_notify(_ctx(), {"channel": "email", "target": "ops@x.io",
                                       "template": "gate_breach"})
    assert res.ok
    payload = published[0]
    assert payload["subject"] == "Gate breach at Lobby"
    assert payload["html"] is True
    assert payload["body"] == "<p>Person in restricted zone</p>"

    tenant_id, name, ctx = calls[0]
    assert (tenant_id, name) == (TENANT, "gate_breach")
    # The event's own facts are the template's context — an operator writing
    # {{ title }} / {{ severity }} gets the event, not a placeholder.
    assert ctx["title"] == "Perimeter breach"
    assert ctx["severity"] == "high"
    assert ctx["message"] == "Person in restricted zone"
    assert ctx["camera_id"] == "cam-1"

    # The template name is consumed, not passed through as opaque extra config.
    assert "template" not in payload["config"]


async def test_template_context_overrides_the_event_defaults(published, monkeypatch):
    calls: list[dict] = []

    async def _render(tenant_id, name, context):
        calls.append(context)
        return "s", "<p>b</p>"

    monkeypatch.setattr(actions.core_templates, "render", _render)
    await action_notify(_ctx(), {"template": "t", "template_context": {"title": "Custom"}})
    assert calls[0]["title"] == "Custom"


async def test_failed_render_degrades_to_plain_text(published, monkeypatch):
    """Core unreachable must not lose the alert — it loses the FORMATTING."""

    async def _render(tenant_id, name, context):
        return None

    monkeypatch.setattr(actions.core_templates, "render", _render)
    res = await action_notify(_ctx(), {"template": "gate_breach"})
    assert res.ok
    payload = published[0]
    assert payload["html"] is False
    assert payload["subject"] == "VMS: Perimeter breach"
    assert payload["body"] == "Person in restricted zone"


async def test_no_template_publishes_the_plain_request(published, monkeypatch):
    async def _render(tenant_id, name, context):  # must not be reached
        raise AssertionError("no template named — core must not be called")

    monkeypatch.setattr(actions.core_templates, "render", _render)
    res = await action_notify(_ctx(), {"channel": "email", "subject": "Sub", "body": "Body"})
    assert res.ok
    payload = published[0]
    assert (payload["subject"], payload["body"]) == ("Sub", "Body")
    assert payload["html"] is False


# --- the core call itself ----------------------------------------------------
# Driven through httpx's MockTransport rather than by patching the module: the URL,
# the bearer and the body ARE the contract with core's render endpoint.


@pytest.fixture
def core_url(monkeypatch):
    monkeypatch.setenv("VE_CORE_URL", "http://core:8000")
    monkeypatch.setenv("VE_API_PREFIX", "/api/v1")


async def test_render_calls_core_with_a_service_token(core_url, monkeypatch):
    import httpx

    from app.vms.linkage import core_templates

    seen: dict = {}

    def _handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["auth"] = request.headers.get("authorization")
        seen["body"] = request.read().decode()
        return httpx.Response(200, json={"subject": "S", "html": "<p>H</p>"})

    transport = httpx.MockTransport(_handler)
    real_client = httpx.AsyncClient

    def _client(**kwargs):
        return real_client(transport=transport, **kwargs)

    monkeypatch.setattr(core_templates.httpx, "AsyncClient", _client)

    out = await core_templates.render(TENANT, "gate_breach", {"title": "t"})
    assert out == ("S", "<p>H</p>")
    assert seen["url"] == "http://core:8000/api/v1/messaging/templates/gate_breach/render"
    assert seen["auth"].startswith("Bearer ")
    # core cannot read a tenant off a service principal, so it travels in the body.
    assert TENANT in seen["body"]


async def test_render_returns_none_on_an_error_status(core_url, monkeypatch):
    import httpx

    from app.vms.linkage import core_templates

    transport = httpx.MockTransport(lambda r: httpx.Response(422, json={"error": "nope"}))
    real_client = httpx.AsyncClient
    monkeypatch.setattr(
        core_templates.httpx, "AsyncClient",
        lambda **kw: real_client(transport=transport, **kw),
    )
    assert await core_templates.render(TENANT, "nope", {}) is None


async def test_render_is_off_when_core_is_unconfigured(monkeypatch):
    from app.vms.linkage import core_templates

    monkeypatch.delenv("VE_CORE_URL", raising=False)
    assert await core_templates.render(TENANT, "gate_breach", {}) is None
