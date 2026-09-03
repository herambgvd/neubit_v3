"""How this service reaches DashForge.

Its own settings class rather than fields on `kernel.config.Settings`: the shared
Settings is deliberately the subset every satellite reads (`VE_` prefixed, one
shared .env), and adding a peer product's credentials to it would put a DashForge
password in the config object that core, ingest, workflow and vision all
instantiate. The blast radius of a secret is who can read it.

`VE_DASHFORGE_` prefix, so the shared .env stays one namespace.

THE SERVICE ACCOUNT is the part worth reading. Minting an embed token on
DashForge is an AUTHENTICATED, editor+ call scoped to a workspace, so this
service holds ONE DashForge account and mints on behalf of NeuBit callers. Two
consequences that were chosen, not inherited:

* That account is the ceiling on what any NeuBit viewer can ever be shown. It
  should be a member of exactly the workspace whose dashboards NeuBit embeds,
  with the LOWEST role that can mint (editor), never a platform super-admin —
  otherwise a bug in the registration surface reaches every workspace on the
  DashForge instance rather than one.
* NeuBit's own permission check therefore cannot be delegated to DashForge.
  DashForge sees one caller, always the same one; it has no idea which NeuBit
  operator is behind it. The gate that decides whether a human may see a
  dashboard is `dashforge.read`, enforced HERE, before a token exists. See
  `embeds/router.py`.

Unset `VE_DASHFORGE_BASE_URL` and the feature is simply off: registrations still
list and manage, and asking for an embed session answers 503 with the reason,
rather than the service failing to boot. A satellite that refuses to start
because an optional peer is unconfigured takes the whole compose stack's
`depends_on` chain down with it.
"""

from __future__ import annotations

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class DashForgeSettings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="VE_DASHFORGE_", env_file=".env", extra="ignore")

    # Where this service reaches the DashForge API from inside the compose
    # network (http://dashforge-backend:8080). Empty = the integration is off.
    base_url: str = ""

    # Where a BROWSER reaches the DashForge frontend. Separate from base_url and
    # necessarily so: the iframe src is resolved by the operator's browser, which
    # is not on the compose network, so an internal service name here would
    # produce an iframe that silently never loads.
    public_url: str = ""

    # The service account described in the module docstring.
    email: str = ""
    password: str = ""

    # How long a minted embed token lives, in MINUTES. The reasoning for this
    # number is in `embeds/client.py` next to the mint call, where it is applied.
    token_ttl_minutes: int = 15

    # Seconds to wait on any DashForge call. Short: this sits in front of an
    # operator opening a page, and a peer that has gone away should surface as a
    # named failure quickly rather than holding a worker until the gateway's own
    # timeout fires with nothing to say.
    timeout_seconds: float = 10.0

    @property
    def enabled(self) -> bool:
        return bool(self.base_url and self.email and self.password)


@lru_cache
def get_dashforge_settings() -> DashForgeSettings:
    return DashForgeSettings()
