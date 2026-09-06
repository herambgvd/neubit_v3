"""Core refuses to start on a secret anyone can read in the repository.

`_enforce_secrets` is the guard, it runs in `create_app`, and until now nothing
tested it — on the service that MINTS every token in the estate. A guard with no
test is a guard that stops working quietly.

WHAT IT MISSED
--------------
It checked a hardcoded list of five strings, and the two placeholders
`deploy/.env.example` actually ships were not among them. The list named
`change-me-to-a-long-random-string-min-32-bytes`; the file ships
`change-me-to-a-long-random-string-at-least-32-bytes`. Two near-miss variants that
appear nowhere in the repository.

So: copy `.env.example` to `.env`, set `VE_ENV=prod`, leave the secrets alone —
and core booted, signing every token with a string in the public source, with this
function reading as though it had checked. Both placeholders clear the 32-byte
floor, so length did not catch them either.

Every placeholder this repository has ever shipped begins "change-me", so that is
the rule now. `test_whatever_the_env_example_ships_is_refused` reads the FILE
rather than restating it, because restating it is precisely what failed.
"""

from __future__ import annotations

import logging
import pathlib

import pytest

from app.core.api import _enforce_secrets
from app.core.config import Settings

# Both comfortably over the floors, standing in for a real deployment.
REAL_JWT = "0f2c8a1e-a-real-32-plus-character-jwt-secret"
REAL_KEY = "a-real-secrets-key-value"


def _settings(**kw) -> Settings:
    base = {"env": "prod", "jwt_secret": REAL_JWT, "secrets_key": REAL_KEY}
    base.update(kw)
    return Settings(**base)


@pytest.mark.parametrize("env", ["prod", "production", "staging", "appliance"])
def test_a_placeholder_refuses_to_boot_outside_dev(env):
    with pytest.raises(RuntimeError) as caught:
        _enforce_secrets(_settings(env=env, jwt_secret="change-me-in-prod"),
                         logging.getLogger("t"))
    assert "VE_JWT_SECRET" in str(caught.value)


@pytest.mark.parametrize("value", ["", "short", "hunter2", "x" * 31])
def test_a_short_jwt_secret_refuses_to_boot(value):
    """RFC 7518 §3.2: an HS256 key must be at least as long as the hash output.
    PyJWT warns below 32 bytes and signs anyway, so nothing downstream refuses."""
    with pytest.raises(RuntimeError) as caught:
        _enforce_secrets(_settings(jwt_secret=value), logging.getLogger("t"))
    assert "VE_JWT_SECRET" in str(caught.value)


def test_exactly_the_floor_is_accepted():
    """An off-by-one would refuse a perfectly good 32-character secret."""
    _enforce_secrets(_settings(jwt_secret="x" * 32), logging.getLogger("t"))


@pytest.mark.parametrize("value", ["", "short"])
def test_a_short_secrets_key_refuses_to_boot(value):
    with pytest.raises(RuntimeError) as caught:
        _enforce_secrets(_settings(secrets_key=value), logging.getLogger("t"))
    assert "VE_SECRETS_KEY" in str(caught.value)


def test_the_refusal_names_only_what_is_wrong(caplog):
    """So an operator fixes the secret that is actually broken."""
    with pytest.raises(RuntimeError) as caught:
        _enforce_secrets(_settings(secrets_key="change-me-secret"),
                         logging.getLogger("t"))
    message = str(caught.value)
    assert "VE_SECRETS_KEY" in message
    assert "VE_JWT_SECRET" not in message


def test_dev_warns_instead_of_refusing(caplog):
    """A developer running core by hand should not have to mint secrets first,
    and they are not protecting anything."""
    log = logging.getLogger("core.boot.guard.test")
    with caplog.at_level(logging.WARNING, logger=log.name):
        _enforce_secrets(_settings(env="dev", jwt_secret="change-me-in-prod"), log)
    assert "DEFAULT secrets" in " ".join(r.getMessage() for r in caplog.records)


def test_real_secrets_boot_quietly(caplog):
    """Otherwise the guard is an outage and the warning is noise."""
    log = logging.getLogger("core.boot.guard.test2")
    with caplog.at_level(logging.WARNING, logger=log.name):
        _enforce_secrets(_settings(), log)
    assert not caplog.records


# ── the one that would have caught it ────────────────────────────────────────

def _shipped_placeholders() -> dict[str, str]:
    """The secret values `deploy/.env.example` actually ships, read from the file."""
    import os

    root = pathlib.Path(os.environ.get("VE_REPO_ROOT", "/repo"))
    example = root / "deploy" / ".env.example"
    if not example.is_file():
        example = pathlib.Path(__file__).resolve().parents[3] / "deploy/.env.example"
    if not example.is_file():
        return {}
    found = {}
    for line in example.read_text().splitlines():
        line = line.strip()
        for key in ("VE_JWT_SECRET", "VE_SECRETS_KEY"):
            if line.startswith(f"{key}="):
                found[key] = line.split("=", 1)[1].strip()
    return found


def test_whatever_the_env_example_ships_is_refused():
    """Derived from the FILE, so editing the example without editing the guard
    fails here instead of in production."""
    shipped = _shipped_placeholders()
    if not shipped:
        pytest.skip("deploy/.env.example is not on this tree")
    assert set(shipped) == {"VE_JWT_SECRET", "VE_SECRETS_KEY"}, shipped

    field = {"VE_JWT_SECRET": "jwt_secret", "VE_SECRETS_KEY": "secrets_key"}
    for key, value in shipped.items():
        with pytest.raises(RuntimeError) as caught:
            _enforce_secrets(_settings(**{field[key]: value}), logging.getLogger("t"))
        assert key in str(caught.value), f"{key}={value!r} was accepted"
