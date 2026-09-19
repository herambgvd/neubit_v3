"""The registry says whether a registration could actually be OPENED.

DashForge is an optional, separately-deployed peer (`deploy/docker-compose.
dashforge.yml` is deliberately not merged into the default stack). The registry
is core's OWN table, so it lists perfectly on a deployment that has no DashForge
at all — and `dashforge.read` plus the `analytics` module both pass there too.
That left the console with nothing to gate a launcher tile on, so it offered one
and the operator's click came back a 503.

`integration_enabled` is the one boolean that closes that gap. It must track the
same pair `open_session` needs — a configured client AND a browser-resolvable
public url — or the tile and the 503 go back to disagreeing.
"""

import pytest

from app.dashforge.config import get_dashforge_settings
from app.dashforge.router import list_embeds


class _Svc:
    """Stands in for EmbedService: the flag is about the deployment, not the rows."""

    async def list_(self, *, search=None, category=None):
        return [], 0


def _env(monkeypatch, **values):
    get_dashforge_settings.cache_clear()
    for key in ("BASE_URL", "PUBLIC_URL", "EMAIL", "PASSWORD"):
        monkeypatch.delenv(f"VE_DASHFORGE_{key}", raising=False)
    for key, value in values.items():
        monkeypatch.setenv(f"VE_DASHFORGE_{key}", value)


CONFIGURED = dict(
    BASE_URL="http://dashforge-backend:8080",
    PUBLIC_URL="https://dash.example.com",
    EMAIL="svc@example.com",
    PASSWORD="pw",
)


@pytest.mark.asyncio
async def test_unconfigured_deployment_reports_the_integration_off(monkeypatch):
    _env(monkeypatch)
    try:
        assert (await list_embeds(_Svc())).integration_enabled is False
    finally:
        get_dashforge_settings.cache_clear()


@pytest.mark.asyncio
async def test_fully_configured_deployment_reports_it_on(monkeypatch):
    _env(monkeypatch, **CONFIGURED)
    try:
        assert (await list_embeds(_Svc())).integration_enabled is True
    finally:
        get_dashforge_settings.cache_clear()


@pytest.mark.asyncio
async def test_missing_public_url_is_off_because_no_iframe_can_be_built(monkeypatch):
    # `open_session` refuses on exactly this — an internal service name in an
    # iframe src never loads in the operator's browser — so the flag must too.
    _env(monkeypatch, **{k: v for k, v in CONFIGURED.items() if k != "PUBLIC_URL"})
    try:
        assert (await list_embeds(_Svc())).integration_enabled is False
    finally:
        get_dashforge_settings.cache_clear()
