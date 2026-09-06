"""A placeholder secret must not reach production silently.

jwt_secret and secrets_key ship with defaults that are in the repository. There
was no guard, so a service started without the env file accepted forgeable tokens
and encrypted credentials under a key anyone could derive — and said nothing,
because pydantic-settings uses the default happily.
"""

from __future__ import annotations

import logging

import pytest

from kernel import config


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
    monkeypatch.setenv("VE_JWT_SECRET", "a-real-secret-value")
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
    monkeypatch.setenv("VE_JWT_SECRET", "a-real-secret-value")
    monkeypatch.setenv("VE_SECRETS_KEY", "another-real-value")
    with caplog.at_level(logging.WARNING, logger="kernel.config"):
        assert config.get_settings().jwt_secret == "a-real-secret-value"
    assert not caplog.records
