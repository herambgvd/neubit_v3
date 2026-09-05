"""Symmetric encryption for secrets stored in the DB (SMTP/LDAP/OIDC/TOTP).

Integration credentials are configured from the admin UI, not from `.env`, so they
live in the database — and at rest they must be encrypted. Keys are derived from
``VE_SECRETS_KEY``; rotating that env var re-keys everything.

    token = encrypt_secret_for(tenant_id, "smtp-password")   # store in the DB
    raw   = decrypt_secret_for(tenant_id, token)             # read it back

TWO THINGS HERE ARE LOAD-BEARING AND WERE NOT.

1. THE PER-TENANT KEY IS NOW ACTUALLY USED.
   `_fernet_for` has existed since the multi-tenancy work with a docstring calling
   it "the STQC per-tenant-key / data-residency requirement". It had ZERO production
   callers: every real write went through the global `encrypt_secret`, so the
   control the docstring described was not in force and a reviewer reading that
   docstring would have concluded otherwise. A declared-but-unenforced control is
   worse than an absent one. Every tenant-owned secret now goes through the
   `*_for` functions; platform-owned rows (tenant_id NULL) keep the global key,
   which is what they are.

   The test that should have caught it could not: it asserted
   `decrypt_secret_for(tenant_b, cipher) != "smtp-password"`, which passed BECAUSE
   of the swallowed-InvalidToken bug below — the function returned the ciphertext
   unchanged, and ciphertext != plaintext. It would have passed against an
   implementation with no key separation whatsoever.

2. A FAILED DECRYPT NO LONGER RETURNS THE CIPHERTEXT.
   Every decrypt here caught `InvalidToken` and returned its input verbatim, with no
   log and no counter. Two failures hid behind that:

     * a row that was never encrypted stayed plaintext forever, undetected;
     * after a `VE_SECRETS_KEY` rotation, the CIPHERTEXT was handed to the SMTP
       server as the password, and the log said "authentication failed".

   So stored values are now tagged, and the tag decides:

     ``enc:v1:<token>``  — encrypted by this module. Fails to decrypt => RAISE.
                           That is an operator who rotated the key, and it must
                           surface as itself, not as a mysterious auth failure.
     ``gAAAAA…``         — a bare Fernet token from before the tag existed.
                           Decrypted with the GLOBAL key; fails => RAISE, same
                           reasoning.
     anything else       — never encrypted (a legacy plaintext row). Returned
                           unchanged, because a deploy that cannot read what it
                           wrote yesterday is an outage.

   The leniency is only for the third case, and only that case, which is the
   difference between a migration aid and a bug. Same rule, and the same reasoning,
   as `kernel/secrets.py` in the workflow service (43ff0f5).
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import uuid

from cryptography.fernet import Fernet, InvalidToken

from .config import get_settings

#: Marks a value this module encrypted. Its presence is a CLAIM that the value is
#: ciphertext, and a claim that turns out to be false is an error, never a shrug.
MARKER = "enc:v1:"

#: Fernet tokens are base64 of a 0x80 version byte, so they always begin with this.
#: Used to recognise rows written before MARKER existed.
_LEGACY_FERNET_PREFIX = "gAAAAA"


class SecretDecryptionError(RuntimeError):
    """A value that claimed to be ciphertext could not be decrypted.

    Almost always `VE_SECRETS_KEY` changed. Raised rather than returned so the
    failure names itself instead of arriving at a mail server as a bad password.
    """


def _fernet() -> Fernet:
    """The PLATFORM key: for rows that belong to no tenant, and for blobs."""
    digest = hashlib.sha256(get_settings().secrets_key.encode()).digest()
    return Fernet(base64.urlsafe_b64encode(digest))


def _fernet_for(tenant_id: str | uuid.UUID | None) -> Fernet:
    """A per-tenant Fernet key from the master secret + tenant id, via HMAC-SHA256.

    One tenant's key never decrypts another's data. ``None`` means a platform-owned
    row and deliberately maps to the platform key rather than to a "None" tenant —
    a NULL tenant_id is the platform, not a tenant that happens to be unnamed, and
    conflating them is the mistake `scope.owns()` made (36a7798).
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

    Blobs stay on the platform key: the storage layer is keyed by object path, not
    by tenant, and a per-tenant blob key needs the tenant to be resolvable from the
    key — which `storage._encrypts` cannot do today. Written down rather than left
    as an oversight; the credential path is what the per-tenant requirement is about.
    """
    return _fernet().encrypt(plaintext)


def decrypt_bytes(ciphertext: bytes) -> bytes:
    """Decrypt a blob.

    Unlike the string path this stays lenient, and for a reason that does not apply
    there: `_encrypts` is a PREFIX rule, so turning encryption on for a path leaves
    every object already written under it unencrypted, and those are images being
    served to a browser rather than credentials being handed to a mail server. A
    wrong answer here is a broken image, not a silent auth failure.
    """
    try:
        return _fernet().decrypt(ciphertext)
    except InvalidToken:
        return ciphertext
