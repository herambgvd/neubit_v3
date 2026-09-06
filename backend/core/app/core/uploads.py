"""Validation for every file a client can upload, in one place.

All three upload routes (avatar, branding logo, site image) call these rules,
because ``GET /files/{key:path}`` is public and an unchecked upload there is
stored XSS on the platform origin.

  * The declared content type must be on the whitelist.
  * The bytes must agree with it — a declared type is the uploader's claim, the
    magic number is the file.
  * The extension comes from the whitelist, never from the filename, so a stored
    key cannot carry ``.html``, ``.php`` or a traversal fragment.
  * The size cap is enforced while reading, not after — see ``read_capped``.

SVG is accepted because logos are SVG, and it is XML that can carry script. The
serving side handles that (core/storage.py): non-raster types go out as
``Content-Disposition: attachment``, and script in an SVG loaded via ``<img src>``
does not execute.
"""

from __future__ import annotations

from typing import Protocol

from .errors import ValidationError

#: Accepted image types → the extension that will be stored for them.
IMAGE_TYPES: dict[str, str] = {
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "image/svg+xml": ".svg",
}

#: Leading bytes that must be present for a declared type to be believed.
#: A tuple of alternatives; an empty tuple means "cannot be sniffed" (SVG, below).
_MAGIC: dict[str, tuple[bytes, ...]] = {
    "image/jpeg": (b"\xff\xd8\xff",),
    "image/jpg": (b"\xff\xd8\xff",),
    "image/png": (b"\x89PNG\r\n\x1a\n",),
    "image/gif": (b"GIF87a", b"GIF89a"),
    "image/webp": (b"RIFF",),  # RIFF....WEBP; the WEBP tag is checked separately
    "image/svg+xml": (),
}

#: 8 MiB, the cap the sites route already used.
MAX_IMAGE_BYTES = 8 * 1024 * 1024

#: Read size per step. Also bounds the overshoot: when the cap trips, at most one
#: chunk past the limit has been read, and it is dropped rather than accumulated.
READ_CHUNK_BYTES = 64 * 1024


class _AsyncReadable(Protocol):
    """What ``read_capped`` needs — Starlette's ``UploadFile`` satisfies it."""

    async def read(self, size: int = -1) -> bytes: ...


async def read_capped(
    file: _AsyncReadable,
    limit: int = MAX_IMAGE_BYTES,
    *,
    field: str = "File",
) -> bytes:
    """Read an upload into memory, refusing it the moment it passes ``limit``.

    Chunked so the process never holds more than ``limit + READ_CHUNK_BYTES``,
    whatever was sent. Measuring after ``await file.read()`` would allocate the
    whole body first, which is the thing the cap exists to prevent.

    Not gated on ``Content-Length``: it is a client hint that can lie or be absent
    under chunked encoding, and FastAPI's multipart parser has already consumed the
    body by the time a route runs, so it would not even save work.
    """
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = await file.read(READ_CHUNK_BYTES)
        if not chunk:
            break
        total += len(chunk)
        if total > limit:
            raise ValidationError(
                f"{field} must be {limit // (1024 * 1024)} MiB or smaller",
                code="FILE_TOO_LARGE",
                status_code=413,
            )
        chunks.append(chunk)
    return b"".join(chunks)


def _looks_like_svg(data: bytes) -> bool:
    """SVG has no magic number, so this is a shape check, not a signature.

    Rejects a non-XML payload sent as image/svg+xml — SVG is the only whitelist
    entry that cannot be sniffed, so it is where arbitrary bytes would be smuggled.
    """
    head = data[:512].lstrip()[:512].lower()
    return head.startswith(b"<?xml") or head.startswith(b"<svg") or b"<svg" in head


def validate_image(data: bytes, content_type: str | None, *, field: str = "File") -> tuple[str, str]:
    """Check an uploaded image and return ``(content_type, extension)``.

    Raises ValidationError: 415 for a bad type, 413 for a large one.
    """
    ctype = (content_type or "").split(";")[0].strip().lower()
    if ctype not in IMAGE_TYPES:
        raise ValidationError(
            f"{field} must be PNG, JPEG, WEBP, GIF or SVG",
            code="UNSUPPORTED_MEDIA_TYPE",
            status_code=415,
        )
    if not data:
        raise ValidationError(f"{field} is empty", code="EMPTY_FILE", status_code=400)
    # A backstop, not the enforcement point — the routes use read_capped(). Kept so
    # validate_image is correct on its own.
    if len(data) > MAX_IMAGE_BYTES:
        raise ValidationError(
            f"{field} must be {MAX_IMAGE_BYTES // (1024 * 1024)} MiB or smaller",
            code="FILE_TOO_LARGE",
            status_code=413,
        )

    signatures = _MAGIC[ctype]
    if ctype == "image/svg+xml":
        ok = _looks_like_svg(data)
    elif ctype == "image/webp":
        ok = data[:4] == b"RIFF" and data[8:12] == b"WEBP"
    else:
        ok = any(data.startswith(sig) for sig in signatures)
    if not ok:
        # Does not name which check failed: the uploader learns it was rejected,
        # not how the sniffing works.
        raise ValidationError(
            f"{field} is not a valid {ctype} image",
            code="UNSUPPORTED_MEDIA_TYPE",
            status_code=415,
        )
    return ctype, IMAGE_TYPES[ctype]
