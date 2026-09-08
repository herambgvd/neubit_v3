"""A transition's email can be a CORE template.

An operator designs email templates in core's Templates screen — blocks,
variables, a branded shell, a preview. This service had its own template store
(a subject field and a body textarea) and no way to reach those, so the estate
had two answers to "what does this email look like" and only one of them was
designable.

A transition's notify config can now name a core template. It is rendered THERE
(the override chain, the Jinja environment and the branding all live in core) and
the result is what the outbox row carries, so the connectors stay unchanged.

Best-effort by design: core unreachable, or a name it does not know, falls back to
this service's own template or to the inline strings. A notification that degrades
to plain wording still reaches the operator; one that fails does not.
"""

from __future__ import annotations

import httpx
import pytest
from types import SimpleNamespace

from app.workflow.core import core_templates

pytestmark = pytest.mark.asyncio

NODE = "http://core:8000"


@pytest.fixture
def core(monkeypatch):
    """A fabricated core. Records the requests, answers a rendered template."""
    calls: list[httpx.Request] = []
    state = {"status": 200, "body": {"subject": "Gate breach", "html": "<p>rendered</p>"}}

    def dispatch(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(state["status"], json=state["body"])

    def factory(*args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(dispatch)
        return httpx.AsyncClient(*args, **kwargs)

    monkeypatch.setenv("VE_CORE_URL", NODE)
    monkeypatch.setenv("VE_API_PREFIX", "/api/v1")
    monkeypatch.setattr(
        core_templates,
        "httpx",
        SimpleNamespace(AsyncClient=factory, HTTPError=httpx.HTTPError, Response=httpx.Response),
    )
    return SimpleNamespace(calls=calls, state=state)


async def test_it_renders_through_core_with_a_service_token(core):
    out = await core_templates.render("11111111-1111-1111-1111-111111111111", "alert", {"title": "x"})

    assert out == ("Gate breach", "<p>rendered</p>")
    req = core.calls[0]
    assert str(req.url).endswith("/api/v1/messaging/templates/alert/render")
    # The transition path has no operator bearer — a correlation-created incident
    # has no request behind it at all.
    assert req.headers.get("authorization", "").startswith("Bearer ")
    # Core cannot read a tenant off a service principal, so it travels in the body
    # and decides whose override of the template wins.
    assert "11111111-1111-1111-1111-111111111111" in req.content.decode()


async def test_an_unknown_template_falls_back_rather_than_failing(core):
    core.state["status"] = 422
    core.state["body"] = {"error": {"message": "unknown template"}}

    assert await core_templates.render(None, "nope", {}) is None


async def test_core_being_unreachable_is_not_an_error_here(monkeypatch):
    # The caller keeps its own wording. A notification that degrades still
    # reaches the operator; one that raises does not.
    monkeypatch.setenv("VE_CORE_URL", NODE)

    def factory(*args, **kwargs):
        def boom(_request):
            raise httpx.ConnectError("no route to host")

        kwargs["transport"] = httpx.MockTransport(boom)
        return httpx.AsyncClient(*args, **kwargs)

    monkeypatch.setattr(
        core_templates,
        "httpx",
        SimpleNamespace(AsyncClient=factory, HTTPError=httpx.HTTPError, Response=httpx.Response),
    )
    assert await core_templates.render(None, "alert", {}) is None


async def test_the_feature_is_off_when_core_is_not_configured(monkeypatch):
    monkeypatch.delenv("VE_CORE_URL", raising=False)
    assert await core_templates.render(None, "alert", {}) is None


async def test_a_half_answer_is_refused(core):
    # A body with no html is not a rendered email; using it would send a subject
    # with an empty body and look like a template that renders to nothing.
    core.state["body"] = {"subject": "only a subject"}
    assert await core_templates.render(None, "alert", {}) is None
