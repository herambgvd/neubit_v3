"""Symmetric encryption for secrets stored in the DB (SMTP/LDAP/OIDC/TOTP).

Integration credentials are configured from the admin UI, so they live in the
database and must be encrypted at rest. Keys derive from ``VE_SECRETS_KEY``;
rotating that env var re-keys everything.

    token = encrypt_secret_for(tenant_id, "smtp-password")   # store in the DB
    raw   = decrypt_secret_for(tenant_id, token)             # read it back

Tenant-owned secrets use a per-tenant key (the ``*_for`` functions); platform-owned
rows (tenant_id NULL) use the global key.

Stored values are tagged, and the tag decides how a decrypt failure is handled:

  ``enc:v1:<token>``  encrypted here. Fails => raise; that is a rotated key and it
                      must surface as itself, not as a mail-server auth failure.
  ``gAAAAA…``         a bare Fernet token from before the tag. Global key, same rule.
  anything else       never encrypted (a legacy plaintext row). Returned unchanged,
                      so a deploy can still read what it wrote yesterday.

Only that last case is lenient. Do not make the others lenient too.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import uuid

from cryptography.fernet import Fernet, InvalidToken

from .config import get_settings

#: Marks a value this module encrypted. Its presence claims the value is
#: ciphertext; if that turns out to be false, raise rather than shrug.
MARKER = "enc:v1:"

#: Fernet tokens are base64 of a 0x80 version byte, so they always begin with this.
#: Used to recognise rows written before MARKER existed.
_LEGACY_FERNET_PREFIX = "gAAAAA"


class SecretDecryptionError(RuntimeError):
    """A value that claimed to be ciphertext could not be decrypted.

    Almost always `VE_SECRETS_KEY` changed. Raised rather than returned so the
    failure names itself instead of reaching a mail server as a bad password.
    """


def _fernet() -> Fernet:
    """The PLATFORM key: for rows that belong to no tenant, and for blobs."""
    digest = hashlib.sha256(get_settings().secrets_key.encode()).digest()
    return Fernet(base64.urlsafe_b64encode(digest))


def _fernet_for(tenant_id: str | uuid.UUID | None) -> Fernet:
    """A per-tenant Fernet key from the master secret + tenant id, via HMAC-SHA256.

    One tenant's key never decrypts another's data. ``None`` maps to the platform
    key, not to a "None" tenant: a NULL tenant_id is the platform.
    """
    if tenant_id is None:
        return _fernet()
    key = hmac.new(
        get_settings().secrets_key.encode(), f"tenant:{tenant_id}".encode(), hashlib.sha256
    ).digest()
    return Fernet(base64.urlsafe_b64encode(key))


def _decrypt(value: str, cipher: Fernet, *, what: str) -> str:
    """Shared decrypt: honour the tag, refuse to guess."""
    if value.startswith(MARKER):
        try:
            return cipher.decrypt(value[len(MARKER):].encode()).decode()
        except InvalidToken as exc:
            raise SecretDecryptionError(
                f"cannot decrypt {what}: it was encrypted with a different "
                "VE_SECRETS_KEY. Restore the previous key or re-enter the secret."
            ) from exc
    if value.startswith(_LEGACY_FERNET_PREFIX):
        # Written before MARKER existed, always under the platform key.
        try:
            return _fernet().decrypt(value.encode()).decode()
        except InvalidToken as exc:
            raise SecretDecryptionError(
                f"cannot decrypt {what}: it looks like ciphertext from before the "
                "enc:v1 tag but does not decrypt under the current VE_SECRETS_KEY."
            ) from exc
    # Never encrypted. Deployments hold rows written before encryption existed and a
    # deploy that cannot read what it wrote yesterday is an outage.
    return value


def encrypt_secret_for(tenant_id: str | uuid.UUID | None, plaintext: str) -> str:
    """Encrypt a tenant's secret under its OWN key."""
    return MARKER + _fernet_for(tenant_id).encrypt(plaintext.encode()).decode()


def decrypt_secret_for(tenant_id: str | uuid.UUID | None, ciphertext: str) -> str:
    """Decrypt a tenant's secret with its own key."""
    return _decrypt(ciphertext, _fernet_for(tenant_id), what=f"a secret for tenant {tenant_id}")


def encrypt_secret(plaintext: str) -> str:
    """Encrypt under the PLATFORM key. For rows that belong to no tenant."""
    return MARKER + _fernet().encrypt(plaintext.encode()).decode()


def decrypt_secret(ciphertext: str) -> str:
    return _decrypt(ciphertext, _fernet(), what="a platform secret")


def encrypt_bytes(plaintext: bytes) -> bytes:
    """Encrypt a blob (e.g. a biometric face crop) for storage at rest.

    Blobs use the platform key: storage is keyed by object path, not by tenant, so
    `storage._encrypts` cannot resolve a tenant to key from. The per-tenant
    requirement is about the credential path.
    """
    return _fernet().encrypt(plaintext)


def decrypt_bytes(ciphertext: bytes) -> bytes:
    """Decrypt a blob.

    Lenient, unlike the string path: `_encrypts` is a prefix rule, so turning
    encryption on for a path leaves everything already written under it in the
    clear. A wrong answer here is a broken image, not a silent auth failure.
    """
    try:
        return _fernet().decrypt(ciphertext)
    except InvalidToken:
        return ciphertext
