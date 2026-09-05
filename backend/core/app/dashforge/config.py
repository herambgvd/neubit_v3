"""How this module reaches DashForge.

Its OWN settings class and not fields on ``app.core.config.Settings``. That was
true when this lived in a satellite (the shared kernel Settings is instantiated by
core, ingest, workflow and vision alike, and a peer product's password has no
business in an object all four hold) and it stays true after the fold-in for a
narrower reason: ``get_settings()`` is read by every module in this process and
its object is what a settings dump, a debug endpoint or a traceback repr would
carry. Keeping the DashForge password in a class that only this module
instantiates keeps the number of places it can be read from at one.

What DID change with the fold-in, stated plainly rather than left to be
discovered: the service account now lives in CORE's environment instead of the
``dashforge`` container's. Both are ``env_file: .env`` on the same host reading
the same ``VE_DASHFORGE_*`` values, so the credential did not move to a new store
and is not readable by anyone who could not read it before — but it is now inside
a bigger process, which is why it stays off the shared Settings.

``VE_DASHFORGE_`` prefix, so the shared .env stays one namespace.

THE SERVICE ACCOUNT is the part worth reading. Minting an embed token on
DashForge is an AUTHENTICATED, editor+ call scoped to a workspace, so this module
holds ONE DashForge account and mints on behalf of NeuBit callers. Two
consequences that were chosen, not inherited:

* That account is the ceiling on what any NeuBit viewer can ever be shown. It
  should be a member of exactly the workspace whose dashboards NeuBit embeds,
  with the LOWEST role that can mint (editor), never a platform super-admin —
  otherwise a bug in the registration surface reaches every workspace on the
  DashForge instance rather than one.
* NeuBit's own permission check therefore cannot be delegated to DashForge.
  DashForge sees one caller, always the same one; it has no idea which NeuBit
  operator is behind it. The gate that decides whether a human may see a
  dashboard is ``dashforge.read``, enforced HERE, before a token exists. See
  ``router.py``.

Unset ``VE_DASHFORGE_BASE_URL`` and the feature is simply off: registrations
still list and manage, and asking for an embed session answers 503 with the
reason. That mattered as a satellite because a service refusing to boot on an
optional peer takes every ``depends_on`` behind it down with it; it matters more
now, because refusing to boot would take the whole console with it.
"""

from __future__ import annotations

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class DashForgeSettings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="VE_DASHFORGE_", env_file=".env", extra="ignore")

    # Where THIS PROCESS reaches the DashForge API from inside the compose
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
    # number is in `client.py` next to the mint call, where it is applied.
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
