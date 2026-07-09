"""Storage backend helpers — filesystem + S3 (P3-B).

Thin, dependency-graceful adapters the storage service + retention/tiering worker use
to touch bytes:

  * ``sha256_file`` — stream a file → SHA-256 hex (bounded memory).
  * ``LocalBackend`` — stat/exists/delete for local + mounted (nfs/smb) pools.
  * ``S3Backend``    — head/put/delete/exists against an S3-compatible endpoint
    (MinIO in dev). ``boto3`` is imported LAZILY; if the wheel is absent the backend
    degrades to a clean ``S3Unavailable`` (never an ImportError at import time), so
    the service + worker keep running and just skip the S3 path.

All operations run in a thread (``asyncio.to_thread``) since ``boto3`` + file IO are
blocking — the async worker/endpoints never block the event loop.
"""

from __future__ import annotations

import asyncio
import hashlib
import os

from app.vms.common.crypto import decrypt_secret

_CHUNK = 1024 * 1024  # 1 MiB streaming read for checksums


class S3Unavailable(RuntimeError):
    """boto3 missing / endpoint unreachable / bucket op failed — caller skips gracefully."""


# ── checksums ────────────────────────────────────────────────────────────────
def _sha256_file_sync(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        while True:
            chunk = fh.read(_CHUNK)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


async def sha256_file(path: str) -> str:
    """Stream ``path`` → SHA-256 hex. Raises ``FileNotFoundError`` if missing."""
    return await asyncio.to_thread(_sha256_file_sync, path)


# ── local / mounted filesystem ───────────────────────────────────────────────
class LocalBackend:
    """Filesystem ops for local / nfs / smb pools (the mount is a plain dir)."""

    @staticmethod
    async def exists(path: str) -> bool:
        return await asyncio.to_thread(os.path.isfile, path)

    @staticmethod
    async def exists_dir(path: str) -> bool:
        return await asyncio.to_thread(os.path.isdir, path)

    @staticmethod
    async def size(path: str) -> int | None:
        def _stat() -> int | None:
            try:
                return os.path.getsize(path)
            except OSError:
                return None

        return await asyncio.to_thread(_stat)

    @staticmethod
    async def delete(path: str) -> bool:
        """Best-effort unlink. Returns True if the file is gone afterwards."""

        def _unlink() -> bool:
            try:
                os.remove(path)
            except FileNotFoundError:
                return True  # already gone → success
            except OSError:
                return False
            return True

        return await asyncio.to_thread(_unlink)


# ── S3 / MinIO ───────────────────────────────────────────────────────────────
class S3Backend:
    """S3-compatible object ops (MinIO in dev). boto3 is imported lazily."""

    def __init__(self, pool) -> None:
        # ``pool`` is a StoragePool ORM row with the s3_* fields.
        self.endpoint = pool.s3_endpoint
        self.bucket = pool.s3_bucket
        self.region = pool.s3_region or "us-east-1"
        self.access_key = pool.s3_access_key
        self.secret_key = decrypt_secret(pool.s3_enc_secret_key)
        self.use_ssl = bool(pool.s3_use_ssl)
        self.prefix = (pool.path or "").strip("/")

    def _client(self):
        try:
            import boto3  # lazy — the wheel may be absent in a minimal image
            from botocore.config import Config
        except ImportError as exc:  # pragma: no cover — depends on image contents
            raise S3Unavailable(f"boto3 not installed: {exc}") from exc
        return boto3.client(
            "s3",
            endpoint_url=self.endpoint,
            aws_access_key_id=self.access_key,
            aws_secret_access_key=self.secret_key,
            region_name=self.region,
            use_ssl=self.use_ssl,
            config=Config(signature_version="s3v4", s3={"addressing_style": "path"}),
        )

    def _key_for(self, rel_path: str) -> str:
        rel = rel_path.lstrip("/")
        return f"{self.prefix}/{rel}" if self.prefix else rel

    async def ensure_bucket(self) -> None:
        """Create the bucket if it does not exist (idempotent). Raises S3Unavailable."""

        def _ensure() -> None:
            from botocore.exceptions import ClientError

            client = self._client()
            try:
                client.head_bucket(Bucket=self.bucket)
                return
            except ClientError:
                pass
            try:
                client.create_bucket(Bucket=self.bucket)
            except ClientError as exc:  # already-owned/exists races are fine
                code = exc.response.get("Error", {}).get("Code", "")
                if code not in ("BucketAlreadyOwnedByYou", "BucketAlreadyExists"):
                    raise S3Unavailable(f"create_bucket failed: {exc}") from exc

        try:
            await asyncio.to_thread(_ensure)
        except S3Unavailable:
            raise
        except Exception as exc:  # noqa: BLE001 — network/auth → uniform S3Unavailable
            raise S3Unavailable(str(exc)) from exc

    async def head(self) -> bool:
        """Lightweight reachability probe: HEAD the bucket. False on any failure."""

        def _head() -> bool:
            try:
                self._client().head_bucket(Bucket=self.bucket)
                return True
            except Exception:  # noqa: BLE001
                return False

        try:
            return await asyncio.to_thread(_head)
        except S3Unavailable:
            return False

    async def put_file(self, local_path: str, rel_path: str) -> str:
        """Upload ``local_path`` under the pool prefix; returns the object key."""

        key = self._key_for(rel_path)

        def _put() -> None:
            self._client().upload_file(local_path, self.bucket, key)

        try:
            await asyncio.to_thread(_put)
        except S3Unavailable:
            raise
        except Exception as exc:  # noqa: BLE001
            raise S3Unavailable(f"upload failed: {exc}") from exc
        return key

    async def object_exists(self, key: str) -> bool:
        def _head() -> bool:
            try:
                self._client().head_object(Bucket=self.bucket, Key=key)
                return True
            except Exception:  # noqa: BLE001
                return False

        try:
            return await asyncio.to_thread(_head)
        except S3Unavailable:
            return False

    async def delete_object(self, key: str) -> bool:
        def _del() -> bool:
            try:
                self._client().delete_object(Bucket=self.bucket, Key=key)
                return True
            except Exception:  # noqa: BLE001
                return False

        try:
            return await asyncio.to_thread(_del)
        except S3Unavailable:
            return False
