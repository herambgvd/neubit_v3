"""Object storage abstraction — one interface, swappable backends.

App code talks to the abstract ``Storage`` interface; ``get_storage()`` picks the
backend from config. Other modules import and rely on this interface:

    storage = get_storage()
    key = await storage.put("logos/acme.png", data, content_type="image/png")
    raw = await storage.get(key)
    ok  = await storage.exists(key)
    href = await storage.url(key)          # a link the browser can fetch
    await storage.delete(key)

A "key" is a logical path within the store (``"crops/2026/07/abc.jpg"``), never an
absolute filesystem path.

  * LocalStorage — files under ``settings.storage_local_dir``; URLs point at this
    app's ``GET /files/{key}`` route (``files_router`` below).
  * S3Storage    — AWS S3 or any S3-compatible store. ``aioboto3`` is imported
    lazily inside methods so it stays an optional dependency.
"""

from __future__ import annotations

import hashlib
import hmac
import os
import time
from abc import ABC, abstractmethod
from functools import lru_cache
from pathlib import Path


from fastapi import APIRouter
from fastapi.responses import FileResponse, Response

from .config import get_settings
from .errors import NotFoundError
from .logging import get_logger

log = get_logger("edge.storage")


def _encrypts(key: str) -> bool:
    """Whether ``key`` falls under a configured encrypt-at-rest media prefix."""
    prefixes = get_settings().encrypt_media_prefixes or []
    k = key.lstrip("/")
    return any(k.startswith(p) for p in prefixes)


def _needs_signature(key: str) -> bool:
    """Whether ``key`` may only be served with a valid, unexpired signature.

    `/files/{key}` has no auth dependency and is routed publicly, which is fine for
    an avatar (unguessable key, loaded from an ``<img>``) and wrong for a report
    export — an unsigned link would outlive the `report.export` check forever.
    """
    prefixes = get_settings().signed_url_prefixes or []
    k = key.lstrip("/")
    return any(k.startswith(p) for p in prefixes)


def _signing_key() -> bytes:
    """A key for URL signatures, derived from but not equal to the secrets key.

    Domain-separated so a leaked signing key does not decrypt stored credentials.
    Rotating `VE_SECRETS_KEY` invalidates outstanding links; they last minutes.
    """
    return hmac.new(
        get_settings().secrets_key.encode(), b"neubit:file-url-signature:v1", hashlib.sha256
    ).digest()


def sign_key(key: str, expires_at: int) -> str:
    """The signature for ``key`` valid until ``expires_at`` (unix seconds)."""
    payload = f"{key.lstrip('/')}\n{expires_at}".encode()
    return hmac.new(_signing_key(), payload, hashlib.sha256).hexdigest()


def signature_is_valid(key: str, exp: str | None, sig: str | None, *, now: float | None = None) -> bool:
    """Whether ``sig`` authorises serving ``key`` right now.

    Uses `hmac.compare_digest`: a plain `==` on a hex digest leaks its prefix
    through timing.
    """
    if not exp or not sig:
        return False
    try:
        expires_at = int(exp)
    except (TypeError, ValueError):
        return False
    if (now if now is not None else time.time()) > expires_at:
        return False
    return hmac.compare_digest(sign_key(key, expires_at), sig)


def _enc(key: str, data: bytes) -> bytes:
    """Encrypt on write if the key is a protected (biometric) media prefix."""
    if _encrypts(key):
        from .secrets import encrypt_bytes

        return encrypt_bytes(data)
    return data


def _dec(key: str, data: bytes) -> bytes:
    """Decrypt on read for protected keys (lenient: legacy plaintext passes through)."""
    if _encrypts(key):
        from .secrets import decrypt_bytes

        return decrypt_bytes(data)
    return data


class StorageError(Exception):
    """Raised for backend-level failures (S3 down, permission denied, etc.).

    Deliberately a plain ``Exception``, not an ``AppError``: infrastructure
    failures should surface as a 500, not a client-facing 4xx.
    """


class Storage(ABC):
    """The abstract blob store. All methods are async so an S3 backend never
    blocks the event loop. ``key`` is always a logical path within the store."""

    @abstractmethod
    async def put(self, key: str, data: bytes, content_type: str | None = None) -> str:
        """Store ``data`` under ``key``; return the key (echoed for convenience)."""

    @abstractmethod
    async def get(self, key: str) -> bytes:
        """Read the blob back. Raise NotFoundError if the key does not exist."""

    @abstractmethod
    async def delete(self, key: str) -> None:
        """Remove the blob. Idempotent — deleting a missing key is not an error."""

    @abstractmethod
    async def exists(self, key: str) -> bool:
        """True if a blob is stored under ``key``."""

    @abstractmethod
    async def url(self, key: str, expires: int = 3600) -> str:
        """Return a URL a browser can GET. For S3 this is a presigned link that
        expires after ``expires`` seconds; for local it is a stable app URL."""


# --- Local filesystem backend ------------------------------------------------
class LocalStorage(Storage):
    """Stores blobs as plain files under ``settings.storage_local_dir``.

    For dev and single-node on-prem. The key becomes a relative path under the
    root: ``put("a/b/c.png", ...)`` writes ``<root>/a/b/c.png``.
    """

    def __init__(self) -> None:
        settings = get_settings()
        # Resolve once so every call shares the same root directory.
        self._root = Path(settings.storage_local_dir)
        self._base_url = settings.storage_base_url

    def _path(self, key: str) -> Path:
        """Map a logical key to an on-disk path, refusing anything that escapes the
        storage root (``"../../etc/passwd"``).
        """
        # Strip any leading slash so the key is always treated as relative.
        safe_key = key.lstrip("/")
        full = (self._root / safe_key).resolve()
        root = self._root.resolve()
        if root != full and root not in full.parents:
            raise StorageError(f"key escapes storage root: {key!r}")
        return full

    async def put(self, key: str, data: bytes, content_type: str | None = None) -> str:
        path = self._path(key)
        # Create the parent directory tree (e.g. crops/2026/07/) if absent.
        path.parent.mkdir(parents=True, exist_ok=True)
        # Sync write is fine on local disk. content_type is inferred at serve time.
        # Protected (biometric) keys are encrypted before hitting disk.
        path.write_bytes(_enc(key, data))
        log.debug("local put %s (%d bytes)", key, len(data))
        return key

    async def get(self, key: str) -> bytes:
        path = self._path(key)
        if not path.is_file():
            raise NotFoundError(f"object not found: {key}")
        return _dec(key, path.read_bytes())

    async def delete(self, key: str) -> None:
        path = self._path(key)
        # Idempotent: missing_ok swallows the "already gone" case.
        path.unlink(missing_ok=True)
        log.debug("local delete %s", key)

    async def exists(self, key: str) -> bool:
        return self._path(key).is_file()

    async def url(self, key: str, expires: int = 3600) -> str:
        """A URL a browser can GET.

        A stable app URL for most keys — the unguessable key is what protects an
        avatar or logo. Keys under `signed_url_prefixes` get an expiry and an HMAC,
        with the TTL from `signed_url_ttl_seconds` rather than this argument's
        generic hour.
        """
        base = f"{self._base_url.rstrip('/')}/{key.lstrip('/')}"
        if not _needs_signature(key):
            return base
        ttl = expires if expires != 3600 else get_settings().signed_url_ttl_seconds
        expires_at = int(time.time()) + int(ttl)
        return f"{base}?exp={expires_at}&sig={sign_key(key, expires_at)}"


# --- S3 / S3-compatible backend ----------------------------------------------
class S3Storage(Storage):
    """Stores blobs in an S3 bucket (AWS, MinIO, RustFS).

    ``aioboto3`` is imported lazily inside each method so it stays optional for
    LocalStorage-only deployments.
    """

    def __init__(self) -> None:
        settings = get_settings()
        self._endpoint = settings.s3_endpoint       # None => real AWS
        self._region = settings.s3_region
        self._bucket = settings.s3_bucket
        self._access_key = settings.s3_access_key
        self._secret_key = settings.s3_secret_key
        if not self._bucket:
            raise StorageError("storage_backend=s3 but VE_S3_BUCKET is not set")
        # Set once the bucket is confirmed, so _ensure_bucket only checks once.
        self._bucket_ready = False

    def _client(self):
        """An aioboto3 S3 client context manager. Imports aioboto3 lazily."""
        try:
            import aioboto3  # optional dependency
        except ImportError as exc:  # pragma: no cover - depends on env
            raise StorageError(
                "S3Storage requires the 'aioboto3' package (pip install aioboto3)"
            ) from exc

        session = aioboto3.Session()
        return session.client(
            "s3",
            endpoint_url=self._endpoint,
            region_name=self._region,
            aws_access_key_id=self._access_key,
            aws_secret_access_key=self._secret_key,
        )

    async def _ensure_bucket(self, s3) -> None:
        """Make sure the target bucket exists, creating it on first miss.

        A process-level flag means the head/create round-trip happens once. This is
        what provisions the bucket on a fresh MinIO/RustFS volume.
        """
        if self._bucket_ready:
            return
        try:
            await s3.head_bucket(Bucket=self._bucket)
        except Exception as exc:  # 404 / NoSuchBucket => create it
            # Only "missing" is create-able; a 403 is a real error.
            msg = str(exc)
            if "404" in msg or "NoSuchBucket" in msg or "Not Found" in msg:
                try:
                    await s3.create_bucket(Bucket=self._bucket)
                    log.info("s3 auto-created bucket %s", self._bucket)
                except Exception as create_exc:  # racing creator, or real failure
                    # Tolerate a concurrent creator winning the race.
                    cmsg = str(create_exc)
                    if "BucketAlreadyOwnedByYou" not in cmsg and "BucketAlreadyExists" not in cmsg:
                        raise StorageError(
                            f"failed to create bucket {self._bucket!r}: {create_exc}"
                        ) from create_exc
            else:
                raise StorageError(f"cannot access bucket {self._bucket!r}: {exc}") from exc
        self._bucket_ready = True

    async def put(self, key: str, data: bytes, content_type: str | None = None) -> str:
        extra = {"ContentType": content_type} if content_type else {}
        async with self._client() as s3:
            await self._ensure_bucket(s3)
            # Protected (biometric) keys are app-encrypted before upload, on top of
            # any bucket-level SSE.
            await s3.put_object(Bucket=self._bucket, Key=key, Body=_enc(key, data), **extra)
        log.debug("s3 put %s (%d bytes)", key, len(data))
        return key

    async def get(self, key: str) -> bytes:
        async with self._client() as s3:
            try:
                resp = await s3.get_object(Bucket=self._bucket, Key=key)
            except Exception as exc:  # botocore ClientError (NoSuchKey) etc.
                if "NoSuchKey" in str(exc) or "404" in str(exc):
                    raise NotFoundError(f"object not found: {key}") from exc
                raise StorageError(str(exc)) from exc
            # get_object returns a streaming body; read it fully into memory.
            async with resp["Body"] as body:
                return await body.read()

    async def delete(self, key: str) -> None:
        async with self._client() as s3:
            # S3 delete_object is already idempotent (no error on missing key).
            await s3.delete_object(Bucket=self._bucket, Key=key)
        log.debug("s3 delete %s", key)

    async def exists(self, key: str) -> bool:
        async with self._client() as s3:
            try:
                await s3.head_object(Bucket=self._bucket, Key=key)
                return True
            except Exception:  # 404 / NoSuchKey => not present
                return False

    async def url(self, key: str, expires: int = 3600) -> str:
        async with self._client() as s3:
            # Presigned: temporary read access with no credentials, valid for
            # ``expires`` seconds.
            return await s3.generate_presigned_url(
                "get_object",
                Params={"Bucket": self._bucket, "Key": key},
                ExpiresIn=expires,
            )


@lru_cache
def get_storage() -> Storage:
    """The configured storage backend, cached. Chosen by ``settings.storage_backend``."""
    backend = get_settings().storage_backend.lower()
    if backend == "s3":
        return S3Storage()
    if backend == "local":
        return LocalStorage()
    raise StorageError(f"unknown storage_backend: {backend!r} (use 'local' or 's3')")


# --- Local file serving route ------------------------------------------------
# Mounted by the app so LocalStorage URLs (``/files/<key>``) resolve. Unused under
# the S3 backend, where URLs point straight at the bucket.
files_router = APIRouter()


@files_router.get("/files/{key:path}")
async def serve_local_file(key: str, exp: str | None = None, sig: str | None = None):
    """Stream a blob stored by the local backend.

    ``{key:path}`` so slashes in the key are captured; 404 if the file is missing.
    Encrypt-at-rest keys are decrypted in memory rather than streamed off disk.
    Keys under `signed_url_prefixes` also require `?exp=&sig=` from
    `LocalStorage.url`, so a report-export link expires instead of outliving the
    `report.export` check.
    """
    if _needs_signature(key) and not signature_is_valid(key, exp, sig):
        # NOT_FOUND, not FORBIDDEN: a 403 would confirm the report exists.
        raise NotFoundError(f"object not found: {key}")
    storage = get_storage()
    # Only meaningful for LocalStorage.
    if not isinstance(storage, LocalStorage):
        raise NotFoundError("local file serving is disabled for this storage backend")
    path = storage._path(key)  # reuse the same escape-safe key→path mapping
    if not path.is_file():
        raise NotFoundError(f"object not found: {key}")
    ctype, headers = _serving_headers(key)
    if _encrypts(key):
        # Decrypt in memory; never hand the browser the ciphertext.
        data = _dec(key, path.read_bytes())
        return Response(content=data, media_type=ctype, headers=headers)
    return FileResponse(os.fspath(path), media_type=ctype, headers=headers)


#: Types this route renders inline. Raster images only — they cannot carry script.
_INLINE_TYPES: dict[str, str] = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
}

#: Served but never rendered inline: SVG is scriptable XML and PDF has its own
#: script surface. `<img src>` still displays an SVG served this way, and script in
#: an SVG loaded as an image does not execute.
_ATTACH_TYPES: dict[str, str] = {
    ".svg": "image/svg+xml",
    ".pdf": "application/pdf",
    ".csv": "text/csv",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
}


def _serving_headers(key: str) -> tuple[str, dict[str, str]]:
    """Decide the Content-Type and disposition for a stored key.

    The type comes from an extension whitelist, not ``mimetypes.guess_type``:
    guess_type will answer text/html, and this route is public. Uploads are
    validated too (core/uploads.py), but files also arrive from report exports.
    Anything not on either list is served as an opaque download.
    """
    ext = os.path.splitext(key)[1].lower()
    if ext in _INLINE_TYPES:
        return _INLINE_TYPES[ext], {}
    ctype = _ATTACH_TYPES.get(ext, "application/octet-stream")
    name = os.path.basename(key).replace('"', "") or "download"
    return ctype, {"Content-Disposition": f'attachment; filename="{name}"'}
