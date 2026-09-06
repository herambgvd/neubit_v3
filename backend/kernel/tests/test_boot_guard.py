"""A weak secret must not reach production silently.

jwt_secret and secrets_key ship with defaults that are in the repository. There
was no guard, so a service started without the env file accepted forgeable tokens
and encrypted credentials under a key anyone could derive — and said nothing,
because pydantic-settings uses the default happily.

The guard then only refused two EXACT strings, which left it weaker than the one
in core (core/app/core/api.py::_enforce_secrets) — the wrong way round. Core mints
the tokens and already refused a short or empty secret; the six satellites verify
them and would have accepted anything that was not literally "change-me-in-prod".
`VE_JWT_SECRET=""` is the case that matters: an unset env var reaches pydantic as
the empty string, core would have refused to start, and every satellite would have
carried on verifying tokens signed with an empty HMAC key.

The two are kept in step, floors included.
"""

from __future__ import annotations

import logging

import pytest

from kernel import config

# Both comfortably over the floors, so these stand in for a real deployment.
REAL_JWT = "0f2c8a1e-a-real-32-plus-character-jwt-secret"
REAL_KEY = "a-real-secrets-key-value"


@pytest.fixture(autouse=True)
def fresh_settings():
    config.get_settings.cache_clear()
    yield
    config.get_settings.cache_clear()


@pytest.mark.parametrize("env", ["prod", "production", "staging", "appliance"])
def test_a_placeholder_secret_refuses_to_boot_outside_dev(monkeypatch, env):
    monkeypatch.setenv("VE_ENV", env)
    monkeypatch.setenv("VE_JWT_SECRET", "change-me-in-prod")
    monkeypatch.setenv("VE_SECRETS_KEY", "change-me-secret")
    with pytest.raises(RuntimeError) as caught:
        config.get_settings()
    assert "VE_JWT_SECRET" in str(caught.value)


def test_the_refusal_names_only_the_ones_left(monkeypatch):
    """So an operator fixes what is actually wrong."""
    monkeypatch.setenv("VE_ENV", "prod")
    monkeypatch.setenv("VE_JWT_SECRET", REAL_JWT)
    monkeypatch.setenv("VE_SECRETS_KEY", "change-me-secret")
    with pytest.raises(RuntimeError) as caught:
        config.get_settings()
    message = str(caught.value)
    assert "VE_SECRETS_KEY" in message
    assert "VE_JWT_SECRET" not in message


def test_dev_warns_instead_of_refusing(monkeypatch, caplog):
    """A developer running one service by hand should not have to set up secrets
    first, and they are not protecting anything."""
    monkeypatch.setenv("VE_ENV", "dev")
    monkeypatch.setenv("VE_JWT_SECRET", "change-me-in-prod")
    monkeypatch.setenv("VE_SECRETS_KEY", "change-me-secret")
    with caplog.at_level(logging.WARNING, logger="kernel.config"):
        settings = config.get_settings()
    assert settings.env == "dev"
    assert "placeholder" in " ".join(r.getMessage() for r in caplog.records)


def test_real_secrets_boot_anywhere_quietly(monkeypatch, caplog):
    """Otherwise the guard is an outage, and the warning is noise."""
    monkeypatch.setenv("VE_ENV", "prod")
    monkeypatch.setenv("VE_JWT_SECRET", REAL_JWT)
    monkeypatch.setenv("VE_SECRETS_KEY", REAL_KEY)
    with caplog.at_level(logging.WARNING, logger="kernel.config"):
        assert config.get_settings().jwt_secret == REAL_JWT
    assert not caplog.records


# ── the floors ───────────────────────────────────────────────────────────────

@pytest.mark.parametrize(
    "value",
    ["", "short", "hunter2", "x" * 31],
)
def test_a_short_jwt_secret_refuses_to_boot_outside_dev(monkeypatch, value):
    """RFC 7518 §3.2: an HS256 key must be at least as long as the hash output.
    PyJWT warns below 32 bytes and signs anyway, so nothing downstream refuses —
    which is precisely why this has to."""
    monkeypatch.setenv("VE_ENV", "prod")
    monkeypatch.setenv("VE_JWT_SECRET", value)
    monkeypatch.setenv("VE_SECRETS_KEY", REAL_KEY)
    with pytest.raises(RuntimeError) as caught:
        config.get_settings()
    assert "VE_JWT_SECRET" in str(caught.value)


def test_exactly_the_floor_is_accepted(monkeypatch):
    """An off-by-one here would refuse a perfectly good secret at 32."""
    monkeypatch.setenv("VE_ENV", "prod")
    monkeypatch.setenv("VE_JWT_SECRET", "x" * 32)
    monkeypatch.setenv("VE_SECRETS_KEY", REAL_KEY)
    assert config.get_settings().jwt_secret == "x" * 32


@pytest.mark.parametrize("value", ["", "short"])
def test_a_short_secrets_key_refuses_to_boot_outside_dev(monkeypatch, value):
    monkeypatch.setenv("VE_ENV", "prod")
    monkeypatch.setenv("VE_JWT_SECRET", REAL_JWT)
    monkeypatch.setenv("VE_SECRETS_KEY", value)
    with pytest.raises(RuntimeError) as caught:
        config.get_settings()
    assert "VE_SECRETS_KEY" in str(caught.value)


@pytest.mark.parametrize(
    "value",
    [
        "change-me-to-a-long-random-string-min-32-bytes",
        "change-me-another-long-random-string",
    ],
)
def test_the_env_example_placeholders_are_refused_too(monkeypatch, value):
    """These are long enough to clear the floor, so only naming them catches them.
    They are in .env.example, which is where a hurried deployment copies from."""
    monkeypatch.setenv("VE_ENV", "prod")
    monkeypatch.setenv("VE_JWT_SECRET", value)
    monkeypatch.setenv("VE_SECRETS_KEY", REAL_KEY)
    with pytest.raises(RuntimeError):
        config.get_settings()


def test_the_kernel_and_core_agree_on_what_is_weak():
    """Two guards over one secret, in two files, with nothing keeping them level.
    They diverged once and the weaker one was on the six services that VERIFY."""
    import pathlib
    import re

    api = pathlib.Path("/src/core/app/core/api.py")
    if not api.is_file():
        api = pathlib.Path(__file__).resolve().parents[2] / "core/app/core/api.py"
    if not api.is_file():
        pytest.skip("core is not on this tree")
    text = api.read_text()

    block = re.search(r"_WEAK_SECRETS = \{(.*?)\}", text, re.S)
    assert block, "core's _WEAK_SECRETS moved — check this comparison still means something"
    core_weak = set(re.findall(r'"([^"]*)"', block.group(1)))
    assert core_weak <= config._WEAK_SECRETS, (
        f"core refuses secrets the kernel accepts: {sorted(core_weak - config._WEAK_SECRETS)}"
    )
    assert f"len(settings.jwt_secret) < {config._MIN_JWT_SECRET}" in text, (
        "core's jwt_secret floor no longer matches the kernel's"
    )
    assert f'_PLACEHOLDER_MARKER = "{config._PLACEHOLDER_MARKER}"' in text, (
        "core no longer refuses placeholders by the same marker the kernel uses"
    )


def _shipped_placeholders() -> dict[str, str]:
    """The secret values `deploy/.env.example` actually ships, read from the file."""
    import os
    import pathlib

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


def test_whatever_the_env_example_ships_is_refused(monkeypatch):
    """Read from the FILE, not restated here — because restating it is what failed.

    The hardcoded list named `change-me-to-a-long-random-string-min-32-bytes` and
    `change-me-another-long-random-string`. The file ships
    `change-me-to-a-long-random-string-at-least-32-bytes` and
    `change-me-to-another-long-random-string`. Neither shipped value was in either
    guard, so copying the example, setting VE_ENV=prod and leaving the secrets
    alone booted the whole estate on a string that is in the repository — and both
    guards read as though they had checked.

    Deriving the list from the file means editing the example without editing the
    guard fails here instead of in production.
    """
    shipped = _shipped_placeholders()
    if not shipped:
        pytest.skip("deploy/.env.example is not on this tree")
    assert "VE_JWT_SECRET" in shipped and "VE_SECRETS_KEY" in shipped, shipped

    for key, value in shipped.items():
        monkeypatch.setenv("VE_ENV", "prod")
        monkeypatch.setenv("VE_JWT_SECRET", REAL_JWT)
        monkeypatch.setenv("VE_SECRETS_KEY", REAL_KEY)
        monkeypatch.setenv(key, value)
        config.get_settings.cache_clear()
        with pytest.raises(RuntimeError) as caught:
            config.get_settings()
        assert key in str(caught.value), f"{key}={value!r} was accepted"
