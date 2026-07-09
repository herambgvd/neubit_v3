"""Tamper-evident export signing (P6-B) — SHA-256 + Ed25519 manifest.

After the export worker builds the mp4, this module makes the clip **court-admissible**:
it computes the file's SHA-256, wraps the clip's provenance (camera / range / who /
when / tenant) into a canonical **manifest**, **Ed25519-signs** that manifest, and writes
a ``<job>.manifest.json`` sidecar next to the mp4. A ``verify`` path re-hashes the file +
re-verifies the signature so a downstream auditor can prove the clip was not altered.

Key management (documented — this is the production hinge)
─────────────────────────────────────────────────────────
The signing key is an **Ed25519 keypair**. It is resolved (lazily, cached) in priority:

  1. ``VE_EXPORT_SIGNING_KEY`` — a PEM-encoded Ed25519 **private key** (PKCS#8). This is
     the PRODUCTION path: generate one per appliance/tenant with
     ``openssl genpkey -algorithm ed25519`` (or ``generate_keypair_pem`` below), store the
     PEM in the platform's secret store / a mounted secret file, and set the env from it.
     The matching public key is published (``GET .../export/public-key`` + embedded in
     every manifest's ``public_key`` field) so any third party can verify offline.
  2. **Derived dev key** — if no env key is set, a keypair is *deterministically derived*
     from the kernel ``jwt_secret`` (HKDF-SHA256 → Ed25519 seed). This keeps signed export
     working out-of-the-box in dev/test/CI (and single-appliance installs that already trust
     the jwt secret) WITHOUT a plaintext private key on disk. It is NOT recommended for
     multi-tenant production — rotating the jwt secret rotates the export key, and anyone
     who can read the jwt secret can forge a signature. Set ``VE_EXPORT_SIGNING_KEY`` in
     production. The ``key_id`` embedded in the manifest records which key signed it.

The core already ships Ed25519 for licensing (``core/app/core/license.py``, EdDSA JWT via
``cryptography``); we use the same ``cryptography`` primitive here for the export keypair
rather than reusing the *licensing* key (that key signs licenses, not evidence — separate
concerns, separate rotation). ``cryptography`` is pinned as a vision runtime dep.

Manifest shape (signed bytes = the canonical JSON of ``manifest`` WITHOUT the signature)::

    {
      "manifest": {
        "version": 1,
        "file_name": "…​.mp4",
        "file_hash": "sha256:<hex>",
        "camera_id": "…", "tenant_id": "…"|null,
        "from": "…ISO8601…", "to": "…", "duration_sec": 4.0,
        "format": "mp4", "watermark": false,
        "exported_by": "…user…"|null, "exported_at": "…ISO8601…",
        "job_id": "…", "chain": [ ... optional prior-manifest hashes ... ]
      },
      "signature": "<base64 ed25519 sig over canonical(manifest)>",
      "algorithm": "Ed25519",
      "key_id": "<sha256[:16] of the public key>",
      "public_key": "<PEM of the Ed25519 public key>"
    }

Everything degrades gracefully: if ``cryptography`` is somehow unavailable the worker still
produces the mp4 and writes an UNSIGNED manifest (hash only) with ``algorithm="none"`` —
verify then reports ``valid=false, reason="unsigned"`` rather than crashing the export.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import os
from datetime import datetime, timezone
from functools import lru_cache
from typing import Any

log = logging.getLogger("vision.export.signing")

MANIFEST_VERSION = 1
_ENV_KEY = "VE_EXPORT_SIGNING_KEY"
_CHUNK = 1024 * 1024  # 1 MiB streaming hash


# ── SHA-256 (streaming) ──────────────────────────────────────────────────────────
def sha256_file(path: str) -> str:
    """Streaming SHA-256 of a file → lower-case hex (never loads the whole clip)."""
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(_CHUNK), b""):
            h.update(chunk)
    return h.hexdigest()


# ── key management ───────────────────────────────────────────────────────────────
def _hkdf_ed25519_seed() -> bytes:
    """Derive a 32-byte Ed25519 seed from the kernel jwt secret (dev fallback).

    HKDF-Extract+Expand (SHA-256) with a fixed, domain-separated info string so the
    export key is distinct from any other jwt-secret-derived key in the platform.
    """
    from kernel.config import get_settings

    ikm = get_settings().jwt_secret.encode("utf-8")
    salt = b"neubit-vision-export-signing/v1"
    prk = hmac.new(salt, ikm, hashlib.sha256).digest()
    # Expand one block (32 bytes is exactly one SHA-256 output → T(1)).
    okm = hmac.new(prk, b"ed25519-seed" + b"\x01", hashlib.sha256).digest()
    return okm[:32]


class _Signer:
    """Loaded Ed25519 keypair + its published metadata. Immutable, cached process-wide."""

    def __init__(self, private_key, *, source: str) -> None:
        self._private_key = private_key
        self.source = source  # "env" | "derived"
        from cryptography.hazmat.primitives import serialization

        pub = private_key.public_key()
        self.public_pem = pub.public_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PublicFormat.SubjectPublicKeyInfo,
        ).decode("utf-8")
        self.key_id = hashlib.sha256(self.public_pem.encode("utf-8")).hexdigest()[:16]

    def sign(self, data: bytes) -> str:
        return base64.b64encode(self._private_key.sign(data)).decode("ascii")


@lru_cache(maxsize=1)
def _load_signer() -> "_Signer | None":
    """Resolve the Ed25519 signer (env PEM → derived dev key). None if crypto absent."""
    try:
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    except Exception as exc:  # noqa: BLE001 — crypto missing → unsigned manifests
        log.warning("cryptography unavailable — exports will be UNSIGNED (%s)", exc)
        return None

    pem = (os.getenv(_ENV_KEY) or "").strip()
    if pem:
        try:
            key = serialization.load_pem_private_key(pem.encode("utf-8"), password=None)
            if not isinstance(key, Ed25519PrivateKey):
                raise TypeError("VE_EXPORT_SIGNING_KEY is not an Ed25519 private key")
            log.info("export signing key loaded from %s (key_id via env)", _ENV_KEY)
            return _Signer(key, source="env")
        except Exception as exc:  # noqa: BLE001 — bad env key → fall back, don't crash
            log.warning("invalid %s (%s) — falling back to derived key", _ENV_KEY, exc)

    key = Ed25519PrivateKey.from_private_bytes(_hkdf_ed25519_seed())
    log.info("export signing key DERIVED from jwt secret (dev/single-appliance; set %s in prod)", _ENV_KEY)
    return _Signer(key, source="derived")


def signer_public_pem() -> str | None:
    """The current signer's public key PEM (for the ``/export/public-key`` endpoint)."""
    s = _load_signer()
    return s.public_pem if s else None


def signer_key_id() -> str | None:
    s = _load_signer()
    return s.key_id if s else None


def reset_signer_cache() -> None:
    """Drop the cached signer (tests that swap ``VE_EXPORT_SIGNING_KEY``/jwt secret)."""
    _load_signer.cache_clear()


# ── manifest build / sign ────────────────────────────────────────────────────────
def _canonical(manifest: dict[str, Any]) -> bytes:
    """Deterministic bytes for signing/verifying: sorted-key, compact JSON."""
    return json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _iso(dt: datetime | None) -> str | None:
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat()


def build_manifest(
    *,
    file_name: str,
    file_hash: str,
    camera_id: str,
    tenant_id: str | None,
    from_: datetime,
    to: datetime,
    duration_sec: float,
    fmt: str,
    watermark: bool,
    exported_by: str | None,
    exported_at: datetime | None,
    job_id: str,
    chain: list | None = None,
) -> dict[str, Any]:
    """Assemble the canonical (unsigned) manifest dict (the thing that gets signed)."""
    return {
        "version": MANIFEST_VERSION,
        "file_name": file_name,
        "file_hash": f"sha256:{file_hash}",
        "camera_id": camera_id,
        "tenant_id": str(tenant_id) if tenant_id else None,
        "from": _iso(from_),
        "to": _iso(to),
        "duration_sec": round(float(duration_sec), 3),
        "format": fmt or "mp4",
        "watermark": bool(watermark),
        "exported_by": exported_by,
        "exported_at": _iso(exported_at or datetime.now(timezone.utc)),
        "job_id": job_id,
        "chain": list(chain or []),
    }


def sign_manifest(manifest: dict[str, Any]) -> dict[str, Any]:
    """Return the SIDECAR dict: ``{manifest, signature, algorithm, key_id, public_key}``.

    If no signer is available the manifest is written UNSIGNED (``algorithm="none"``,
    no signature/public_key) so the pipeline never blocks on a crypto gap.
    """
    signer = _load_signer()
    if signer is None:
        return {"manifest": manifest, "signature": None, "algorithm": "none", "key_id": None, "public_key": None}
    sig = signer.sign(_canonical(manifest))
    return {
        "manifest": manifest,
        "signature": sig,
        "algorithm": "Ed25519",
        "key_id": signer.key_id,
        "public_key": signer.public_pem,
    }


def write_sidecar(sidecar: dict[str, Any], manifest_path: str) -> None:
    """Write the sidecar JSON atomically next to the clip."""
    os.makedirs(os.path.dirname(manifest_path) or ".", exist_ok=True)
    tmp = f"{manifest_path}.tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(sidecar, fh, indent=2, sort_keys=True)
    os.replace(tmp, manifest_path)


# ── verification ─────────────────────────────────────────────────────────────────
def verify_sidecar(sidecar: dict[str, Any], *, file_path: str | None = None,
                   file_hash: str | None = None) -> dict[str, Any]:
    """Verify a sidecar: re-hash the file (or accept a precomputed hash) + check the sig.

    Returns ``{valid: bool, reason: str, manifest: dict}``:
      * ``valid=False, reason="tampered"`` — the file's SHA-256 no longer matches the
        manifest (the clip was altered after signing).
      * ``valid=False, reason="bad-signature"`` — hash matches but the Ed25519 signature
        does not verify against the embedded public key (manifest/sig altered).
      * ``valid=False, reason="unsigned"`` — the sidecar has no signature.
      * ``valid=True,  reason="ok"`` — hash + signature both verify.

    Either ``file_path`` (re-hash it) or ``file_hash`` (already computed) must be given.
    """
    manifest = sidecar.get("manifest") or {}
    claimed = str(manifest.get("file_hash") or "")
    claimed_hex = claimed.split(":", 1)[-1] if claimed else ""

    if file_hash is None:
        if not file_path or not os.path.exists(file_path):
            return {"valid": False, "reason": "file-missing", "manifest": manifest}
        file_hash = sha256_file(file_path)

    if not claimed_hex or file_hash.lower() != claimed_hex.lower():
        return {"valid": False, "reason": "tampered", "manifest": manifest}

    algorithm = sidecar.get("algorithm")
    signature = sidecar.get("signature")
    if algorithm != "Ed25519" or not signature:
        return {"valid": False, "reason": "unsigned", "manifest": manifest}

    pub_pem = sidecar.get("public_key")
    if not pub_pem:
        return {"valid": False, "reason": "no-public-key", "manifest": manifest}

    try:
        from cryptography.exceptions import InvalidSignature
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

        pub = serialization.load_pem_public_key(pub_pem.encode("utf-8"))
        if not isinstance(pub, Ed25519PublicKey):
            return {"valid": False, "reason": "bad-public-key", "manifest": manifest}
        pub.verify(base64.b64decode(signature), _canonical(manifest))
    except InvalidSignature:
        return {"valid": False, "reason": "bad-signature", "manifest": manifest}
    except Exception as exc:  # noqa: BLE001 — any crypto error → not valid, don't crash
        return {"valid": False, "reason": f"verify-error: {exc}", "manifest": manifest}

    return {"valid": True, "reason": "ok", "manifest": manifest}


# ── helper for ops / provisioning ────────────────────────────────────────────────
def generate_keypair_pem() -> tuple[str, str]:
    """Generate a fresh Ed25519 keypair → ``(private_pem, public_pem)`` (PKCS#8/SPKI).

    Convenience for provisioning: run this once per appliance, store the private PEM in
    the secret store, set ``VE_EXPORT_SIGNING_KEY`` from it, publish the public PEM.
    """
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

    key = Ed25519PrivateKey.generate()
    priv = key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode("utf-8")
    pub = key.public_key().public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode("utf-8")
    return priv, pub
