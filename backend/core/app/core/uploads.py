"""Validation for every file a client can upload, in one place.

Core accepts uploads on three routes and each of them was written separately:

  * ``POST /auth/me/avatar``   — any authenticated user, no type check, no size cap,
    and the stored extension came from ``os.path.splitext(file.filename)``, which is
    attacker-controlled.
  * ``POST /branding/logo``    — same, behind ``branding.manage``.
  * ``POST /sites/{id}/image`` — the one that was right: a content-type whitelist,
    an 8 MiB cap, and the extension taken from the whitelist rather than the name.

The first two combined with ``GET /files/{key:path}`` — which has no auth dependency
at all and is routed publicly by Traefik — to make stored XSS on the platform origin:
upload ``x.html``, get back its URL in the response, send someone the link. Session
cookies and any same-origin data belong to the visitor.

So the rules live here and all three routes call them:

  * The declared content type must be on the whitelist.
  * The BYTES must agree with it. A declared type is a claim by the uploader; the
    magic number is the file. This is the check a pentest actually runs — rename a
    payload to .png and set the header to image/png.
  * The extension is chosen from the whitelist, never read from the filename. The
    stored key therefore cannot carry ``.html``, ``.php`` or a traversal fragment
    no matter what was sent.
  * There is a size cap, and it is enforced WHILE reading — see ``read_capped``.
    It used to be enforced only after ``await file.read()`` had already returned
    the whole body as one ``bytes``, which is the one thing a size cap exists to
    prevent: any authenticated user could make core allocate as much RAM as they
    were willing to upload, and the 413 arrived after the damage.

SVG is accepted because logos are SVG, and it is XML that can carry script. That is
handled on the SERVING side (core/storage.py): non-raster types go out as
``Content-Disposition: attachment``, so a direct navigation downloads rather than
renders, while ``<img src>`` still displays it — and script in an SVG loaded as an
image does not execute.
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

#: How much is pulled off the upload per step. 64 KiB is a normal read size and it
#: bounds the overshoot: at the moment the cap trips, at most one chunk beyond the
#: limit has been handled, and that chunk is dropped rather than accumulated.
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

    Every route used to do ``data = await file.read()`` and hand the result to
    ``validate_image``, which then measured it. So the cap was consulted only after
    the entire body had been materialised as one ``bytes`` object: a caller who
    posted a 2 GiB "avatar" got their 413, and core got a 2 GiB allocation first.
    The cheapest denial of service in the service, available to any authenticated
    user on ``POST /auth/me/avatar``.

    Reading in chunks and raising as soon as the running total exceeds the limit
    means the process never holds more than ``limit + READ_CHUNK_BYTES``, whatever
    was sent.

    Deliberately NOT gated on ``Content-Length``. It is a client-supplied hint that
    can lie or be absent under chunked transfer encoding, so it could never be the
    only check — and here it would not even be an optimisation: FastAPI's multipart
    parser has already consumed the request body by the time a route body runs (it
    spools file parts over 1 MiB to a temp file, which is why the disk, not the
    heap, absorbed the request until this point). The streaming cap is what stands
    between an upload and core's memory, so it is the only check.
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

    It exists to reject a non-XML payload sent as image/svg+xml — an uploader that
    wanted to smuggle arbitrary bytes past the whitelist would otherwise pick SVG,
    because it is the only entry that cannot be sniffed.
    """
    head = data[:512].lstrip()[:512].lower()
    return head.startswith(b"<?xml") or head.startswith(b"<svg") or b"<svg" in head


def validate_image(data: bytes, content_type: str | None, *, field: str = "File") -> tuple[str, str]:
    """Check an uploaded image and return ``(content_type, extension)``.

    Raises ValidationError with the same status codes the sites route already used
    (415 for a bad type, 413 for a large one) so the three routes answer alike.
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
    # A backstop, not the enforcement point: by the time bytes are in hand the
    # allocation has happened. The routes use read_capped() so that never gets far.
    # This stays because it is free and it keeps validate_image correct on its own.
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
        # Deliberately does not name which check failed. The uploader learns the
        # file was rejected, not how the sniffing works.
        raise ValidationError(
            f"{field} is not a valid {ctype} image",
            code="UNSUPPORTED_MEDIA_TYPE",
            status_code=415,
        )
    return ctype, IMAGE_TYPES[ctype]
