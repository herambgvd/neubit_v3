"""How this module reaches DashForge. ``VE_DASHFORGE_`` prefix on the shared .env.

Its own settings class, not fields on ``app.core.config.Settings``: that object is
read by every module in the process and is what a settings dump or traceback repr
would carry, so keeping the DashForge password in a class only this module
instantiates keeps it readable from one place. Do not move it.

The service account: minting an embed token is an authenticated, editor+, per‑
workspace call, so this module holds one DashForge account and mints for NeuBit
callers. Give it the lowest role that can mint and membership of only the
workspace NeuBit embeds — never platform super-admin — because it is the ceiling
on what any NeuBit viewer can be shown. DashForge sees that one caller and cannot
tell which operator is behind it, so the human-level check is ``dashforge.read``,
enforced here before a token exists (see ``router.py``).

Unset ``VE_DASHFORGE_BASE_URL`` and the feature is off: registrations still list
and manage, and an embed session answers 503 with the reason. Do not make this
fatal at startup — it would take the whole console down with an optional peer.
"""

from __future__ import annotations

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class DashForgeSettings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="VE_DASHFORGE_", env_file=".env", extra="ignore")

    # Where this process reaches the DashForge API inside the compose network
    # (http://dashforge-backend:8080). Empty = the integration is off.
    base_url: str = ""

    # Where a browser reaches the DashForge frontend. Must stay separate from
    # base_url: the iframe src is resolved by the operator's browser, which is not
    # on the compose network, so an internal service name never loads.
    public_url: str = ""

    # The service account described in the module docstring.
    email: str = ""
    password: str = ""

    # How long a minted embed token lives, in minutes. Reasoning is in `client.py`.
    token_ttl_minutes: int = 15

    # Seconds to wait on any DashForge call. Kept short: this sits in front of an
    # operator opening a page, so a dead peer should fail fast and by name.
    timeout_seconds: float = 10.0

    @property
    def enabled(self) -> bool:
        return bool(self.base_url and self.email and self.password)


@lru_cache
def get_dashforge_settings() -> DashForgeSettings:
    return DashForgeSettings()
