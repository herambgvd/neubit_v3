"""redact_fields must never return a secret.

The walker descended into dicts before checking whether the path was a secret, so
a secret one level deeper than the predicate expected — or one that was not a
string — was walked straight past. redact_fields builds API responses and log
lines, so that returned the credential in the clear with no error and no marker.
"""

from __future__ import annotations

import pytest

from kernel.secrets import (
    ENC_PREFIX,
    SecretDecryptError,
    SecretShapeError,
    decrypt_fields,
    encrypt_fields,
    redact_fields,
)

TENANT = "11111111-1111-1111-1111-111111111111"
OTHER = "22222222-2222-2222-2222-222222222222"


def is_secret(path):
    return bool(path) and path[-1] in {"password", "api_key"}


SHAPES = {
    "flat": {"password": "hunter2"},
    "nested": {"auth": {"password": "hunter2"}},
    "deeper": {"a": {"b": {"password": "hunter2"}}},
    "non_string": {"password": 1234},
    "dict_at_secret_path": {"password": {"v": "hunter2"}},
    "list_of_secrets": {"password": ["hunter2", "hunter3"]},
    "in_a_list_of_dicts": {"items": [{"password": "hunter2"}]},
}


@pytest.mark.parametrize("name", sorted(SHAPES))
def test_no_shape_leaks_through_redaction(name):
    out = str(redact_fields(SHAPES[name], is_secret))
    assert "hunter2" not in out, f"{name} leaked"
    assert "1234" not in out, f"{name} leaked"


def test_the_non_secret_half_survives():
    """Redaction has to stay selective — the host and port are what an operator
    debugs with, and blanking everything would make the response useless."""
    out = redact_fields({"host": "smtp.example", "port": 587, "password": "x"}, is_secret)
    assert out["host"] == "smtp.example"
    assert out["port"] == 587
    assert out["password"] != "x"


def test_encryption_refuses_a_secret_it_cannot_encrypt():
    """Storing it readable is worse than failing. The old walker wrote it through
    silently and nothing complained."""
    with pytest.raises(SecretShapeError):
        encrypt_fields(TENANT, {"password": 1234}, is_secret)
    with pytest.raises(SecretShapeError):
        encrypt_fields(TENANT, {"password": {"v": "hunter2"}}, is_secret)


def test_a_nested_secret_is_actually_encrypted():
    out = encrypt_fields(TENANT, {"auth": {"password": "hunter2"}}, is_secret)
    assert out["auth"]["password"].startswith(ENC_PREFIX)
    assert decrypt_fields(TENANT, out, is_secret)["auth"]["password"] == "hunter2"


def test_a_list_of_secrets_round_trips():
    out = encrypt_fields(TENANT, {"password": ["a", "b"]}, is_secret)
    assert all(v.startswith(ENC_PREFIX) for v in out["password"])
    assert decrypt_fields(TENANT, out, is_secret)["password"] == ["a", "b"]


def test_another_tenants_key_cannot_read_it():
    out = encrypt_fields(TENANT, {"password": "hunter2"}, is_secret)
    with pytest.raises(SecretDecryptError):
        decrypt_fields(OTHER, out, is_secret)


def test_decryption_passes_a_non_string_through():
    """A secret path holding a number is a row written before encryption, not a
    reason to fail a read."""
    assert decrypt_fields(TENANT, {"password": 1234}, is_secret)["password"] == 1234


def test_legacy_plaintext_passes_through_on_read():
    assert decrypt_fields(TENANT, {"password": "plain"}, is_secret)["password"] == "plain"


def test_empty_input_is_returned_unchanged():
    assert redact_fields(None, is_secret) is None
    assert encrypt_fields(TENANT, {}, is_secret) == {}
