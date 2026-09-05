"""How the DashForge client behaves when the peer says no, or is not there.

Both matter to an operator: DashForge's refusals name the widget or the filter
key that caused them, and that text is the only actionable thing in the whole
exchange. Flattening it into a status code would leave a person staring at a
dashboard that will not open with nothing to act on.
"""

import pytest

from app.dashforge.client import DashForgeClient, DashForgeUnavailable
from app.dashforge.config import get_dashforge_settings


class _Resp:
    """Minimal stand-in for httpx.Response's two accessors _message uses."""

    def __init__(self, payload, status=400):
        self._payload = payload
        self.status_code = status

    def json(self):
        if isinstance(self._payload, str):
            raise ValueError("not json")
        return self._payload


def test_peer_error_text_is_passed_through_verbatim():
    # DashForge answers {"error": "<text>"} on a mint refusal, and that text
    # names the offending widget or key.
    msg = 'cannot lock site_id: it is not a global-filter control variable on this dashboard'
    assert DashForgeClient._message(_Resp({"error": msg}), "fallback") == msg


def test_nested_error_envelope_is_also_read():
    assert DashForgeClient._message(_Resp({"error": {"message": "nope"}}), "fb") == "nope"


def test_non_json_body_falls_back_rather_than_raising():
    # A proxy's HTML error page must not turn into a 500 inside this service.
    assert DashForgeClient._message(_Resp("<html>502</html>"), "fb") == "fb"


def test_empty_error_field_falls_back():
    assert DashForgeClient._message(_Resp({"error": ""}), "fb") == "fb"


@pytest.mark.asyncio
async def test_unconfigured_peer_refuses_with_the_reason_not_a_crash(monkeypatch):
    # The integration being OFF is a supported deployment shape. It must surface
    # as a named 503, never as a connection error against an empty base URL.
    get_dashforge_settings.cache_clear()
    for key in ("VE_DASHFORGE_BASE_URL", "VE_DASHFORGE_EMAIL", "VE_DASHFORGE_PASSWORD"):
        monkeypatch.delenv(key, raising=False)
    try:
        with pytest.raises(DashForgeUnavailable) as e:
            await DashForgeClient().mint_embed_token(
                workspace_ref="1", dashboard_ref="2", scope=None
            )
        assert "not configured" in str(e.value)
        assert e.value.status_code == 503
    finally:
        get_dashforge_settings.cache_clear()
